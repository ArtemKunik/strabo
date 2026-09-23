import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Graph } from '../types.ts';
import { symbolExtractorFor, type SymbolExtractor } from '../scan/languages/registry.ts';
import type { SymbolExtraction } from '../scan/languages/symbols.ts';
import { buildAdjacency } from './analysis.ts';
import { computePublicSurfaceDiff } from './change-passport.ts';
import { contentAtRevision, readWorkingFile } from './git-content.ts';
import { isSafeRevision } from './impact.ts';
import type { SymbolChange } from './review-types.ts';

/**
 * The public API a change set adds, removes, or changes, read from Git and the extractors.
 *
 * A file's public surface is diffed between `base` and the working tree (or `head`), and
 * each removed or changed symbol is matched against the recorded import specifiers of the
 * file's direct importers, so a consumer that names a symbol that moved is named back.
 */

const run = promisify(execFile);
const DEFAULT_MAX_FILES = 200;

export interface PublicApiDiffFile {
  path: string;
  previousPath?: string;
  language: string;
  added: SymbolChange[];
  removed: SymbolChange[];
  changed: SymbolChange[];
  consumers: string[];
}

export interface PublicApiDiffReport {
  available: boolean;
  reason?: string;
  base: string;
  head: string | null;
  files: PublicApiDiffFile[];
  totals: { added: number; removed: number; changed: number; breaking: number };
}

/** One record from `git diff --name-status`: the new path, its status, and any source path. */
interface ChangedPath {
  path: string;
  previousPath?: string;
  status: string;
}

export async function computePublicApiDiff(
  root: string,
  base: string,
  options: { head?: string | null; graph?: Graph; maxFiles?: number } = {},
): Promise<PublicApiDiffReport> {
  const head = options.head ?? null;
  const zeros = { added: 0, removed: 0, changed: 0, breaking: 0 };
  if (!isSafeRevision(base)) {
    return {
      available: false,
      reason: 'base revision is not safe',
      base,
      head,
      files: [],
      totals: zeros,
    };
  }

  const changed = await changedPaths(root, base, head);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const capped = changed.length > maxFiles;
  const selected = changed.slice(0, maxFiles);

  const backward = options.graph ? buildAdjacency(options.graph).backward : null;
  const files: PublicApiDiffFile[] = [];
  for (const change of selected) {
    const file = await diffFile(root, base, head, change, options.graph, backward);
    if (file !== null) {
      files.push(file);
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const totals = { added: 0, removed: 0, changed: 0, breaking: 0 };
  for (const file of files) {
    totals.added += file.added.length;
    totals.removed += file.removed.length;
    totals.changed += file.changed.length;
    if (file.removed.length + file.changed.length > 0) {
      totals.breaking += 1;
    }
  }

  return {
    available: true,
    ...(capped ? { reason: `capped at ${maxFiles} of ${changed.length} changed files` } : {}),
    base,
    head,
    files,
    totals,
  };
}

/** The changed paths between `base` and `head` (or the working tree when `head` is null). */
async function changedPaths(root: string, base: string, head: string | null): Promise<ChangedPath[]> {
  const args =
    head === null
      ? ['diff', '--name-status', '-z', '-M', base]
      : ['diff', '--name-status', '-z', '-M', base, head];
  try {
    const result = await run('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    const stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout);
    return parseNameStatus(stdout);
  } catch {
    return [];
  }
}

/**
 * Parse `git diff --name-status -z` output.
 *
 * Records are NUL-separated: a status, then one path, or for a rename/copy two paths (the
 * source first, then the new path). A `-z` status is never split from its path by a tab, so
 * a NUL walk is exact even for a path containing spaces.
 */
function parseNameStatus(output: string): ChangedPath[] {
  const tokens = output.split('\0');
  const changes: ChangedPath[] = [];
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index];
    index += 1;
    if (status === undefined || status === '') {
      continue;
    }
    const code = status[0] ?? '';
    if (code === 'R' || code === 'C') {
      const previousPath = tokens[index];
      const path = tokens[index + 1];
      index += 2;
      if (previousPath !== undefined && path !== undefined && path !== '') {
        changes.push({ path, previousPath, status: code });
      }
    } else {
      const path = tokens[index];
      index += 1;
      if (path !== undefined && path !== '') {
        changes.push({ path, status: code });
      }
    }
  }
  return changes;
}

async function diffFile(
  root: string,
  base: string,
  head: string | null,
  change: ChangedPath,
  graph: Graph | undefined,
  backward: ReadonlyMap<string, string[]> | null,
): Promise<PublicApiDiffFile | null> {
  const extractor = symbolExtractorFor(change.path);
  if (extractor === null) {
    return null;
  }

  const sourcePath = change.previousPath ?? change.path;
  const beforeContent = await contentAtRevision(root, base, sourcePath);
  const beforeExtraction =
    beforeContent === null ? null : await safeExtract(extractor, sourcePath, beforeContent);

  const afterContent =
    change.status === 'D'
      ? null
      : head === null
        ? readWorkingFile(root, change.path)
        : await contentAtRevision(root, head, change.path);
  const afterExtraction =
    afterContent === null ? null : await safeExtract(extractor, change.path, afterContent);

  const symbols = computePublicSurfaceDiff(extractor, beforeExtraction, afterExtraction).flatMap(
    (surface) => surface.symbols,
  );
  const added = symbols.filter((symbol) => symbol.change === 'added');
  const removed = symbols.filter((symbol) => symbol.change === 'removed');
  const changed = symbols.filter((symbol) => symbol.change === 'changed-signature');
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return null;
  }

  const consumers =
    graph !== undefined && backward !== null
      ? consumersOf(graph, backward, change.path, [...removed, ...changed])
      : [];

  return {
    path: change.path,
    ...(change.previousPath !== undefined ? { previousPath: change.previousPath } : {}),
    language: extractor.language,
    added,
    removed,
    changed,
    consumers,
  };
}

/** Direct importers whose recorded specifier names a removed or changed symbol. */
function consumersOf(
  graph: Graph,
  backward: ReadonlyMap<string, string[]>,
  filePath: string,
  symbols: readonly SymbolChange[],
): string[] {
  const names = symbols.map((symbol) => symbol.name).filter((name) => name !== '');
  if (names.length === 0) {
    return [];
  }
  const consumers = new Set<string>();
  for (const importer of backward.get(filePath) ?? []) {
    const named = graph.edges.some(
      (edge) =>
        edge.source === importer &&
        edge.target === filePath &&
        names.some((name) => edge.evidence.specifier.includes(name)),
    );
    if (named) {
      consumers.add(importer);
    }
  }
  return [...consumers].sort();
}

/** Extract once, returning null on a parse failure so the side is named rather than empty. */
async function safeExtract(
  extractor: SymbolExtractor,
  file: string,
  content: string,
): Promise<SymbolExtraction | null> {
  try {
    return await extractor.extract(file, content);
  } catch {
    return null;
  }
}
