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

/**
 * True when any path segment names a generated-output directory.
 *
 * References that point into build output (`../dist/cli.js`) name a directory the
 * scan excludes by design, so callers can treat them as out of scope instead of
 * reporting the target as a missing authored file.
 */
export function isGeneratedPath(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => GENERATED_DIRS.has(segment));
}

const FILENAME_MARKERS = [
  '.min.js',
  '.min.css',
  '.bundle.js',
  '.bundle.js.map',
  '.map',
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

/**
 * Dependency lockfiles: generated, high-volume, and rarely a review's subject.
 *
 * Kept apart from `classifyExclusion` on purpose. A lockfile is a legitimate input elsewhere
 * (dependency inventory reads it), so the scanner must still see it; only the change-oriented
 * views — review, the change passport, and the impact lists — drop it.
 */
const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
  'mix.lock',
  'pubspec.lock',
  'packages.lock.json',
  'Podfile.lock',
  'gradle.lockfile',
  'flake.lock',
  'paket.lock',
]);

/** Decide whether a path is a lockfile, and why. Returns null when it is retained. */
export function classifyLockfile(relativePath: string): Exclusion | null {
  const file = relativePath.split('/').at(-1) ?? relativePath;
  return LOCKFILES.has(file) ? { path: relativePath, reason: 'lockfile', detail: file } : null;
}

/**
 * The exclusion applied to change-oriented views: generated output first, then lockfiles.
 *
 * Narrower than the scanner's own `classifyExclusion` by design, so lockfiles stay visible to
 * dependency analysis while never reaching a review, passport, or impact list.
 */
export function classifyViewExclusion(relativePath: string): Exclusion | null {
  return classifyExclusion(relativePath) ?? classifyLockfile(relativePath);
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
