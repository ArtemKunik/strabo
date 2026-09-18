import fs from 'node:fs';
import path from 'node:path';

import { StraboScopeError, isInside } from './repository-root.ts';

/** Files/directories that suggest a directory is a repository worth offering. */
const REPOSITORY_MARKERS = [
  '.git',
  'package.json',
  'pom.xml',
  'build.gradle',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'tsconfig.json',
];

export interface DirectoryEntry {
  name: string;
  path: string;
  /** True when the directory looks like a repository root. */
  isRepository: boolean;
}

export interface BrowseResult {
  path: string;
  /** Parent directory, or null when the ceiling has been reached. */
  parent: string | null;
  ceiling: string;
  directories: DirectoryEntry[];
}

/**
 * List subdirectories of `requested` without leaving `ceiling`.
 *
 * This backs the folder-selection dialog. It is a read-only listing of directory names,
 * never file contents, and every path is containment-checked against the scan ceiling so
 * the dialog cannot expose the host filesystem beyond what the operator allowed.
 */
export function browseDirectories(options: { ceiling: string; requested?: string }): BrowseResult {
  const ceiling = path.resolve(options.ceiling);
  const target = path.resolve(options.requested?.trim() || ceiling);

  if (!isInside(target, ceiling)) {
    throw new StraboScopeError('Selected folder is outside the configured scan ceiling.');
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new StraboScopeError('Selected folder does not exist or is not a directory.');
  }

  const directories = fs
    .readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '.git')
    .map((entry) => {
      const full = path.join(target, entry.name);
      return { name: entry.name, path: full, isRepository: looksLikeRepository(full) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const parentCandidate = path.dirname(target);
  const parent = target !== ceiling && isInside(parentCandidate, ceiling) ? parentCandidate : null;

  return { path: target, parent, ceiling, directories };
}

function looksLikeRepository(directory: string): boolean {
  return REPOSITORY_MARKERS.some((marker) => fs.existsSync(path.join(directory, marker)));
}
