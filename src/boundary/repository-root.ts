import fs from 'node:fs';
import path from 'node:path';

export interface ResolveRepositoryOptions {
  workspaceRoot: string;
  scanCeiling: string;
  /** A configured repository name, a registered checkout, or an allowed path. */
  requested?: string;
  /** Path to a config file describing configured repositories, when present. */
  configPath?: string;
}

export interface ResolvedRepository {
  name: string;
  root: string;
  /** Workspace-relative root, POSIX-normalised, for presentation. */
  workspaceRoot: string;
}

/**
 * The sole route-level resolution boundary.
 *
 * The resolved root must be inside `scanCeiling`, checked with path-relative
 * containment rather than prefix matching.
 */
export function resolveRepositoryRoot(options: ResolveRepositoryOptions): ResolvedRepository {
  const ceiling = path.resolve(options.scanCeiling);
  const requested = options.requested?.trim() || options.workspaceRoot;
  const candidate = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(options.workspaceRoot, requested);

  if (!isInside(candidate, ceiling)) {
    throw new StraboScopeError(
      `Repository "${requested}" is outside the configured scan ceiling.`,
    );
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    throw new StraboScopeError(`Repository "${requested}" does not exist or is not a directory.`);
  }

  return {
    name: path.basename(candidate),
    root: candidate,
    workspaceRoot: toPosix(path.relative(path.resolve(options.workspaceRoot), candidate)) || '.',
  };
}

/** Path-relative containment check: `child` is inside `parent` or is `parent` itself. */
export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Containment check used before any file drill-down read. */
export function assertReadable(root: string, target: string): string {
  const resolved = path.resolve(root, target);
  if (!isInside(resolved, root)) {
    throw new StraboScopeError(`Path "${target}" escapes the repository root.`);
  }
  return resolved;
}

export class StraboScopeError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'StraboScopeError';
  }
}

export function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}
