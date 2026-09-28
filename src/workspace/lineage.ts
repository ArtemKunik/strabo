import fs from 'node:fs';
import path from 'node:path';

import { findSourceFiles } from './dto.ts';

import { toPosix } from '../boundary/repository-root.ts';
import { excludedDirectory } from '../scan/exclusions.ts';

const MAX_BYTES = 2 * 1024 * 1024;

/** One column mapping read from a plain select projection. */
export interface LineageColumn {
  target: string;
  source: string | null;
  transformation: boolean;
}

/** A table-level `derives` edge read from a migration or a string-literal query. */
export interface RawLineage {
  repository: string;
  file: string;
  line: number;
  sourceTable: string;
  targetTable: string;
  evidence: string;
  columns: LineageColumn[];
}

/** A literal file or object path a batch job reads or writes. */
export interface RawPathIo {
  repository: string;
  file: string;
  line: number;
  path: string;
  direction: 'read' | 'write';
  evidence: string;
}

const LITERAL =
  /"""[\s\S]*?"""|'''[\s\S]*?'''|\br(#*)"[\s\S]*?"\1|`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g;

const QUALIFIED = String.raw`((?:["\`\[]?[A-Za-z_][\w$]*["\`\]]?\.)?["\`\[]?[A-Za-z_][\w$]*["\`\]]?)`;

/** Extract table-level lineage the scan can read, from source and from `.sql` files. */
export function extractSqlLineage(root: string, repository: string): RawLineage[] {
  const edges: RawLineage[] = [];
  for (const file of [...findSourceFiles(root), ...findSqlFiles(root)]) {
    const content = readText(root, file);
    if (content === null) {
      continue;
    }
    for (const literal of content.matchAll(LITERAL)) {
      const raw = literal[0];
      if (!/\b(?:insert|create)\b/i.test(raw)) {
        continue;
      }
      edges.push(...lineageIn(file, repository, content, literal.index ?? 0, raw));
    }
  }
  return dedupeLineage(edges);
}

function lineageIn(
  file: string,
  repository: string,
  content: string,
  base: number,
  text: string,
): RawLineage[] {
  const edges: RawLineage[] = [];
  const lineAt = (index: number): number => countLines(content, base + index) + 1;

  const insert = new RegExp(String.raw`\binsert\s+into\s+${QUALIFIED}\s*(\([^)]*\))?[\s\S]*?\bselect\s+([\s\S]+?)\s+from\s+${QUALIFIED}`, 'gi');
  for (const match of text.matchAll(insert)) {
    const target = normalizeTable(match[1]);
    const source = normalizeTable(match[4]);
    if (!target || !source) {
      continue;
    }
    const targetColumns = match[2] ? simpleIdentifiers(match[2].slice(1, -1)) : [];
    edges.push({
      repository,
      file,
      line: lineAt(match.index ?? 0),
      sourceTable: source,
      targetTable: target,
      evidence: 'string-literal SQL (INSERT ... SELECT)',
      columns: projection(match[3] ?? '', targetColumns),
    });
  }

  const ctas = new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:table|view|materialized\s+view)\s+(?:if\s+not\s+exists\s+)?${QUALIFIED}\s+as\s+select\s+([\s\S]+?)\s+from\s+${QUALIFIED}`, 'gi');
  for (const match of text.matchAll(ctas)) {
    const target = normalizeTable(match[1]);
    const source = normalizeTable(match[4]);
    if (!target || !source) {
      continue;
    }
    edges.push({
      repository,
      file,
      line: lineAt(match.index ?? 0),
      sourceTable: source,
      targetTable: target,
      evidence: 'string-literal SQL (CREATE TABLE AS SELECT)',
      columns: projection(match[3] ?? '', []),
    });
  }
  return edges;
}

/** The literal file and object paths a batch job reads and writes. */
export function extractPathIo(root: string, repository: string): RawPathIo[] {
  const found: RawPathIo[] = [];
  for (const file of findSourceFiles(root)) {
    const content = readText(root, file);
    if (content === null) {
      continue;
    }
    for (const [pattern, direction, evidence] of PATH_RULES) {
      for (const match of content.matchAll(pattern)) {
        const target = match[1];
        if (!target || !LOOKS_LIKE_PATH.test(target)) {
          continue;
        }
        found.push({ repository, file, line: countLines(content, match.index ?? 0) + 1, path: target, direction, evidence });
      }
    }
  }
  return dedupePaths(found);
}

const PATH_RULES: ReadonlyArray<[RegExp, 'read' | 'write', string]> = [
  [/\bread(?:_parquet|_csv|_json|_orc|_text)?\s*\(\s*[`'"]([^`'"]+)[`'"]/g, 'read', 'batch read'],
  [/\b(?:spark|session|sqlContext)\s*\.\s*read\s*\.\s*(?:format\s*\([^)]*\)\s*\.\s*)?load\s*\(\s*[`'"]([^`'"]+)[`'"]/g, 'read', 'spark read'],
  [/\b(?:spark|session)\s*\.\s*table\s*\(\s*[`'"]([^`'"]+)[`'"]/g, 'read', 'spark table'],
  [/\.write\s*\.\s*(?:format\s*\([^)]*\)\s*\.\s*)?(?:parquet|csv|json|orc|save)\s*\(\s*[`'"]([^`'"]+)[`'"]/g, 'write', 'batch write'],
  [/\bto_(?:parquet|csv|json|orc)\s*\(\s*[`'"]([^`'"]+)[`'"]/g, 'write', 'dataframe write'],
  [/\bcopy\s+[\w."`]+\s+from\s+[`'"]([^`'"]+)[`'"]/gi, 'read', 'COPY FROM'],
  [/\bcopy\s+[\w."`]+\s+to\s+[`'"]([^`'"]+)[`'"]/gi, 'write', 'COPY TO'],
];

/** A path is only taken when it names an object store, a scheme, or a slash: never a bare word. */
const LOOKS_LIKE_PATH = /[:/\\]|\.[A-Za-z0-9]{2,4}$/;

function projection(list: string, targetColumns: readonly string[]): LineageColumn[] {
  const items = splitTopLevel(list);
  return items.map((item, index) => {
    const trimmed = item.trim();
    const alias = /\bas\s+["`]?([A-Za-z_][\w$]*)["`]?\s*$/i.exec(trimmed)?.[1];
    const plain = /^(?:[\w$"`]+\.)?["`]?([A-Za-z_][\w$]*)["`]?$/.exec(trimmed.replace(/\s+as\s+[\w$"`]+$/i, ''))?.[1];
    const target = targetColumns[index] ?? alias ?? plain ?? `column_${index + 1}`;
    if (plain) {
      return { target, source: plain.toLowerCase(), transformation: false };
    }
    return { target, source: null, transformation: true };
  });
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

function normalizeTable(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const parts = raw.replace(/["`[\]]/g, '').toLowerCase().split('.').filter(Boolean);
  const tail = parts.slice(-2);
  if (tail.length === 2 && (tail[0] === 'public' || tail[0] === 'dbo')) {
    return tail[1] ?? null;
  }
  return tail.length > 0 ? tail.join('.') : null;
}

function findSqlFiles(root: string): string[] {
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

function countLines(content: string, index: number): number {
  let count = 0;
  for (let offset = content.indexOf('\n'); offset !== -1 && offset < index; offset = content.indexOf('\n', offset + 1)) {
    count += 1;
  }
  return count;
}

function dedupeLineage(edges: RawLineage[]): RawLineage[] {
  const seen = new Set<string>();
  return edges
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.targetTable.localeCompare(b.targetTable))
    .filter((edge) => {
      const key = `${edge.repository}\u0000${edge.file}\u0000${edge.line}\u0000${edge.sourceTable}\u0000${edge.targetTable}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function dedupePaths(items: RawPathIo[]): RawPathIo[] {
  const seen = new Set<string>();
  return items
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.path.localeCompare(b.path))
    .filter((item) => {
      const key = `${item.repository}\u0000${item.file}\u0000${item.line}\u0000${item.path}\u0000${item.direction}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
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
