import path from 'node:path';

import type { Node } from 'web-tree-sitter';

import type { Diagnostic, GraphEdge } from '../../types.ts';
import type { GrammarLanguage } from './parser-runtime.ts';
import { withParser } from './parser-runtime.ts';
import { type CodeSymbol, type SymbolExtraction, sortSymbols, walkNodes } from './symbols.ts';

export const SQL_LANGUAGE: GrammarLanguage = 'sql';

export type SqlObjectKind = 'table' | 'view' | 'materialized-view';

/** A relation created by the file. `name` is normalised (`schema.name`, lower-case). */
export interface SqlDefinition {
  name: string;
  kind: SqlObjectKind;
  line: number;
}

/** A relation the file reads, writes, alters, indexes, or points a foreign key at. */
export interface SqlReference {
  name: string;
  line: number;
}

/** A directive that runs another SQL file (`\i`, `\ir`, `:r`, `source`, `@`). */
export interface SqlInclude {
  path: string;
  line: number;
}

export interface SqlFileFacts {
  file: string;
  definitions: SqlDefinition[];
  references: SqlReference[];
  includes: SqlInclude[];
}

export interface SqlExtraction {
  facts: SqlFileFacts;
  diagnostics: Diagnostic[];
}

const DEFINITIONS: Record<string, SqlObjectKind> = {
  create_table: 'table',
  create_view: 'view',
  create_materialized_view: 'materialized-view',
};

/** Session-local tables are not part of the schema, so they never define anything. */
const TEMPORARY_KEYWORDS = new Set(['keyword_temporary', 'keyword_temp']);

/** psql `\i`, `\ir`, `\include`, `\include_relative`; other backslash lines are just masked. */
const PSQL_INCLUDE = /^\s*\\(?:ir?|include(?:_relative)?)\s+(.+?)\s*;?\s*$/;
const PSQL_META_COMMAND = /^\s*\\[A-Za-z]/;
/** sqlcmd `:r`, mysql `source`, and SQL*Plus `@` / `@@`. */
const SCRIPT_INCLUDE = /^\s*(?::r|source|@@?)\s*(.+?)\s*;?\s*$/i;
/** T-SQL batch separator; a line holding only `GO` is not SQL the grammar understands. */
const BATCH_SEPARATOR = /^\s*GO(?:\s+\d+)?\s*;?\s*$/i;

/**
 * Parse one SQL file into the relations it defines, the relations it uses, and the SQL
 * files it includes.
 *
 * Client directives (psql meta-commands, `GO`) are not SQL and would derail the grammar,
 * so they are blanked out before parsing; line numbers are preserved.
 */
export async function extractSqlFacts(file: string, content: string): Promise<SqlExtraction> {
  const { includes, masked } = readDirectives(content);
  return withParser(SQL_LANGUAGE, (parser) => {
    const facts: SqlFileFacts = { file, definitions: [], references: [], includes };
    const diagnostics: Diagnostic[] = [];

    const tree = parser.parse(masked);
    if (!tree) {
      diagnostics.push({
        file,
        line: 1,
        severity: 'error',
        kind: 'parse-failure',
        message: 'SQL parser returned no tree for this file.',
      });
      return { facts, diagnostics };
    }

    collect(tree.rootNode, new Set(), facts);
    facts.references = dedupeByName(facts.references);

    if (tree.rootNode.hasError) {
      diagnostics.push(syntaxWarning(file));
    }

    return { facts, diagnostics };
  });
}

function syntaxWarning(file: string): Diagnostic {
  return {
    file,
    line: 1,
    severity: 'warning',
    kind: 'parse-failure',
    message:
      'SQL source contains syntax the grammar does not understand (likely dialect-specific); extracted facts may be incomplete.',
  };
}

/**
 * Find include directives and blank out every client directive line.
 *
 * Only a directive that names a `.sql` file counts as an include, and only lines that
 * genuinely are directives are blanked - `source AS alias` at the start of a select-list
 * line is SQL and must reach the parser. Lines inside a block comment are left alone.
 */
function readDirectives(content: string): { includes: SqlInclude[]; masked: string } {
  const includes: SqlInclude[] = [];
  let inBlockComment = false;

  const lines = content.split(/\r?\n/).map((line, index) => {
    const startsInComment = inBlockComment;
    inBlockComment = endsInBlockComment(line, inBlockComment);
    if (startsInComment) {
      return line;
    }

    const psql = PSQL_INCLUDE.exec(line);
    const script = psql ? null : SCRIPT_INCLUDE.exec(line);
    const target = normaliseIncludePath(psql?.[1] ?? script?.[1]);
    if (target) {
      includes.push({ path: target, line: index + 1 });
      return ' '.repeat(line.length);
    }
    if (PSQL_META_COMMAND.test(line) || BATCH_SEPARATOR.test(line)) {
      return ' '.repeat(line.length);
    }
    return line;
  });

  return { includes, masked: lines.join('\n') };
}

