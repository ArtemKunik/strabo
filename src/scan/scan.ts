import fs from 'node:fs';
import path from 'node:path';

import { toPosix } from '../boundary/repository-root.ts';
import type { Diagnostic, Exclusion, ExternalImport, Graph, GraphNode, ScanReport } from '../types.ts';
import { classifyExclusion, excludedDirectory, looksMinified } from './exclusions.ts';
import { collectPolyglotExternalImports } from './external-polyglot.ts';
import { detectEntryPoints } from './entry-points.ts';
import { findGitIgnoredFiles } from './gitignore.ts';
import { scanJsTsCalls } from './calls.ts';
import { scanJsTsEdges } from './scan-js.ts';
import { isPolyglotSource, scanPolyglotEdges } from './scan-polyglot.ts';

/**
 * Files larger than this are mapped but not parsed: their line count is recorded and a
 * diagnostic says parsing was skipped, so a very large authored file is still visible on
 * the diagram instead of vanishing from it. Content is retained only below this bound, so
 * a multi-megabyte file cannot sit in the parse working set.
 */
export const MAX_PARSE_BYTES = 2 * 1024 * 1024;

/**
 * The hard ceiling: past this a file is not mapped at all.
 *
 * A file this large is far more likely to be a generated or binary blob than authored
 * source, and reading it would cost more than it explains.
 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export type FileSizeClass = 'parse' | 'node-only' | 'exclude';

/** Decide how a file's byte size is handled: parsed, mapped without parsing, or dropped. */
export function classifyFileSize(bytes: number): FileSizeClass {
  if (!Number.isFinite(bytes) || bytes > MAX_FILE_BYTES) {
    return 'exclude';
  }
  if (bytes > MAX_PARSE_BYTES) {
    return 'node-only';
  }
  return 'parse';
}

/**
 * Produce the repository file graph:
 *
 * 1. collect source files (skipping symlinks, recording exclusions)
 * 2. remove git-ignored candidates and sort for determinism
 * 3. read retained UTF-8 content once, excluding minified bundles
 * 4. emit one node per retained path
 * 5. run JS/TS and polyglot edge extraction concurrently
 * 6. return nodes, edges, extension counts, diagnostics, and exclusions
 */
