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
  const base = normalize(fromDir(context.from), specifier);

  const candidates: Array<{ path: string; resolution: EdgeEvidence['resolution'] }> = [
    { path: base, resolution: 'exact' },
    ...SUPPORTED_EXTENSIONS.map((extension) => ({
      path: `${base}${extension}`,
      resolution: 'extension' as const,
    })),
    ...SUPPORTED_EXTENSIONS.map((extension) => ({
      path: `${base}/index${extension}`,
      resolution: 'index' as const,
    })),
  ];

  for (const candidate of candidates) {
    if (context.files.has(candidate.path)) {
      return {
        target: candidate.path,
        evidence: { line, specifier, resolution: candidate.resolution },
      };
    }
  }
  return null;
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
