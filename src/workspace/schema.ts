import fs from 'node:fs';
import path from 'node:path';

import { toPosix } from '../boundary/repository-root.ts';
import { excludedDirectory } from '../scan/exclusions.ts';
import type {
  SchemaColumn,
  SchemaConstraint,
  SchemaGap,
  SchemaIndex,
  SchemaLocation,
  SchemaSnapshot,
  SchemaTable,
  SqlDialect,
} from '../types.ts';

const MAX_BYTES = 4 * 1024 * 1024;

/** A SQL file as the extractor reads it: a repository-relative path and its text. */
export interface SqlSource {
  path: string;
  content: string;
}

/**
 * Read a repository's `.sql` files and replay them into one schema.
 *
 * Returns null when the repository has no SQL that creates a table, so a repository with
 * no database is absent from the report rather than shown empty.
 */
export function extractSchema(root: string, repository: string): SchemaSnapshot | null {
  const sources: SqlSource[] = [];
  for (const file of findSqlFiles(root)) {
    const content = readText(root, file);
    if (content !== null) {
      sources.push({ path: file, content });
    }
  }
  return buildSchema(repository, sources);
}

/** Find `.sql` files, pruning generated directories with the scanner's rules. */
export function findSqlFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      const relative = toPosix(path.relative(root, absolute));
      if (entry.isDirectory()) {
        if (!excludedDirectory(relative)) {
          walk(absolute);
        }
        continue;
      }
      if (path.extname(entry.name).toLowerCase() === '.sql') {
        found.push(relative);
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Replay SQL sources into a snapshot. Pure, so a revision read from git and a working tree
 * read from disk go through the same code.
 *
 * Schema dumps are applied first, then migrations in natural path order, then Flyway
 * repeatables. Undo scripts are skipped: they describe going back, not the current shape.
 */
export function buildSchema(repository: string, sources: SqlSource[]): SchemaSnapshot | null {
  const ordered = orderSources(sources);
  const builder = new SchemaBuilder();
  for (const source of ordered) {
    builder.apply(source);
  }
  const tables = builder.tables();
  if (tables.length === 0) {
    return null;
  }
  const migrations = ordered.some((source) => classify(source.path) === 'migration');
  const dialect = detectDialect(ordered);
  return {
    repository,
    origin: migrations ? 'migrations' : 'dump',
    ...(dialect ? { dialect } : {}),
    files: ordered.map((source) => source.path),
    tables,
    gaps: builder.gaps,
  };
}

/**
 * Judge the engine from syntax only the engine accepts. A script that uses none of it says
 * nothing, so the dialect is absent rather than guessed.
 */
function detectDialect(sources: SqlSource[]): SqlDialect | undefined {
  const votes: Record<SqlDialect, number> = { postgres: 0, mysql: 0, sqlite: 0 };
  for (const source of sources) {
    const text = source.content;
    votes.mysql += Number(/\bAUTO_INCREMENT\b|\bENGINE\s*=|`[A-Za-z_]\w*`|\bUNSIGNED\b|\bCHARSET\b/i.test(text));
    votes.sqlite += Number(/\bAUTOINCREMENT\b|\bPRAGMA\b|\bWITHOUT\s+ROWID\b/i.test(text));
    votes.postgres += Number(
      /\bSERIAL\b|\bBIGSERIAL\b|\bJSONB\b|::\s*\w+|\bTIMESTAMPTZ\b|\bCREATE\s+EXTENSION\b|\$\$|\bGENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b|\bCONCURRENTLY\b/i.test(text),
    );
  }
  const ranked = (Object.entries(votes) as Array<[SqlDialect, number]>).sort((a, b) => b[1] - a[1]);
  const [top, runnerUp] = ranked;
  return top && top[1] > 0 && top[1] > (runnerUp?.[1] ?? 0) ? top[0] : undefined;
}

type SourceKind = 'dump' | 'migration' | 'repeatable' | 'undo';

function classify(file: string): SourceKind {
  const base = path.posix.basename(file).toLowerCase();
  const directories = file.toLowerCase().split('/').slice(0, -1);
  if (
    /\.down\.sql$/.test(base) ||
    /[._-]down\.sql$/.test(base) ||
    /^down\.sql$/.test(base) ||
    /^u\d[\w.]*__/.test(base) ||
    directories.includes('down') ||
    directories.includes('rollback')
  ) {
    return 'undo';
  }
  if (/^r__/.test(base)) {
    return 'repeatable';
  }
  if (/^(?:schema|structure)\.sql$/.test(base) || /(?:^|[._-])dump\.sql$/.test(base)) {
    return 'dump';
  }
  return 'migration';
}

const RANK: Record<SourceKind, number> = { dump: 0, migration: 1, repeatable: 2, undo: 3 };

function orderSources(sources: SqlSource[]): SqlSource[] {
  return sources
    .filter((source) => classify(source.path) !== 'undo')
    .sort(
      (a, b) =>
        RANK[classify(a.path)] - RANK[classify(b.path)] ||
        a.path.localeCompare(b.path, 'en', { numeric: true }),
    );
}

// ---------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------

interface Token {
  kind: 'word' | 'id' | 'str' | 'num' | 'punct';
  /** The token as written, without quoting for identifiers. */
  text: string;
  /** Upper-cased text for a bare word, otherwise empty, so a quoted name never matches a keyword. */
  upper: string;
  start: number;
  end: number;
  line: number;
}

interface Statement {
  tokens: Token[];
  line: number;
}

const BATCH_SEPARATOR = /^\s*GO(?:\s+\d+)?\s*;?\s*$/i;
const CLIENT_DIRECTIVE = /^\s*\\[A-Za-z]/;

/** Tokenize a SQL script and split it into statements at top-level semicolons. */
function tokenize(content: string): Statement[] {
  const text = content
    .split(/\r?\n/)
    .map((line) => {
      if (BATCH_SEPARATOR.test(line)) {
        // `GO` ends a T-SQL batch without a semicolon; keep the offsets and end the statement.
        return `;${' '.repeat(Math.max(line.length - 1, 0))}`;
      }
      return CLIENT_DIRECTIVE.test(line) ? ' '.repeat(line.length) : line;
    })
    .join('\n');

  const statements: Statement[] = [];
  let tokens: Token[] = [];
  let line = 1;
  let index = 0;

  const push = (token: Omit<Token, 'line'>): void => {
    tokens.push({ ...token, line });
  };
  const flush = (): void => {
    if (tokens.length > 0) {
      statements.push({ tokens, line: tokens[0]?.line ?? 1 });
      tokens = [];
    }
  };

  while (index < text.length) {
    const character = text[index] as string;
    const next = text[index + 1];

    if (character === '\n') {
      line += 1;
      index += 1;
    } else if (/\s/.test(character)) {
      index += 1;
    } else if (character === '-' && next === '-') {
      while (index < text.length && text[index] !== '\n') {
        index += 1;
      }
    } else if (character === '/' && next === '*') {
      const close = text.indexOf('*/', index + 2);
      const stop = close === -1 ? text.length : close + 2;
      line += countNewlines(text, index, stop);
      index = stop;
    } else if (character === "'") {
      const stop = endOfQuoted(text, index, "'");
      push({ kind: 'str', text: text.slice(index + 1, stop - 1), upper: '', start: index, end: stop });
      line += countNewlines(text, index, stop);
      index = stop;
    } else if (character === '"' || character === '`') {
      const stop = endOfQuoted(text, index, character);
      const inner = text.slice(index + 1, stop - 1).replaceAll(character + character, character);
      push({ kind: 'id', text: inner, upper: '', start: index, end: stop });
      line += countNewlines(text, index, stop);
      index = stop;
    } else if (character === '[' && /^\[[^\][\n\d][^\][\n]*\]/.test(text.slice(index, index + 130))) {
      const stop = text.indexOf(']', index) + 1;
      push({ kind: 'id', text: text.slice(index + 1, stop - 1), upper: '', start: index, end: stop });
      index = stop;
    } else if (character === '$' && /^\$(?:[A-Za-z_]\w*)?\$/.test(text.slice(index, index + 64))) {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(text.slice(index, index + 64))?.[0] as string;
      const close = text.indexOf(tag, index + tag.length);
      const stop = close === -1 ? text.length : close + tag.length;
      push({ kind: 'str', text: '', upper: '', start: index, end: stop });
      line += countNewlines(text, index, stop);
      index = stop;
    } else if (/[A-Za-z_]/.test(character)) {
      let stop = index + 1;
      while (stop < text.length && /[\w$]/.test(text[stop] as string)) {
        stop += 1;
      }
      const word = text.slice(index, stop);
      push({ kind: 'word', text: word, upper: word.toUpperCase(), start: index, end: stop });
      index = stop;
    } else if (/\d/.test(character)) {
      let stop = index + 1;
      while (stop < text.length && /[\d.]/.test(text[stop] as string)) {
        stop += 1;
      }
      push({ kind: 'num', text: text.slice(index, stop), upper: '', start: index, end: stop });
      index = stop;
    } else if (character === ';') {
      index += 1;
      flush();
    } else if (character === ':' && next === ':') {
      push({ kind: 'punct', text: '::', upper: '', start: index, end: index + 2 });
      index += 2;
    } else {
      push({ kind: 'punct', text: character, upper: '', start: index, end: index + 1 });
      index += 1;
    }
  }
  flush();
  return statements;
}

function endOfQuoted(text: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === quote) {
      if (text[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0;
  for (let index = from; index < to; index += 1) {
    if (text[index] === '\n') {
      count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------------------
// Token cursor
// ---------------------------------------------------------------------------------------

class Cursor {
  pos = 0;
  readonly tokens: Token[];
  readonly source: string;

  constructor(tokens: Token[], source: string) {
    this.tokens = tokens;
    this.source = source;
  }

  get done(): boolean {
    return this.pos >= this.tokens.length;
  }

  peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  next(): Token | undefined {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  /** True when the next tokens are these bare words, in order. */
  isWords(...words: string[]): boolean {
    return words.every((word, offset) => this.peek(offset)?.upper === word);
  }

  eatWords(...words: string[]): boolean {
    if (this.isWords(...words)) {
      this.pos += words.length;
      return true;
    }
    return false;
  }

  isPunct(text: string): boolean {
    const token = this.peek();
    return token?.kind === 'punct' && token.text === text;
  }

  /** The text between two tokens, as written. */
  slice(tokens: Token[]): string {
    const first = tokens[0];
    const last = tokens[tokens.length - 1];
    return first && last ? this.source.slice(first.start, last.end).replace(/\s+/g, ' ').trim() : '';
  }
}

/** A `(` ... `)` group at the cursor: its inner tokens, with the cursor left after the `)`. */
function readGroup(cursor: Cursor): Token[] | null {
  if (!cursor.isPunct('(')) {
    return null;
  }
  cursor.next();
  const inner: Token[] = [];
  let depth = 1;
  while (!cursor.done) {
    const token = cursor.next() as Token;
    if (token.kind === 'punct' && token.text === '(') {
      depth += 1;
    } else if (token.kind === 'punct' && token.text === ')') {
      depth -= 1;
      if (depth === 0) {
        return inner;
      }
    }
    inner.push(token);
  }
  return inner;
}

/** Split tokens at commas that are not inside parentheses. */
function splitTopLevel(tokens: Token[]): Token[][] {
  const parts: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === 'punct') {
      if (token.text === '(') {
        depth += 1;
      } else if (token.text === ')') {
        depth -= 1;
      } else if (token.text === ',' && depth === 0) {
        parts.push(current);
        current = [];
        continue;
      }
    }
    current.push(token);
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}

/** Schemas whose tables are addressed without the prefix. */
const DEFAULT_SCHEMAS = new Set(['public', 'dbo']);

/** A possibly qualified name, lower-cased and without the default schema or database prefix. */
function readName(cursor: Cursor): string | null {
  const parts: string[] = [];
  for (;;) {
    const token = cursor.peek();
    if (!token || (token.kind !== 'word' && token.kind !== 'id')) {
      break;
    }
    cursor.next();
    parts.push(token.text.toLowerCase());
    if (cursor.isPunct('.') && (cursor.peek(1)?.kind === 'word' || cursor.peek(1)?.kind === 'id')) {
      cursor.next();
      continue;
    }
    break;
  }
  if (parts.length === 0) {
    return null;
  }
  const schemaAndName = parts.slice(-2);
  if (schemaAndName.length === 2 && DEFAULT_SCHEMAS.has(schemaAndName[0] as string)) {
    return schemaAndName[1] as string;
  }
  return schemaAndName.join('.');
}

// ---------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------

const INTEGER_ALIASES: Record<string, string> = {
  int: 'integer',
  int4: 'integer',
  integer: 'integer',
  mediumint: 'integer',
  int8: 'bigint',
  bigint: 'bigint',
  int2: 'smallint',
  smallint: 'smallint',
  tinyint: 'tinyint',
  serial: 'integer',
  serial4: 'integer',
  bigserial: 'bigint',
  serial8: 'bigint',
  smallserial: 'smallint',
  serial2: 'smallint',
};

const SERIAL_TYPES = new Set(['serial', 'serial4', 'bigserial', 'serial8', 'smallserial', 'serial2']);

/** One spelling per type, so the same column compares equal across dialects and migrations. */
export function normalizeType(raw: string): string {
  const compact = raw
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s*\)/g, ')')
    .replace(/\s*\[\s*\]/g, '[]')
    .trim();
  if (compact === '') {
    return 'unknown';
  }
  const match = /^([a-z_][a-z0-9_ ]*?)(\([^)]*\))?(\[\])*( unsigned)?( zerofill)?$/.exec(compact);
  const base = (match?.[1] ?? compact).trim();
  const modifier = match?.[2] ?? '';
  const array = compact.includes('[]') ? '[]' : '';
  const unsigned = match?.[4] ?? '';

  const integer = INTEGER_ALIASES[base];
  if (integer) {
    // A MySQL display width (`int(11)`) is presentation, not a range.
    const width = integer === 'tinyint' && modifier === '(1)' ? '(1)' : '';
    return `${integer}${width}${unsigned}${array}`;
  }
  switch (base) {
    case 'character varying':
    case 'varchar':
    case 'nvarchar':
      return `varchar${modifier}${array}`;
    case 'character':
    case 'char':
    case 'nchar':
      return `char${modifier}${array}`;
    case 'bool':
    case 'boolean':
      return `boolean${array}`;
    case 'float8':
    case 'double precision':
    case 'double':
      return `double${array}`;
    case 'float4':
    case 'real':
      return `real${array}`;
    case 'decimal':
    case 'numeric':
      return `numeric${modifier}${array}`;
    case 'timestamp without time zone':
    case 'timestamp':
      return `timestamp${array}`;
    case 'timestamp with time zone':
    case 'timestamptz':
      return `timestamptz${array}`;
    case 'time without time zone':
    case 'time':
      return `time${array}`;
    case 'time with time zone':
    case 'timetz':
      return `timetz${array}`;
    default:
      return `${base}${modifier}${array}${unsigned}`;
  }
}

// ---------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------

/** Words that end a column's type and start one of its clauses. */
const COLUMN_CLAUSE_START = new Set([
  'NOT',
  'NULL',
  'DEFAULT',
  'PRIMARY',
  'UNIQUE',
  'REFERENCES',
  'CHECK',
  'CONSTRAINT',
  'GENERATED',
  'COLLATE',
  'AUTO_INCREMENT',
  'AUTOINCREMENT',
  'IDENTITY',
  'COMMENT',
  'ON',
  'AS',
  'CHARSET',
]);

/** Words that end a DEFAULT expression. `NULL` is not here: `DEFAULT NULL` is the value. */
const DEFAULT_STOP = new Set([
  'NOT',
  'PRIMARY',
  'UNIQUE',
  'REFERENCES',
  'CHECK',
  'CONSTRAINT',
  'GENERATED',
  'COLLATE',
  'AUTO_INCREMENT',
  'AUTOINCREMENT',
  'COMMENT',
  'ON',
  'NULL',
]);

/** ALTER TABLE actions that change nothing the snapshot records. */
const HARMLESS_ACTIONS = new Set([
  'OWNER',
  'ENABLE',
  'DISABLE',
  'FORCE',
  'NO',
  'VALIDATE',
  'CLUSTER',
  'REPLICA',
  'SET',
  'RESET',
  'ATTACH',
  'DETACH',
  'INHERIT',
  'ENGINE',
  'AUTO_INCREMENT',
  'COMMENT',
  'CHARACTER',
  'DEFAULT',
  'CONVERT',
]);

interface ParsedColumn {
  column: SchemaColumn;
  constraints: SchemaConstraint[];
}

class SchemaBuilder {
  readonly gaps: SchemaGap[] = [];
  private readonly byName = new Map<string, SchemaTable>();
  private file = '';

  tables(): SchemaTable[] {
    return [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  apply(source: SqlSource): void {
    this.file = source.path;
    for (const statement of tokenize(source.content)) {
      const cursor = new Cursor(statement.tokens, source.content);
      try {
        this.statement(cursor, statement);
      } catch {
        this.gap(statement, 'the statement could not be read');
      }
    }
  }

  private location(line: number): SchemaLocation {
    return { file: this.file, line };
  }

  private gap(statement: Statement, reason: string): void {
    const head = statement.tokens
      .slice(0, 4)
      .map((token) => token.text)
      .join(' ');
    this.gaps.push({ file: this.file, line: statement.line, statement: head, reason });
  }

  private statement(cursor: Cursor, statement: Statement): void {
    const first = cursor.peek()?.upper;
    if (first === 'CREATE') {
      cursor.next();
      this.create(cursor, statement);
    } else if (first === 'ALTER' && cursor.peek(1)?.upper === 'TABLE') {
      cursor.pos = 2;
      this.alter(cursor, statement);
    } else if (first === 'DROP') {
      cursor.next();
      this.drop(cursor, statement);
    } else if (first === 'RENAME' && cursor.peek(1)?.upper === 'TABLE') {
      cursor.pos = 2;
      this.renameTables(cursor);
    }
  }

  // ---- CREATE ----

  private create(cursor: Cursor, statement: Statement): void {
    cursor.eatWords('OR', 'REPLACE');
    const unique = cursor.eatWords('UNIQUE');
    while (cursor.peek()?.upper && ['GLOBAL', 'LOCAL', 'UNLOGGED', 'VIRTUAL'].includes(cursor.peek()?.upper as string)) {
      cursor.next();
    }
    if (cursor.isWords('TEMP') || cursor.isWords('TEMPORARY')) {
      return; // Session-local tables are not part of the schema.
    }
    if (cursor.eatWords('TABLE')) {
      this.createTable(cursor, statement);
    } else if (cursor.eatWords('INDEX')) {
      this.createIndex(cursor, statement, unique);
    }
  }

  private createTable(cursor: Cursor, statement: Statement): void {
    const ifNotExists = cursor.eatWords('IF', 'NOT', 'EXISTS');
    const name = readName(cursor);
    if (!name) {
      return;
    }
    if (ifNotExists && this.byName.has(name)) {
      return;
    }
    const table: SchemaTable = {
      name,
      columns: [],
      constraints: [],
      indexes: [],
      declared: this.location(statement.line),
    };

    const body = readGroup(cursor);
    if (!body) {
      this.byName.set(name, table);
      this.gap(statement, cursor.isWords('AS') ? 'the columns come from a query' : 'the table body is not a column list');
      return;
    }
    for (const item of splitTopLevel(body)) {
      this.tableItem(table, item, cursor.source, item[0]?.line ?? statement.line);
    }
    this.byName.set(name, table);
  }

  private tableItem(table: SchemaTable, tokens: Token[], source: string, line: number): void {
    if (tokens.length === 0) {
      return;
    }
    const cursor = new Cursor(tokens, source);
    const constraint = this.readTableConstraint(cursor, line, table);
    if (constraint === 'handled') {
      return;
    }
    if (constraint === 'unsupported') {
      this.gaps.push({
        file: this.file,
        line,
        statement: `CREATE TABLE ${table.name}`,
        reason: `a table-level ${tokens[0]?.text ?? ''} clause is not recorded`,
      });
      return;
    }
    const parsed = parseColumn(new Cursor(tokens, source), this.location(line));
    if (parsed) {
      this.addColumn(table, parsed);
    }
  }

  /**
   * Read a table-level constraint or index clause. `handled` means it was recorded,
   * `unsupported` that it is a constraint kind the snapshot does not record, and `none`
   * that the item is a column definition.
   */
  private readTableConstraint(
    cursor: Cursor,
    line: number,
    table: SchemaTable,
  ): 'handled' | 'unsupported' | 'none' {
    const declared = this.location(line);
    let name: string | undefined;
    if (cursor.eatWords('CONSTRAINT')) {
      name = readName(cursor) ?? undefined;
    }
    const withName = (value: SchemaConstraint): SchemaConstraint => (name ? { ...value, name } : value);

    if (cursor.eatWords('PRIMARY', 'KEY')) {
      const columns = readColumnList(cursor);
      this.addConstraint(table, withName({ kind: 'primary-key', columns, declared }));
      return 'handled';
    }
    if (cursor.isWords('UNIQUE')) {
      cursor.next();
      if (cursor.peek()?.upper === 'KEY' || cursor.peek()?.upper === 'INDEX') {
        cursor.next();
      }
      if (!cursor.isPunct('(') && !name) {
        name = readName(cursor) ?? undefined;
      }
      const columns = readColumnList(cursor);
      this.addConstraint(table, withName({ kind: 'unique', columns, declared }));
      return 'handled';
    }
    if (cursor.eatWords('FOREIGN', 'KEY')) {
      if (!cursor.isPunct('(') && !name) {
        name = readName(cursor) ?? undefined;
      }
      const columns = readColumnList(cursor);
      cursor.eatWords('REFERENCES');
      const references = readReference(cursor);
      if (references) {
        this.addConstraint(table, withName({ kind: 'foreign-key', columns, references, declared }));
      }
      return 'handled';
    }
    if (cursor.eatWords('CHECK')) {
      const group = readGroup(cursor);
      if (group) {
        this.addConstraint(
          table,
          withName({ kind: 'check', columns: [], expression: cursor.slice(group), declared }),
        );
      }
      return 'handled';
    }
    if (name) {
      return 'unsupported'; // A named constraint of a kind we do not read (EXCLUDE ...).
    }
    const first = cursor.peek()?.upper;
    if (first === 'KEY' || first === 'INDEX') {
      cursor.next();
      const indexName = cursor.isPunct('(') ? undefined : (readName(cursor) ?? undefined);
      const columns = readColumnList(cursor);
      table.indexes.push({ ...(indexName ? { name: indexName } : {}), columns, unique: false, declared });
      return 'handled';
    }
    if (first === 'FULLTEXT' || first === 'SPATIAL') {
      return 'handled';
    }
    if (first === 'EXCLUDE' || first === 'LIKE' || first === 'PERIOD') {
      return 'unsupported';
    }
    return 'none';
  }

  private addColumn(table: SchemaTable, parsed: ParsedColumn): void {
    const existing = table.columns.findIndex((column) => column.name === parsed.column.name);
    if (existing === -1) {
      table.columns.push(parsed.column);
    } else {
      table.columns[existing] = parsed.column;
    }
    for (const constraint of parsed.constraints) {
      this.addConstraint(table, constraint);
    }
  }

  private addConstraint(table: SchemaTable, constraint: SchemaConstraint): void {
    const signature = constraintSignature(constraint);
    table.constraints = table.constraints.filter((entry) => constraintSignature(entry) !== signature);
    table.constraints.push(constraint);
    if (constraint.kind === 'primary-key') {
      for (const column of table.columns) {
        if (constraint.columns.includes(column.name)) {
          column.nullable = false;
        }
      }
    }
  }

  private createIndex(cursor: Cursor, statement: Statement, unique: boolean): void {
    cursor.eatWords('CONCURRENTLY');
    cursor.eatWords('IF', 'NOT', 'EXISTS');
    const name = cursor.isWords('ON') ? undefined : (readName(cursor) ?? undefined);
    if (!cursor.eatWords('ON')) {
      return;
    }
    cursor.eatWords('ONLY');
    const tableName = readName(cursor);
    const table = tableName ? this.byName.get(tableName) : undefined;
    if (!tableName || !table) {
      this.gap(statement, `the index is on ${tableName ?? 'a table'} that no earlier file creates`);
      return;
    }
    if (cursor.eatWords('USING')) {
      cursor.next();
    }
    const columns = readColumnList(cursor);
    let where: string | undefined;
    while (!cursor.done) {
      if (cursor.eatWords('WHERE')) {
        where = cursor.slice(cursor.tokens.slice(cursor.pos));
        break;
      }
      cursor.next();
    }
    const index: SchemaIndex = {
      ...(name ? { name } : {}),
      columns,
      unique,
      ...(where ? { where } : {}),
      declared: this.location(statement.line),
    };
    table.indexes = table.indexes.filter((entry) => !(name && entry.name === name));
    table.indexes.push(index);
  }

  // ---- ALTER ----

  private alter(cursor: Cursor, statement: Statement): void {
    cursor.eatWords('IF', 'EXISTS');
    cursor.eatWords('ONLY');
    const name = readName(cursor);
    const table = name ? this.byName.get(name) : undefined;
    if (!name || !table) {
      this.gap(statement, `the table ${name ?? ''} is not created by an earlier file`.replace('  ', ' '));
      return;
    }
    const actions = splitTopLevel(cursor.tokens.slice(cursor.pos));
    for (const action of actions) {
      const inner = new Cursor(action, cursor.source);
      const line = action[0]?.line ?? statement.line;
      if (!this.alterAction(table, inner, line)) {
        this.gaps.push({
          file: this.file,
          line,
          statement: `ALTER TABLE ${table.name}`,
          reason: `the action "${action
            .slice(0, 3)
            .map((token) => token.text)
            .join(' ')}" is not recorded`,
        });
      }
    }
  }

  /** Apply one ALTER TABLE action. False when it is a kind the snapshot does not read. */
  private alterAction(table: SchemaTable, cursor: Cursor, line: number): boolean {
    const verb = cursor.peek()?.upper ?? '';
    const declared = this.location(line);

    if (verb === 'ADD') {
      cursor.next();
      const mark = cursor.pos;
      const kind = this.readTableConstraint(cursor, line, table);
      if (kind === 'handled') {
        return true;
      }
      if (kind === 'unsupported') {
        return false;
      }
      cursor.pos = mark;
      cursor.eatWords('COLUMN');
      cursor.eatWords('IF', 'NOT', 'EXISTS');
      const parsed = parseColumn(cursor, declared);
      if (!parsed) {
        return false;
      }
      this.addColumn(table, parsed);
      return true;
    }

    if (verb === 'DROP') {
      cursor.next();
      return this.alterDrop(table, cursor);
    }

    if (verb === 'ALTER') {
      cursor.next();
      cursor.eatWords('COLUMN');
      const name = readName(cursor);
      const column = table.columns.find((entry) => entry.name === name);
      if (!column) {
        return name !== null;
      }
      if (cursor.eatWords('SET', 'NOT', 'NULL')) {
        column.nullable = false;
      } else if (cursor.eatWords('DROP', 'NOT', 'NULL')) {
        column.nullable = true;
      } else if (cursor.eatWords('SET', 'DEFAULT')) {
        column.default = cursor.slice(cursor.tokens.slice(cursor.pos));
      } else if (cursor.eatWords('DROP', 'DEFAULT')) {
        delete column.default;
      } else if (cursor.eatWords('SET', 'DATA', 'TYPE') || cursor.eatWords('TYPE')) {
        const typeTokens: Token[] = [];
        while (!cursor.done && cursor.peek()?.upper !== 'USING' && cursor.peek()?.upper !== 'COLLATE') {
          typeTokens.push(cursor.next() as Token);
        }
        column.type = normalizeType(cursor.slice(typeTokens));
        column.declared = declared;
      } else {
        return false;
      }
      return true;
    }

    if (verb === 'RENAME') {
      cursor.next();
      if (cursor.eatWords('TO') || cursor.eatWords('AS')) {
        const to = readName(cursor);
        if (to) {
          this.renameTable(table.name, to);
        }
        return true;
      }
      if (cursor.eatWords('CONSTRAINT') || cursor.eatWords('INDEX')) {
        return true; // A rename of a name only; signatures do not carry it.
      }
      cursor.eatWords('COLUMN');
      const from = readName(cursor);
      if (!from || !cursor.eatWords('TO')) {
        return false;
      }
      const to = readName(cursor);
      if (to) {
        this.renameColumn(table, from, to);
      }
      return true;
    }

    if (verb === 'MODIFY' || verb === 'CHANGE') {
      cursor.next();
      cursor.eatWords('COLUMN');
      let previous: string | null = null;
      if (verb === 'CHANGE') {
        previous = readName(cursor);
      }
      const parsed = parseColumn(cursor, declared);
      if (!parsed) {
        return false;
      }
      if (previous && previous !== parsed.column.name) {
        this.renameColumn(table, previous, parsed.column.name);
      }
      this.addColumn(table, parsed);
      return true;
    }

    return HARMLESS_ACTIONS.has(verb);
  }

  private alterDrop(table: SchemaTable, cursor: Cursor): boolean {
    if (cursor.eatWords('CONSTRAINT') || cursor.isWords('FOREIGN', 'KEY') || cursor.isWords('PRIMARY', 'KEY') || cursor.isWords('INDEX') || cursor.isWords('KEY')) {
      if (cursor.eatWords('PRIMARY', 'KEY')) {
        table.constraints = table.constraints.filter((entry) => entry.kind !== 'primary-key');
        return true;
      }
      cursor.eatWords('FOREIGN', 'KEY');
      cursor.eatWords('INDEX');
      cursor.eatWords('KEY');
      cursor.eatWords('IF', 'EXISTS');
      const name = readName(cursor);
      if (name) {
        table.constraints = table.constraints.filter((entry) => entry.name !== name);
        table.indexes = table.indexes.filter((entry) => entry.name !== name);
      }
      return true;
    }
    cursor.eatWords('COLUMN');
    cursor.eatWords('IF', 'EXISTS');
    const name = readName(cursor);
    if (!name) {
      return false;
    }
    table.columns = table.columns.filter((column) => column.name !== name);
    table.constraints = table.constraints.filter((entry) => !entry.columns.includes(name));
    table.indexes = table.indexes.filter((entry) => !entry.columns.includes(name));
    return true;
  }

  private renameColumn(table: SchemaTable, from: string, to: string): void {
    const rename = (columns: string[]): string[] => columns.map((column) => (column === from ? to : column));
    for (const column of table.columns) {
      if (column.name === from) {
        column.name = to;
      }
    }
    for (const constraint of table.constraints) {
      constraint.columns = rename(constraint.columns);
    }
    for (const index of table.indexes) {
      index.columns = rename(index.columns);
    }
    for (const other of this.byName.values()) {
      for (const constraint of other.constraints) {
        if (constraint.references?.table === table.name) {
          constraint.references.columns = rename(constraint.references.columns);
        }
      }
    }
  }

  // ---- DROP / RENAME TABLE ----

  private drop(cursor: Cursor, statement: Statement): void {
    if (cursor.eatWords('TABLE')) {
      cursor.eatWords('IF', 'EXISTS');
      const cascade = statement.tokens.some((token) => token.upper === 'CASCADE');
      for (;;) {
        const name = readName(cursor);
        if (!name) {
          break;
        }
        this.byName.delete(name);
        if (cascade) {
          for (const other of this.byName.values()) {
            other.constraints = other.constraints.filter((entry) => entry.references?.table !== name);
          }
        }
        if (!cursor.isPunct(',')) {
          break;
        }
        cursor.next();
      }
    } else if (cursor.eatWords('INDEX')) {
      cursor.eatWords('CONCURRENTLY');
      cursor.eatWords('IF', 'EXISTS');
      const name = readName(cursor);
      if (!name) {
        return;
      }
      const tableName = cursor.eatWords('ON') ? readName(cursor) : null;
      for (const table of this.byName.values()) {
        if (tableName && table.name !== tableName) {
          continue;
        }
        table.indexes = table.indexes.filter((entry) => entry.name !== name);
      }
    }
  }

  private renameTables(cursor: Cursor): void {
    for (;;) {
      const from = readName(cursor);
      if (!from || !cursor.eatWords('TO')) {
        return;
      }
      const to = readName(cursor);
      if (to) {
        this.renameTable(from, to);
      }
      if (!cursor.isPunct(',')) {
        return;
      }
      cursor.next();
    }
  }

  private renameTable(from: string, to: string): void {
    const table = this.byName.get(from);
    if (!table || from === to) {
      return;
    }
    this.byName.delete(from);
    table.name = to;
    this.byName.set(to, table);
    for (const other of this.byName.values()) {
      for (const constraint of other.constraints) {
        if (constraint.references?.table === from) {
          constraint.references.table = to;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------
// Column and reference parsing
// ---------------------------------------------------------------------------------------

/** The columns in a `( ... )` list; an expression is kept as written. */
function readColumnList(cursor: Cursor): string[] {
  const group = readGroup(cursor);
  if (!group) {
    return [];
  }
  return splitTopLevel(group)
    .map((part) => {
      const trimmed = [...part];
      while (trimmed.length > 1 && ['ASC', 'DESC', 'FIRST', 'LAST', 'NULLS'].includes(trimmed[trimmed.length - 1]?.upper ?? '')) {
        trimmed.pop();
      }
      const only = trimmed[0];
      const prefixLength = trimmed.length === 4 && trimmed[1]?.text === '(' && trimmed[2]?.kind === 'num';
      if (only && (only.kind === 'word' || only.kind === 'id') && (trimmed.length === 1 || prefixLength)) {
        // `name` or `name(10)` (a MySQL prefix length); `lower(name)` is an expression.
        return only.text.toLowerCase();
      }
      return cursor.slice(trimmed).toLowerCase();
    })
    .filter((name) => name !== '');
}

function readReference(cursor: Cursor): SchemaConstraint['references'] | null {
  const table = readName(cursor);
  if (!table) {
    return null;
  }
  const columns = readColumnList(cursor);
  const references: NonNullable<SchemaConstraint['references']> = { table, columns };
  for (;;) {
    if (cursor.eatWords('ON', 'DELETE')) {
      references.onDelete = readAction(cursor);
    } else if (cursor.eatWords('ON', 'UPDATE')) {
      references.onUpdate = readAction(cursor);
    } else if (cursor.eatWords('MATCH')) {
      cursor.next();
    } else if (cursor.eatWords('NOT', 'DEFERRABLE') || cursor.eatWords('DEFERRABLE')) {
      continue;
    } else if (cursor.eatWords('INITIALLY')) {
      cursor.next();
    } else {
      break;
    }
  }
  return references;
}

function readAction(cursor: Cursor): string {
  const first = cursor.next()?.upper ?? '';
  if (first === 'SET' || first === 'NO') {
    return `${first} ${cursor.next()?.upper ?? ''}`.trim().toLowerCase();
  }
  return first.toLowerCase();
}

function parseColumn(cursor: Cursor, declared: SchemaLocation): ParsedColumn | null {
  const nameToken = cursor.next();
  if (!nameToken || (nameToken.kind !== 'word' && nameToken.kind !== 'id')) {
    return null;
  }
  const name = nameToken.text.toLowerCase();

  const typeTokens: Token[] = [];
  let depth = 0;
  while (!cursor.done) {
    const token = cursor.peek() as Token;
    if (token.kind === 'punct' && token.text === '(') {
      depth += 1;
    } else if (token.kind === 'punct' && token.text === ')') {
      depth -= 1;
    } else if (depth === 0 && token.kind === 'word' && COLUMN_CLAUSE_START.has(token.upper)) {
      break;
    } else if (depth === 0 && token.upper === 'CHARACTER' && cursor.peek(1)?.upper === 'SET') {
      break;
    }
    typeTokens.push(token);
    cursor.next();
  }
  const rawType = cursor.slice(typeTokens);
  const baseWord = typeTokens[0]?.upper.toLowerCase() ?? '';

  const column: SchemaColumn = {
    name,
    type: normalizeType(rawType),
    nullable: true,
    declared,
  };
  const constraints: SchemaConstraint[] = [];
  if (SERIAL_TYPES.has(baseWord)) {
    column.nullable = false;
    column.default = 'serial';
  }

  let pendingName: string | undefined;
  while (!cursor.done) {
    const token = cursor.next() as Token;
    if (token.kind !== 'word') {
      continue;
    }
    const named = <T extends object>(value: T): T => {
      const result = pendingName ? { ...value, name: pendingName } : value;
      pendingName = undefined;
      return result;
    };
    switch (token.upper) {
      case 'CONSTRAINT':
        pendingName = readName(cursor) ?? undefined;
        break;
      case 'NOT':
        if (cursor.eatWords('NULL')) {
          column.nullable = false;
        }
        break;
      case 'NULL':
        column.nullable = true;
        break;
      case 'DEFAULT': {
        const expression = readDefault(cursor);
        if (expression) {
          column.default = expression;
        }
        break;
      }
      case 'PRIMARY':
        cursor.eatWords('KEY');
        column.nullable = false;
        constraints.push(named({ kind: 'primary-key' as const, columns: [name], declared }));
        break;
      case 'UNIQUE':
        cursor.eatWords('KEY');
        constraints.push(named({ kind: 'unique' as const, columns: [name], declared }));
        break;
      case 'REFERENCES': {
        const references = readReference(cursor);
        if (references) {
          constraints.push(named({ kind: 'foreign-key' as const, columns: [name], references, declared }));
        }
        break;
      }
      case 'CHECK': {
        const group = readGroup(cursor);
        if (group) {
          constraints.push(
            named({ kind: 'check' as const, columns: [name], expression: cursor.slice(group), declared }),
          );
        }
        break;
      }
      case 'GENERATED':
        if (cursor.isWords('ALWAYS', 'AS', 'IDENTITY') || cursor.isWords('BY', 'DEFAULT', 'AS', 'IDENTITY')) {
          column.nullable = false;
          column.default = 'identity';
        } else {
          column.default = 'generated';
        }
        skipGroups(cursor);
        break;
      case 'AS':
        column.default = 'generated';
        readGroup(cursor);
        break;
      case 'AUTO_INCREMENT':
      case 'AUTOINCREMENT':
        column.default = 'auto-increment';
        break;
      case 'IDENTITY':
        column.default = 'auto-increment';
        column.nullable = false;
        readGroup(cursor);
        break;
      default:
        break;
    }
  }
  return { column, constraints };
}

/** Skip the words and groups that follow GENERATED up to the next clause. */
function skipGroups(cursor: Cursor): void {
  while (!cursor.done) {
    const token = cursor.peek() as Token;
    if (token.kind === 'punct' && token.text === '(') {
      readGroup(cursor);
    } else if (token.kind === 'word' && ['ALWAYS', 'BY', 'DEFAULT', 'AS', 'IDENTITY', 'STORED', 'VIRTUAL'].includes(token.upper)) {
      cursor.next();
    } else {
      return;
    }
  }
}

function readDefault(cursor: Cursor): string | null {
  const tokens: Token[] = [];
  let depth = 0;
  while (!cursor.done) {
    const token = cursor.peek() as Token;
    if (token.kind === 'punct' && token.text === '(') {
      depth += 1;
    } else if (token.kind === 'punct' && token.text === ')') {
      depth -= 1;
    } else if (depth === 0 && tokens.length > 0 && token.kind === 'word' && DEFAULT_STOP.has(token.upper)) {
      break;
    }
    tokens.push(token);
    cursor.next();
  }
  return tokens.length > 0 ? cursor.slice(tokens) : null;
}

/** What identifies a constraint for replacement and comparison, ignoring its name. */
export function constraintSignature(constraint: SchemaConstraint): string {
  const columns = constraint.columns.join(',');
  switch (constraint.kind) {
    case 'foreign-key':
      return `fk:${columns}->${constraint.references?.table ?? ''}(${constraint.references?.columns.join(',') ?? ''})`;
    case 'check':
      return `check:${(constraint.expression ?? '').replace(/\s+/g, '').toLowerCase()}`;
    default:
      return `${constraint.kind}:${columns}`;
  }
}

function readText(root: string, file: string): string | null {
  try {
    const absolute = path.join(root, file);
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_BYTES) {
      return null;
    }
    const content = fs.readFileSync(absolute);
    return content.includes(0) ? null : content.toString('utf8');
  } catch {
    return null;
  }
}
