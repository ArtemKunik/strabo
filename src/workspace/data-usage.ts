import fs from 'node:fs';
import path from 'node:path';

import type { CodeDataUse } from '../types.ts';
import { findSourceFiles } from './dto.ts';

const MAX_BYTES = 2 * 1024 * 1024;

/** One extracted use before it is attributed to a repository. */
export type RawDataUse = Omit<CodeDataUse, 'repository'>;

/**
 * Extract the tables and columns a repository's source code names.
 *
 * Lexical, like the service-call extractor: string-literal SQL, and the table and column
 * mappings of a few ORMs. A table hidden behind a query builder, or built from an
 * interpolated string, records nothing rather than a guess.
 */
export function extractDataUses(root: string, repository: string): CodeDataUse[] {
  const uses: CodeDataUse[] = [];
  for (const file of findSourceFiles(root)) {
    const content = readText(root, file);
    if (content === null) {
      continue;
    }
    try {
      for (const use of extractDataUsesFromSource(file, content)) {
        uses.push({ repository, ...use });
      }
    } catch {
      // A file that cannot be read as source contributes nothing.
    }
  }
  return uses;
}

/** The uses in one source file. Pure, so a revision read from git is handled the same way. */
export function extractDataUsesFromSource(file: string, content: string): RawDataUse[] {
  const extension = path.extname(file).toLowerCase();
  const uses: RawDataUse[] = [...sqlLiteralUses(file, content)];
  if (extension === '.java' || extension === '.kt' || extension === '.kts') {
    uses.push(...jpaUses(file, content));
  }
  if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    uses.push(...typeOrmUses(file, content));
  }
  if (extension === '.py') {
    uses.push(...sqlAlchemyUses(file, content));
  }
  if (extension === '.rs') {
    uses.push(...rustUses(file, content));
  }
  return uses.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.table.localeCompare(b.table) || a.evidence.localeCompare(b.evidence),
  );
}

// ---------------------------------------------------------------------------------------
// String-literal SQL
// ---------------------------------------------------------------------------------------

