import type { TableReference } from './types.ts';

const RESERVED_TABLES = new Set([
  'select', 'where', 'set', 'values', 'table', 'from', 'into', 'update', 'join', 'delete',
  'insert', 'create', 'alter', 'on', 'using', 'as', 'with', 'and', 'or', 'not', 'null',
  'default', 'primary', 'foreign', 'index', 'if', 'exists', 'inner', 'left', 'right',
]);

/**
 * Extract the data tables a file names, each with the rule that read it.
 *
 * Lexical and labelled: SQL keywords, ORM annotations/macros, and string-literal SQL. A
 * query builder that hides the table name, or a dynamic string, records nothing rather than
 * a guessed table.
 */
export function extractTables(file: string, content: string): TableReference[] {
  const found = new Map<string, TableReference>();
  const add = (raw: string, index: number, evidence: string): void => {
    const table = raw.replace(/["'`[\]]/g, '');
    if (table === '' || RESERVED_TABLES.has(table.toLowerCase())) {
      return;
    }
    const line = lineAt(content, index);
    found.set(`${table}\u0000${line}\u0000${evidence}`, { table, file, line, evidence });
  };

  for (const match of content.matchAll(
    /\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|INSERT\s+INTO|DELETE\s+FROM|UPDATE|JOIN)\s+["'`[]?([A-Za-z_][\w.]*)/gi,
  )) {
    add(match[1] ?? '', match.index ?? 0, 'SQL keyword');
  }
  for (const match of content.matchAll(
    /@(?:Table|Entity)\s*\(\s*(?:name|tableName)\s*=\s*["']([^"']+)["']/gi,
  )) {
    add(match[1] ?? '', match.index ?? 0, 'ORM annotation');
  }
  for (const match of content.matchAll(/#\[table\s*\(\s*name\s*=\s*"([^"]+)"/gi)) {
    add(match[1] ?? '', match.index ?? 0, 'ORM macro');
  }
  for (const match of content.matchAll(
    /["'`][^"'`]*?\b(?:from|join|into|update)\s+["'`]?([A-Za-z_][\w.]*)[^"'`]*?["'`]/gi,
  )) {
    add(match[1] ?? '', match.index ?? 0, 'string-literal SQL');
  }

  return [...found.values()].sort(
    (a, b) => a.table.localeCompare(b.table) || a.line - b.line || a.evidence.localeCompare(b.evidence),
  );
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let offset = 0; offset < index && offset < content.length; offset += 1) {
    if (content[offset] === '\n') {
      line += 1;
    }
  }
  return line;
}
