import fs from 'node:fs';
import path from 'node:path';

import { resolveRepositoryRoot, StraboScopeError, type ResolvedRepository } from '../boundary/repository-root.ts';
import type { StraboConfig } from '../types.ts';

/** A workspace declared in the config file. Roots are resolved against the scan ceiling. */
export interface WorkspaceConfig {
  name: string;
  repositories: string[];
  /** Directory the config path was resolved against, for relative roots. */
  baseDir: string;
}

/**
 * Read the workspace config from `STRABO_CONFIG`.
 *
 * The config names the repositories explicitly; Strabo never discovers siblings on its own.
 * A malformed config is an error, not an empty workspace, because silently analyzing one
 * repository would hide the one the operator asked for.
 */
export function readWorkspaceConfig(configPath: string | undefined): WorkspaceConfig | null {
  if (!configPath || configPath.trim() === '') {
    return null;
  }
  const resolvedPath = path.resolve(configPath);
  let raw: string;
  try {
    raw = fs.readFileSync(resolvedPath, 'utf8');
  } catch {
    throw new StraboScopeError(`Could not read workspace config "${resolvedPath}".`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StraboScopeError(`Workspace config "${resolvedPath}" is not valid JSON.`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.repositories)) {
    throw new StraboScopeError(`Workspace config "${resolvedPath}" needs a repositories array.`);
  }
  const repositories = parsed.repositories.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
  );
  if (repositories.length === 0) {
    throw new StraboScopeError(`Workspace config "${resolvedPath}" lists no repositories.`);
  }
  const name =
    typeof parsed.name === 'string' && parsed.name.trim() !== ''
      ? parsed.name.trim()
      : path.basename(path.dirname(resolvedPath));
  return { name, repositories, baseDir: path.dirname(resolvedPath) };
}

/**
 * Resolve the workspace's repositories through the scan ceiling.
 *
 * Without a config the workspace is the single configured root, so every existing route
 * keeps working and the multi-repo behaviour is opt-in.
 */
export function resolveWorkspaceRepositories(config: StraboConfig): {
  name: string;
  repositories: ResolvedRepository[];
} {
  const ceiling = config.scanCeiling ?? config.workspaceRoot;
  const declared = readWorkspaceConfig(config.configPath);
  if (!declared) {
    const repository = resolveRepositoryRoot({
      workspaceRoot: config.workspaceRoot,
      scanCeiling: ceiling,
      requested: config.workspaceRoot,
    });
    return { name: repository.name, repositories: [repository] };
  }

  const seen = new Set<string>();
  const repositories: ResolvedRepository[] = [];
  for (const entry of declared.repositories) {
    const requested = path.isAbsolute(entry) ? entry : path.resolve(declared.baseDir, entry);
    const repository = resolveRepositoryRoot({
      workspaceRoot: config.workspaceRoot,
      scanCeiling: ceiling,
      requested,
    });
    if (seen.has(repository.root)) {
      continue;
    }
    seen.add(repository.root);
    repositories.push(repository);
  }
  return { name: declared.name, repositories };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