function endsInBlockComment(line: string, inBlockComment: boolean): boolean {
  let state = inBlockComment;
  for (let index = 0; index < line.length - 1; index += 1) {
    const pair = line.slice(index, index + 2);
    if (!state && pair === '--') {
      break;
    }
    if (!state && pair === '/*') {
      state = true;
      index += 1;
    } else if (state && pair === '*/') {
      state = false;
      index += 1;
    }
  }
  return state;
}

function normaliseIncludePath(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const unquoted = raw.replace(/^(['"])(.*)\1$/, '$2').replace(/\\/g, '/');
  return /\.sql$/i.test(unquoted) ? unquoted : null;
}

/**
 * Walk the whole tree, including `ERROR` subtrees: tree-sitter recovers well enough that
 * statements around an unsupported construct still yield usable facts.
 *
 * `ctes` holds the common-table-expression names visible at `node`; a bare name that
 * matches one is a query-local alias, not a repository relation.
 */
function collect(node: Node, ctes: ReadonlySet<string>, facts: SqlFileFacts): void {
  const children = node.namedChildren;
  let visible = ctes;
  for (const child of children) {
    const cteName = child.type === 'cte' ? child.namedChildren.find((c) => c.type === 'identifier') : null;
    if (cteName) {
      visible = new Set([...visible, unquote(cteName.text).toLowerCase()]);
    }
  }

  const kind = DEFINITIONS[node.type];
  if (kind && !children.some((child) => TEMPORARY_KEYWORDS.has(child.type))) {
    const name = nameOf(children.find((child) => child.type === 'object_reference'));
    if (name) {
      facts.definitions.push({ name, kind, line: node.startPosition.row + 1 });
    }
  }

  if (node.type === 'object_reference' && isRelationReference(node)) {
    const name = nameOf(node);
    if (name && !(visible.has(name) && !name.includes('.'))) {
      facts.references.push({ name, line: node.startPosition.row + 1 });
    }
  }

  for (const child of children) {
    collect(child, visible, facts);
  }
}

/**
 * Whether an `object_reference` names a relation being used, judged by where it sits.
 *
 * Column qualifiers (`o.id`), function names, and the name a statement is *creating* are
 * all `object_reference` nodes too, so position - not node type alone - decides.
 */
function isRelationReference(node: Node): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  switch (parent.type) {
    case 'relation': // FROM / JOIN / UPDATE targets
    case 'from': // DELETE FROM x
      return true;
    case 'insert':
    case 'alter_table':
    case 'create_index':
      return objectReferences(parent)[0]?.id === node.id;
    case 'create_trigger': // name, table, function
      return objectReferences(parent)[1]?.id === node.id;
    default:
      // REFERENCES <table> in a column definition or a table/alter constraint.
      return node.previousNamedSibling?.type === 'keyword_references';
  }
}

function objectReferences(node: Node): Node[] {
  return node.namedChildren.filter((child) => child.type === 'object_reference');
}

/** `schema.name`, lower-cased and unquoted; a database prefix is dropped. */
function nameOf(node: Node | undefined): string | null {
  if (!node) {
    return null;
  }
  const parts = node.namedChildren
    .filter((child) => child.type === 'identifier')
    .map((child) => unquote(child.text).toLowerCase())
    .filter(Boolean);
  return parts.length > 0 ? parts.slice(-2).join('.') : null;
}

function unquote(part: string): string {
  const first = part[0];
  const last = part[part.length - 1];
  const quoted =
    part.length >= 2 &&
    ((first === '"' && last === '"') || (first === '`' && last === '`') || (first === '[' && last === ']'));
  return quoted ? part.slice(1, -1) : part;
}

function dedupeByName(references: SqlReference[]): SqlReference[] {
  const byName = new Map<string, SqlReference>();
  for (const reference of references) {
    if (!byName.has(reference.name)) {
      byName.set(reference.name, reference);
    }
  }
  return [...byName.values()];
}

/** SQL has no access modifiers; the member map prints this instead of claiming `public`. */
const SQL_VISIBILITY = 'n/a';

/** Node types that follow a column's name and type and start its constraints. */
const COLUMN_CONSTRAINT_KEYWORDS = new Set([
  'keyword_primary',
  'keyword_not',
  'keyword_null',
  'keyword_default',
  'keyword_references',
  'keyword_unique',
  'keyword_check',
  'keyword_constraint',
  'keyword_generated',
  'keyword_collate',
  'keyword_auto_increment',
  'keyword_as',
]);

/**
 * Extract declared members: a table or view is a `type`, and each of its columns is a
 * `field` it owns. Columns come from `CREATE TABLE` and from `ALTER TABLE ... ADD COLUMN`,
 * so a migration that only adds columns still shows them, owned by the altered table.
 *
 * Deliberately not extracted: functions and procedures (the grammar loses most `plpgsql`
 * bodies to error recovery, so what it kept would be an arbitrary subset) and view columns
 * (a select list does not declare types). SQL records no field access either, so
 * `accesses` is left out and the member map reports its data-flow panels as unavailable.
 */
export async function extractSqlSymbols(file: string, content: string): Promise<SymbolExtraction> {
  const { masked } = readDirectives(content);
  return withParser(SQL_LANGUAGE, (parser) => {
    const diagnostics: Diagnostic[] = [];
    const symbols: CodeSymbol[] = [];

    const tree = parser.parse(masked);
    if (!tree) {
      diagnostics.push({
        file,
        line: 1,
        severity: 'error',
        kind: 'parse-failure',
        message: 'SQL parser returned no tree for this file.',
      });
      return { symbols, diagnostics };
    }

    const declared = new Set<string>();
    const columns = new Set<string>();

    const addColumn = (owner: string, definition: Node): void => {
      const [nameNode, typeNode] = definition.namedChildren;
      // The grammar reads a double-quoted column name (`"Order Id"`) as a string literal.
      const isName = nameNode?.type === 'identifier' || (nameNode?.type === 'literal' && nameNode.text.startsWith('"'));
      if (!nameNode || !isName) {
        return;
      }
      const name = unquote(nameNode.text);
      const key = `${owner.toLowerCase()}\u0000${name.toLowerCase()}`;
      if (columns.has(key)) {
        return;
      }
      columns.add(key);
      const type = columnType(typeNode);
      symbols.push({
        name,
        kind: 'field',
        visibility: SQL_VISIBILITY,
        owner,
        ...(type ? { type } : {}),
        mutable: true,
        line: nameNode.startPosition.row + 1,
      });
    };

    walkNodes(tree.rootNode, (node) => {
      if (node.type in DEFINITIONS) {
        const owner = displayNameOf(node.namedChildren.find((child) => child.type === 'object_reference'));
        // A relation created twice in one file (re-runnable scripts) is one member set.
        if (!owner || declared.has(owner.toLowerCase())) {
          return;
        }
        declared.add(owner.toLowerCase());
        symbols.push({
          name: owner,
          kind: 'type',
          visibility: SQL_VISIBILITY,
          owner: '',
          line: node.startPosition.row + 1,
        });
        if (node.type === 'create_table') {
          const list = node.namedChildren.find((child) => child.type === 'column_definitions');
          for (const definition of list?.namedChildren ?? []) {
            if (definition.type === 'column_definition') {
              addColumn(owner, definition);
            }
          }
        }
      } else if (node.type === 'alter_table') {
        const owner = displayNameOf(node.namedChildren.find((child) => child.type === 'object_reference'));
        if (!owner) {
          return;
        }
        for (const added of node.namedChildren) {
          const definition = added.type === 'add_column' ? added.namedChildren.find((c) => c.type === 'column_definition') : null;
          if (definition) {
            addColumn(canonicalOwner(symbols, owner), definition);
          }
        }
      }
    });

    if (tree.rootNode.hasError) {
      diagnostics.push(syntaxWarning(file));
    }

    return { symbols: sortSymbols(symbols), diagnostics };
  });
}

/** A constraint word the grammar sometimes reads as a type name when the type is omitted. */
const CONSTRAINT_WORD = /^(?:primary|not|null|default|unique|references|check|constraint|generated|collate)$/i;

/** The type as written (`DECIMAL(10, 2)`, `INT[]`), or nothing when the column omits it. */
function columnType(typeNode: Node | undefined): string | undefined {
  if (!typeNode || COLUMN_CONSTRAINT_KEYWORDS.has(typeNode.type) || CONSTRAINT_WORD.test(typeNode.text)) {
    return undefined;
  }
  const array = typeNode.nextNamedSibling?.type === 'array_size_definition' ? typeNode.nextNamedSibling.text : '';
  return `${typeNode.text}${array}`.replace(/\s+/g, ' ');
}

/** The table's name as authored (schema included), unquoted but not lower-cased. */
function displayNameOf(node: Node | undefined): string | null {
  const parts = (node?.namedChildren ?? [])
    .filter((child) => child.type === 'identifier')
    .map((child) => unquote(child.text))
    .filter(Boolean);
  return parts.length > 0 ? parts.join('.') : null;
}

/** Reuse the spelling an earlier `CREATE TABLE` gave, so `ALTER TABLE USERS` joins `users`. */
function canonicalOwner(symbols: CodeSymbol[], owner: string): string {
  const existing = symbols.find((symbol) => symbol.kind === 'type' && symbol.name.toLowerCase() === owner.toLowerCase());
  return existing?.name ?? owner;
}

export interface SqlResolution {
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}

interface SqlObject {
  file: string;
  schema: string;
}

function splitName(name: string): { schema: string; bare: string } {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? { schema: '', bare: name } : { schema: name.slice(0, dot), bare: name.slice(dot + 1) };
}

/**
 * Resolve SQL relation references and file includes to repository files.
 *
 * A reference becomes a `table` edge only when exactly one other file defines the relation.
 * Relations no file defines are ignored silently - most are external tables, and there is
 * no way to tell those from a typo. A relation defined by several files is `ambiguous` and
 * gets no edge. A file that defines a relation itself never links away for it.
 *
 * Schemas match loosely, as a search path would: `public.users` finds a `users` defined
 * without a schema, and the reverse. When a schema is given and some definition carries
 * exactly that schema, only those definitions compete.
 */
export function resolveSql(facts: SqlFileFacts[]): SqlResolution {
  const edges: GraphEdge[] = [];
  const diagnostics: Diagnostic[] = [];
  const known = new Set(facts.map((entry) => entry.file));

  const objects = new Map<string, SqlObject[]>();
  for (const entry of facts) {
    for (const definition of entry.definitions) {
      const { schema, bare } = splitName(definition.name);
      const list = objects.get(bare) ?? [];
      list.push({ file: entry.file, schema });
      objects.set(bare, list);
    }
  }

  for (const entry of facts) {
    const linked = new Set<string>();
    const link = (target: string, kind: GraphEdge['kind'], line: number, specifier: string, resolution: 'exact' | 'root'): void => {
      if (target === entry.file || linked.has(`${kind}\u0000${target}`)) {
        return;
      }
      linked.add(`${kind}\u0000${target}`);
      edges.push({ source: entry.file, target, kind, evidence: { line, specifier, resolution } });
    };

    for (const include of entry.includes) {
      const resolved = resolveInclude(entry.file, include.path, known);
      if (resolved) {
        link(resolved.target, 'import', include.line, include.path, resolved.resolution);
      } else {
        diagnostics.push({
          file: entry.file,
          line: include.line,
          severity: 'warning',
          kind: 'unresolved',
          specifier: include.path,
          message: `SQL include "${include.path}" does not resolve to a file inside the repository.`,
        });
      }
    }

    for (const reference of entry.references) {
      const { schema, bare } = splitName(reference.name);
      const candidates = (objects.get(bare) ?? []).filter(
        (object) => !schema || !object.schema || object.schema === schema,
      );
      const exact = schema ? candidates.filter((object) => object.schema === schema) : [];
      const competing = exact.length > 0 ? exact : candidates;

      if (competing.some((object) => object.file === entry.file)) {
        continue;
      }
      const files = [...new Set(competing.map((object) => object.file))].sort();
      if (files.length === 0) {
        continue;
      }
      if (files.length > 1) {
        diagnostics.push({
          file: entry.file,
          line: reference.line,
          severity: 'warning',
          kind: 'ambiguous',
          specifier: reference.name,
          message: `Relation "${reference.name}" is defined by more than one file (${files.join(', ')}).`,
        });
        continue;
      }
      link(files[0] as string, 'table', reference.line, reference.name, 'exact');
    }
  }

  return { edges, diagnostics };
}

/** Resolve an include beside the including file first, then from the repository root. */
function resolveInclude(
  from: string,
  target: string,
  known: ReadonlySet<string>,
): { target: string; resolution: 'exact' | 'root' } | null {
  if (path.posix.isAbsolute(target) || /^[A-Za-z]:/.test(target)) {
    return null;
  }
  const beside = path.posix.normalize(path.posix.join(path.posix.dirname(from), target));
  if (!beside.startsWith('..') && known.has(beside)) {
    return { target: beside, resolution: 'exact' };
  }
  const fromRoot = path.posix.normalize(target);
  if (!fromRoot.startsWith('..') && known.has(fromRoot)) {
    return { target: fromRoot, resolution: 'root' };
  }
  return null;
}
