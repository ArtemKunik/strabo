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
  'bin',
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

/** Decide whether a directory should be pruned during the walk, and why. */
export function excludedDirectory(relativePath: string): string | null {
  const segments = relativePath.split('/').filter(Boolean);
  return segments.find((segment) => GENERATED_DIRS.has(segment)) ?? null;
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
