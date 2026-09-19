import fs from 'node:fs';
import path from 'node:path';

import { toPosix } from '../boundary/repository-root.ts';
import type { Diagnostic, Exclusion, ExternalImport, Graph, GraphNode, ScanReport } from '../types.ts';
import { classifyExclusion, excludedDirectory, looksMinified } from './exclusions.ts';
import { collectPolyglotExternalImports } from './external-polyglot.ts';
import { findGitIgnoredFiles } from './gitignore.ts';
import { scanJsTsEdges } from './scan-js.ts';
import { isPolyglotSource, scanPolyglotEdges } from './scan-polyglot.ts';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

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

  const candidates = collectSourceFiles(root, excluded);
  const ignored = await findGitIgnoredFiles(root, candidates);
  const retained = candidates.filter((file) => {
    if (ignored.has(file)) {
      excluded.push({ path: file, reason: 'gitignored' });
      return false;
    }
    return true;
  });

  const contentByFile = new Map<string, string>();
  const extensionCounts: Record<string, number> = {};
  const unsupportedExtensionCounts: Record<string, number> = {};
  const parseFailures: Diagnostic[] = [];

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
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      excluded.push({ path: file, reason: 'unsupported', detail: 'file too large' });
      continue;
    }
    const content = fs.readFileSync(absolute, 'utf8');
    if (looksMinified(content)) {
      excluded.push({ path: file, reason: 'minified' });
      continue;
    }
    contentByFile.set(file, content);
    extensionCounts[extension] = (extensionCounts[extension] ?? 0) + 1;
  }

  const files = [...contentByFile.keys()].sort();
  const nodes: GraphNode[] = files.map((id) => ({
    id,
    kind: isTestLike(id) ? 'test' : 'module',
    directory: directoryOf(id),
  }));

  const [jsScan, polyglot] = await Promise.all([
    Promise.resolve(scanJsTsEdges(files, contentByFile, { root })),
    scanPolyglotEdges(files.filter(isPolyglotSource), contentByFile),
  ]);

  const externalImports: ExternalImport[] = [
    ...jsScan.externalImports,
    ...collectPolyglotExternalImports(files, contentByFile),
  ];

  const diagnostics = [...parseFailures, ...jsScan.diagnostics, ...polyglot.diagnostics];
  const graph: Graph = {
    nodes,
    edges: [...jsScan.edges, ...polyglot.edges],
    diagnostics,
    excluded,
    externalImports,
  };

  return {
    graph,
    extensionCounts,
    unsupportedExtensionCounts,
    parseFailures: parseFailures.length,
    unresolvedReferences: diagnostics.filter((item) => item.kind === 'unresolved').length,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

/** Walk the root, skipping symbolic links, and record exclusion reasons. */
export function collectSourceFiles(root: string, excluded: Exclusion[]): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
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
          excluded.push({ path: `${relative}/`, reason: 'generated', detail: `${prune}/` });
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
 *
 * COBOL and ABL are out of scope for now, so their extensions are deliberately absent.
 */
const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.java', '.kt', '.kts',
  '.cs',
  '.rs',
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
