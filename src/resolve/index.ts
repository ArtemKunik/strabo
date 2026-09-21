import type { EdgeEvidence } from '../types.ts';

/** Extensions tried, in order, when resolving a relative specifier. */
export const SUPPORTED_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
] as const;

export interface ResolveContext {
  /** Repository-relative POSIX path of the importing file. */
  from: string;
  /** All retained repository-relative paths. */
  files: ReadonlySet<string>;
}

export interface ResolvedReference {
  target: string;
  evidence: EdgeEvidence;
}

/**
 * Resolve a relative specifier to an internal repository path.
 *
 * Exact path, then supported extensions, then index candidates. Bare package
 * specifiers are external and must not create internal graph edges.
 */
export function resolveRelative(
  specifier: string,
  line: number,
  context: ResolveContext,
): ResolvedReference | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return null;
  }
  // A leading `/` is repo-root-relative in bundler conventions (e.g. Vite/React
  // apps importing `/src/...`); relative to the importer it never resolves, so
  // the alias layer owns it. Guard here to keep this function purely relative.
  if (specifier.startsWith('/')) {
    return null;
  }
  return tryCandidates(normalize(fromDir(context.from), specifier), specifier, line, context.files, 'exact');
}

/**
 * Probe exact path, then supported extensions, then index candidates against
 * the retained file set. Shared by relative and alias resolution so both
 * report the same evidence shape.
 */
export function tryCandidates(
  base: string,
  specifier: string,
  line: number,
  files: ReadonlySet<string>,
  via: EdgeEvidence['resolution'],
): ResolvedReference | null {
  const candidates: Array<{ path: string; resolution: EdgeEvidence['resolution'] }> = [
    { path: base, resolution: via === 'exact' ? 'exact' : via },
    ...SUPPORTED_EXTENSIONS.map((extension) => ({
      path: `${base}${extension}`,
      resolution: (via === 'exact' ? 'extension' : via) as EdgeEvidence['resolution'],
    })),
    ...SUPPORTED_EXTENSIONS.map((extension) => ({
      path: `${base}/index${extension}`,
      resolution: (via === 'exact' ? 'index' : via) as EdgeEvidence['resolution'],
    })),
  ];

  for (const candidate of candidates) {
    if (files.has(candidate.path)) {
      return {
        target: candidate.path,
        evidence: { line, specifier, resolution: candidate.resolution },
      };
    }
  }
  return null;
}

/**
 * The repository-relative path a relative specifier names, normalised against the
 * importer but not checked against the file set (cf. `resolveRelative`).
 */
export function resolveTargetPath(from: string, specifier: string): string {
  return normalize(fromDir(from), specifier);
}

function fromDir(file: string): string {
  const index = file.lastIndexOf('/');
  return index === -1 ? '' : file.slice(0, index);
}

/** Resolve `specifier` against `base` and POSIX-normalise, collapsing `.` and `..`. */
export function normalize(base: string, specifier: string): string {
  const segments = `${base}/${specifier}`.split('/');
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}
