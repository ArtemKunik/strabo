import type { Exclusion } from '../types.ts';

const GENERATED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'vendor',
  'third_party',
  // `obj` is .NET build output, but `bin` is kept: a JS `bin/` launcher is authored
  // source (and a .NET `bin/` holds no source extensions anyway), so excluding it
  // would hide the package's own entry point from the scan.
  'obj',
]);

const FILENAME_MARKERS = [
  '.min.js',
  '.min.css',
  '.bundle.js',
  '.generated.ts',
  '.g.ts',
  '.designer.cs',
];

/** Decide whether a path is excluded, and why. Returns null when it is retained. */
export function classifyExclusion(relativePath: string): Exclusion | null {
  const segments = relativePath.split('/');
  const directory = segments.slice(0, -1).find((segment) => GENERATED_DIRS.has(segment));
  if (directory) {
    return { path: relativePath, reason: 'generated', detail: `${directory}/` };
  }
  const file = segments.at(-1) ?? relativePath;
  const marker = FILENAME_MARKERS.find((candidate) => file.endsWith(candidate));
  if (marker) {
    return { path: relativePath, reason: 'generated', detail: marker };
  }
  return null;
}

/** Why a directory was pruned, and the marker that matched it. */
export interface DirectoryExclusion {
  reason: Exclusion['reason'];
  detail: string;
}

/**
 * Decide whether a directory should be pruned during the walk, and why.
 *
 * Conventional fixture corpora (`test/fixtures`, `tests/fixtures`, `__fixtures__`) are
 * pruned as `fixture` rather than `generated`: they are authored, not built, so labelling
 * them generated would misstate the evidence. A repository scanned with a fixture
 * directory as its own root still maps that corpus, because the marker never matches
 * above the root.
 */
export function excludedDirectory(relativePath: string): DirectoryExclusion | null {
  const segments = relativePath.split('/').filter(Boolean);
  const generated = segments.find((segment) => GENERATED_DIRS.has(segment));
  if (generated) {
    return { reason: 'generated', detail: `${generated}/` };
  }
  const last = segments.at(-1);
  if (last === '__fixtures__') {
    return { reason: 'fixture', detail: '__fixtures__/' };
  }
  const parent = segments.at(-2);
  if (last === 'fixtures' && (parent === 'test' || parent === 'tests')) {
    return { reason: 'fixture', detail: `${parent}/fixtures/` };
  }
  return null;
}

/** Heuristic for bundled/minified content that should not be mapped. */
export function looksMinified(content: string): boolean {
  const newlineCount = content.split('\n').length;
  if (content.length > 0 && newlineCount > 0) {
    const averageLineLength = content.length / newlineCount;
    if (averageLineLength > 500 && content.length > 4096) {
      return true;
    }
  }
  return false;
}