/** Triple-quoted, raw, backtick, and single-line string literals. */
const LITERAL =
  /"""[\s\S]*?"""|'''[\s\S]*?'''|\br(#*)"[\s\S]*?"\1|`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g;

const QUALIFIED = String.raw`((?:["\`\[]?[A-Za-z_][\w$]*["\`\]]?\.)?["\`\[]?[A-Za-z_][\w$]*["\`\]]?)`;

/** Words a table position can never hold, and the everyday words a prose "select ... from" names. */
const NOT_TABLES = new Set([
  'select', 'where', 'set', 'values', 'table', 'from', 'into', 'update', 'join', 'delete',
  'insert', 'create', 'alter', 'on', 'using', 'as', 'with', 'and', 'or', 'not', 'null',
  'default', 'primary', 'foreign', 'index', 'if', 'exists', 'inner', 'left', 'right', 'lateral',
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'your', 'my', 'our', 'their', 'its', 'each',
  'list', 'all', 'here', 'there', 'one', 'any', 'dual', 'unnest', 'generate_series',
]);

/** Catalog and pseudo tables that no migration declares. */
const SYSTEM_TABLE = /^(?:information_schema|pg_catalog|pg_temp|sys|mysql|performance_schema)\.|^(?:pg_|sqlite_|sqlx_|_sqlx_|flyway_schema_history$|schema_migrations$|__diesel_schema_migrations$|alembic_version$|django_migrations$)/;

function* sqlLiteralUses(file: string, content: string): Generator<RawDataUse> {
  for (const literal of content.matchAll(LITERAL)) {
    const raw = literal[0];
    if (!/\b(?:select|insert|update|delete)\b/i.test(raw)) {
      continue;
    }
    const line = lineAt(content, literal.index ?? 0);
    yield* statementsIn(file, line, raw);
  }
}

function* statementsIn(file: string, startLine: number, text: string): Generator<RawDataUse> {
  const ctes = new Set(
    [...text.matchAll(/\b(?:with(?:\s+recursive)?|,)\s+([A-Za-z_]\w*)\s+as\s*\(/gi)].map((match) => (match[1] ?? '').toLowerCase()),
  );
  const emit = (
    rawTable: string | undefined,
    index: number,
    columns: string[],
    evidence: string,
    confidence: CodeDataUse['confidence'],
  ): RawDataUse | null => {
    const table = normalizeTable(rawTable);
    if (!table || ctes.has(table) || NOT_TABLES.has(table) || SYSTEM_TABLE.test(table)) {
      return null;
    }
    return { file, line: startLine + newlinesBefore(text, index), table, columns, evidence, confidence };
  };

  for (const match of text.matchAll(new RegExp(String.raw`\binsert\s+(?:or\s+\w+\s+)?into\s+${QUALIFIED}\s*(\([^)]*\))?`, 'gi'))) {
    const columns = match[2] ? simpleIdentifiers(match[2].slice(1, -1)) : [];
    const use = emit(match[1], match.index ?? 0, columns, 'string-literal SQL (INSERT)', 'strong');
    if (use) {
      yield use;
    }
  }

  for (const match of text.matchAll(new RegExp(String.raw`\bupdate\s+${QUALIFIED}\s+set\s+([\s\S]+?)(?:\bwhere\b|\breturning\b|;|$)`, 'gi'))) {
    const columns = splitTopLevel(match[2] ?? '')
      .map((assignment) => /^\s*(?:[\w$"`]+\.)?["`]?([A-Za-z_][\w$]*)["`]?\s*=/.exec(assignment)?.[1])
      .filter((column): column is string => typeof column === 'string')
      .map((column) => column.toLowerCase());
    const use = emit(match[1], match.index ?? 0, columns, 'string-literal SQL (UPDATE)', 'strong');
    if (use) {
      yield use;
    }
  }

  for (const match of text.matchAll(new RegExp(String.raw`\bdelete\s+from\s+${QUALIFIED}`, 'gi'))) {
    const use = emit(match[1], match.index ?? 0, [], 'string-literal SQL (DELETE)', 'strong');
    if (use) {
      yield use;
    }
  }

  for (const match of text.matchAll(new RegExp(String.raw`\bjoin\s+${QUALIFIED}`, 'gi'))) {
    const use = emit(match[1], match.index ?? 0, [], 'string-literal SQL (JOIN)', 'weak');
    if (use) {
      yield use;
    }
  }

  const select = new RegExp(String.raw`\bselect\s+(?:distinct\s+)?([\s\S]+?)\s+from\s+${QUALIFIED}(?:\s+(?:as\s+)?[A-Za-z_]\w*)?(\s*,)?`, 'gi');
  for (const match of text.matchAll(select)) {
    const after = text.slice((match.index ?? 0) + match[0].length);
    const tablesOnly = Boolean(match[3]) || /^\s*(?:(?:inner|left|right|full|cross|natural)\s+)*join\b/i.test(after);
    const columns = tablesOnly ? [] : selectColumns(match[1] ?? '');
    const use = emit(match[2], match.index ?? 0, columns, 'string-literal SQL (SELECT)', 'weak');
    if (use) {
      yield use;
    }
  }
}

/** The plain identifiers in a select list; `*`, expressions, and aliased items are skipped. */
function selectColumns(list: string): string[] {
  const columns: string[] = [];
  for (const item of splitTopLevel(list)) {
    const trimmed = item.trim().replace(/\s+as\s+\w+$/i, '');
    const match = /^(?:[\w$"`]+\.)?["`]?([A-Za-z_][\w$]*)["`]?$/.exec(trimmed);
    if (match && !['null', 'true', 'false', 'distinct', 'current_timestamp', 'current_date'].includes((match[1] ?? '').toLowerCase())) {
      columns.push((match[1] ?? '').toLowerCase());
    }
  }
  return columns;
}

function simpleIdentifiers(list: string): string[] {
  return splitTopLevel(list)
    .map((item) => /^\s*["`]?([A-Za-z_][\w$]*)["`]?\s*$/.exec(item)?.[1])
    .filter((column): column is string => typeof column === 'string')
    .map((column) => column.toLowerCase());
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim() !== '') {
    parts.push(current);
  }
  return parts;
}

/** `Public.Users` -> `users`; another schema keeps its prefix, as the schema extractor does. */
function normalizeTable(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const parts = raw
    .replace(/["`[\]]/g, '')
    .toLowerCase()
    .split('.')
    .filter(Boolean);
  const tail = parts.slice(-2);
  if (tail.length === 2 && (tail[0] === 'public' || tail[0] === 'dbo')) {
    return tail[1] ?? null;
  }
  return tail.length > 0 ? tail.join('.') : null;
}

// ---------------------------------------------------------------------------------------
// ORM mappings
// ---------------------------------------------------------------------------------------

/** The body of the class or object whose `{` is the first one at or after `from`. */
function braceBody(content: string, from: number): { text: string; start: number } | null {
  const open = content.indexOf('{', from);
  if (open === -1) {
    return null;
  }
  let depth = 0;
  for (let index = open; index < content.length; index += 1) {
    const character = content[index];
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return { text: content.slice(open + 1, index), start: open + 1 };
      }
    }
  }
  return null;
}

function jpaUses(file: string, content: string): RawDataUse[] {
  const uses: RawDataUse[] = [];
  for (const match of content.matchAll(/@Table\s*\(\s*(?:name\s*=\s*)?"([^"]+)"/g)) {
    const table = normalizeTable(match[1]);
    if (!table) {
      continue;
    }
    const body = braceBody(content, (match.index ?? 0) + match[0].length);
    const columns = body
      ? [...body.text.matchAll(/@Column\s*\([^)]*?\bname\s*=\s*"([^"]+)"/g)].map((column) => (column[1] ?? '').toLowerCase())
      : [];
    uses.push({
      file,
      line: lineAt(content, match.index ?? 0),
      table,
      columns,
      evidence: 'ORM annotation (@Table)',
      confidence: 'strong',
    });
  }
  return uses;
}

function typeOrmUses(file: string, content: string): RawDataUse[] {
  const uses: RawDataUse[] = [];
  const entity = /@Entity\s*\(\s*(?:\{[^}]*?\bname\s*:\s*)?['"`]([^'"`]+)['"`]/g;
  for (const match of content.matchAll(entity)) {
    const table = normalizeTable(match[1]);
    if (!table) {
      continue;
    }
    const body = braceBody(content, (match.index ?? 0) + match[0].length);
    const columns: string[] = [];
    if (body) {
      const column = /@(?:Primary(?:Generated)?Column|Column)\s*\(([^)]*)\)\s*(?:(?:public|private|protected|readonly)\s+)*([A-Za-z_$][\w$]*)/g;
      for (const found of body.text.matchAll(column)) {
        const explicit = /\bname\s*:\s*['"`]([^'"`]+)['"`]/.exec(found[1] ?? '')?.[1];
        columns.push((explicit ?? found[2] ?? '').toLowerCase());
      }
    }
    uses.push({
      file,
      line: lineAt(content, match.index ?? 0),
      table,
      columns: columns.filter(Boolean),
      evidence: 'ORM annotation (@Entity)',
      confidence: 'strong',
    });
  }
  return uses;
}

function sqlAlchemyUses(file: string, content: string): RawDataUse[] {
  const uses: RawDataUse[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const declaration = /^(\s+)__tablename__\s*=\s*['"]([^'"]+)['"]/.exec(lines[index] ?? '');
    const table = normalizeTable(declaration?.[2]);
    if (!declaration || !table) {
      continue;
    }
    const indent = declaration[1]?.length ?? 1;
    // The class body is every line indented at least as far as the declaration.
    let start = index;
    while (start > 0 && (/^\s*$/.test(lines[start - 1] ?? '') || (lines[start - 1]?.search(/\S/) ?? 0) >= indent)) {
      start -= 1;
    }
    let end = index + 1;
    while (end < lines.length && (/^\s*$/.test(lines[end] ?? '') || (lines[end]?.search(/\S/) ?? 0) >= indent)) {
      end += 1;
    }
    const columns: string[] = [];
    for (const row of lines.slice(start, end)) {
      const column = /^\s+([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(?:\w+\.)*(?:Column|mapped_column)\(\s*(?:['"]([^'"]+)['"])?/.exec(row);
      if (column) {
        columns.push((column[2] ?? column[1] ?? '').toLowerCase());
      }
    }
    uses.push({
      file,
      line: index + 1,
      table,
      columns,
      evidence: 'ORM declaration (__tablename__)',
      confidence: 'strong',
    });
  }
  return uses;
}

function rustUses(file: string, content: string): RawDataUse[] {
  const uses: RawDataUse[] = [];

  // Diesel: table! { users (id) { id -> Int4, name -> Text, } }
  for (const match of content.matchAll(/\btable!\s*\{\s*([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*\{([\s\S]*?)\}\s*\}/g)) {
    const table = normalizeTable(match[1]);
    if (!table) {
      continue;
    }
    const columns = [...(match[2] ?? '').matchAll(/([A-Za-z_]\w*)\s*->/g)].map((column) => (column[1] ?? '').toLowerCase());
    uses.push({
      file,
      line: lineAt(content, match.index ?? 0),
      table,
      columns,
      evidence: 'ORM macro (table!)',
      confidence: 'strong',
    });
  }

  // SeaORM: #[sea_orm(table_name = "users")] pub struct Model { pub id: i32, ... }
  for (const match of content.matchAll(/#\[sea_orm\s*\([^)]*\btable_name\s*=\s*"([^"]+)"[^)]*\)\]/g)) {
    const table = normalizeTable(match[1]);
    if (!table) {
      continue;
    }
    const body = braceBody(content, (match.index ?? 0) + match[0].length);
    const columns = body
      ? [...body.text.matchAll(/\bpub\s+([a-z_]\w*)\s*:/g)].map((column) => (column[1] ?? '').toLowerCase())
      : [];
    uses.push({
      file,
      line: lineAt(content, match.index ?? 0),
      table,
      columns,
      evidence: 'ORM macro (sea_orm)',
      confidence: 'strong',
    });
  }
  return uses;
}

function lineAt(content: string, index: number): number {
  return newlinesBefore(content, index) + 1;
}

function newlinesBefore(content: string, index: number): number {
  let count = 0;
  const stop = Math.min(index, content.length);
  for (let offset = content.indexOf('\n'); offset !== -1 && offset < stop; offset = content.indexOf('\n', offset + 1)) {
    count += 1;
  }
  return count;
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