export async function scanRepository(root: string): Promise<ScanReport> {
  const startedAt = Date.now();
  const excluded: Exclusion[] = [];
  const diagnostics: Diagnostic[] = [];
  const candidates = collectSourceFiles(root, excluded, diagnostics);
  const ignored = await findGitIgnoredFiles(root, candidates);
  const retained = candidates.filter((file) => {
    if (ignored.has(file)) {
      excluded.push({ path: file, reason: 'gitignored' });
      return false;
    }
    return true;
  });

  const contentByFile = new Map<string, string>();
  const linesByFile = new Map<string, number>();
  const nodeFiles: string[] = [];
  const extensionCounts: Record<string, number> = {};
  const unsupportedExtensionCounts: Record<string, number> = {};

  for (const file of retained) {
    const extension = extensionOf(file);
    if (!isSourceExtension(file)) {
      unsupportedExtensionCounts[extension] = (unsupportedExtensionCounts[extension] ?? 0) + 1;
      excluded.push({ path: file, reason: 'unsupported', detail: extension });
      continue;
    }
    const absolute = path.join(root, file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      diagnostics.push({
        file,
        line: 1,
        message: `Could not stat file; skipped.`,
        severity: 'warning',
        kind: 'read-failure',
      });
      continue;
    }
    const sizeClass = classifyFileSize(stat.size);
    if (sizeClass === 'exclude') {
      excluded.push({ path: file, reason: 'unsupported', detail: 'file too large' });
      continue;
    }
    let content: string;
    try {
      content = fs.readFileSync(absolute, 'utf8');
    } catch {
      diagnostics.push({
        file,
        line: 1,
        message: `Could not read file; skipped.`,
        severity: 'warning',
        kind: 'read-failure',
      });
      continue;
    }
    if (looksMinified(content)) {
      excluded.push({ path: file, reason: 'minified' });
      continue;
    }
    linesByFile.set(file, countLines(content));
    nodeFiles.push(file);
    extensionCounts[extension] = (extensionCounts[extension] ?? 0) + 1;
    if (sizeClass === 'parse') {
      contentByFile.set(file, content);
    } else {
      // Mapped, but too large to keep in the parse working set: report that its imports and
      // calls were not read rather than silently presenting it as a file with no edges.
      diagnostics.push({
        file,
        line: 1,
        message: `File is larger than ${Math.round(MAX_PARSE_BYTES / (1024 * 1024))} MB; it is mapped by line count but its imports and calls were not parsed.`,
        severity: 'info',
        kind: 'unsupported',
      });
    }
  }

  const files = nodeFiles.sort();
  // Only files whose content was retained can be parsed; `files` stays the full node set so
  // an import of a large file still resolves to it instead of reading as unresolved.
  const parseFiles = [...contentByFile.keys()].sort();
  const entryByFile = new Map(detectEntryPoints(root, files).map((entry) => [entry.file, entry.reason]));
  const nodes: GraphNode[] = files.map((id) => ({
    id,
    // A test-like path stays a test even if a manifest names it; coverage and the tests
    // strip key off `kind === 'test'`, so that classification must not be displaced.
    kind: isTestLike(id) ? 'test' : entryByFile.has(id) ? 'entry' : 'module',
    directory: directoryOf(id),
    ...(entryByFile.has(id) ? { entryReason: entryByFile.get(id) as string } : {}),
    lines: linesByFile.get(id) ?? 0,
  }));

  const [jsScan, polyglot, calls] = await Promise.all([
    scanJsTsEdges(files, contentByFile, { root }),
    scanPolyglotEdges(parseFiles.filter(isPolyglotSource), contentByFile),
    scanJsTsCalls(files, contentByFile, { root }),
  ]);

  const externalImports: ExternalImport[] = [
    ...jsScan.externalImports,
    ...collectPolyglotExternalImports(parseFiles, contentByFile, diagnostics),
  ];

  const graphDiagnostics = [...diagnostics, ...jsScan.diagnostics, ...polyglot.diagnostics];

  // Call edges are appended last: they always parallel an import edge, and a consumer that
  // keeps the first edge per pair (block roll-up) must keep the import, not the call.
  const graph: Graph = {
    nodes,
    edges: [...jsScan.edges, ...polyglot.edges, ...calls.edges],
    diagnostics: graphDiagnostics,
    excluded,
    externalImports,
  };

  return {
    graph,
    extensionCounts,
    unsupportedExtensionCounts,
    parseFailures: graphDiagnostics.filter((item) => item.kind === 'parse-failure').length,
    unresolvedReferences: graphDiagnostics.filter((item) => item.kind === 'unresolved').length,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

/** Lines as an editor numbers them: a trailing newline does not start another line. */
export function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  let count = 1;
  for (let index = content.indexOf('\n'); index !== -1; index = content.indexOf('\n', index + 1)) {
    count += 1;
  }
  return content.endsWith('\n') ? count - 1 : count;
}

/** Walk the root, skipping symbolic links, and record exclusion reasons. */
export function collectSourceFiles(root: string, excluded: Exclusion[], diagnostics: Diagnostic[]): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      diagnostics.push({
        file: directory,
        line: 1,
        message: `Could not read directory; skipped its contents.`,
        severity: 'warning',
        kind: 'read-failure',
      });
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = toPosix(path.relative(root, absolute));
      if (entry.isSymbolicLink()) {
        excluded.push({ path: relative, reason: 'symlink' });
        continue;
      }
      if (entry.isDirectory()) {
        const prune = excludedDirectory(relative);
        if (prune) {
          excluded.push({ path: `${relative}/`, reason: prune.reason, detail: prune.detail });
          continue;
        }
        walk(absolute);
        continue;
      }
      const exclusion = classifyExclusion(relative);
      if (exclusion) {
        excluded.push(exclusion);
        continue;
      }
      files.push(relative);
    }
  };
  walk(root);
  return files.sort();
}

export function extensionOf(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '<none>' : base.slice(dot).toLowerCase();
}

/**
 * Authored source languages supported by Strabo. Everything else is a non-source file
 * and is reported as an exclusion rather than turned into a node.
 */
const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.java', '.kt', '.kts',
  '.cs',
  '.rs',
  '.py',
  '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h',
  '.sql',
]);

export function isSourceExtension(file: string): boolean {
  return SOURCE_EXTENSIONS.has(extensionOf(file));
}

export function directoryOf(file: string): string {
  const index = file.lastIndexOf('/');
  return index === -1 ? '.' : file.slice(0, index);
}

export function isTestLike(file: string): boolean {
  const lower = file.toLowerCase();
  return (
    /(^|\/)(__tests__|tests?|specs?)(\/|$)/.test(lower) ||
    /\.(test|spec)\.[^.]+$/.test(lower) ||
    /(^|\/)(test|spec)_/.test(lower) ||
    /(^|\/)test-/i.test(lower)
  );
}
