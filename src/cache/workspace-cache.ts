import fs from 'node:fs';
import path from 'node:path';

import type {
  CodeDataUse,
  ContractDefinition,
  PublishedCoordinate,
  SchemaSnapshot,
  ServiceCall,
  ServiceEndpoint,
} from '../types.ts';
import { cacheRoot } from './graph-cache.ts';

export const WORKSPACE_CACHE_VERSION = 'strabo-workspace-5';

/** The per-repository facts that are expensive to recompute and cheap to store. */
export interface CachedRepoFacts {
  publishes: PublishedCoordinate | null;
  contracts: ContractDefinition[];
  endpoints: ServiceEndpoint[];
  calls: ServiceCall[];
  /** The schema the repository's SQL files describe, or null when it has none. */
  schema: SchemaSnapshot | null;
  /** Tables and columns the repository's source code names. */
  dataUses: CodeDataUse[];
}

interface StoreEntry extends CachedRepoFacts {
  fingerprint: string;
}

interface StoreFile {
  version: string;
  entries: Record<string, StoreEntry>;
}

export interface WorkspaceCache {
  /** Cached facts for a root, or null when the fingerprint is new, absent, or unknown. */
  get(root: string, fingerprint: string | null): CachedRepoFacts | null;
  set(root: string, fingerprint: string | null, facts: CachedRepoFacts): void;
  /** Persist once after a batch of get/set calls. A no-op when nothing changed. */
  save(): void;
}

/**
 * Path of the workspace fact cache, beside the graph cache.
 *
 * It is keyed per root and per git fingerprint, so a repository is re-extracted only when
 * its graph would have been rescanned. A root with no fingerprint (not a git repository)
 * is never stored rather than stored under a key that cannot be checked.
 */
export function workspaceCachePath(): string {
  return path.join(cacheRoot(), 'strabo-workspace.json');
}

export function openWorkspaceCache(options: { file?: string } = {}): WorkspaceCache {
  const file = options.file ?? workspaceCachePath();
  const store = readStore(file);
  let dirty = false;

  return {
    get(root: string, fingerprint: string | null): CachedRepoFacts | null {
      if (fingerprint === null) {
        return null;
      }
      const entry = store.entries[path.resolve(root)];
      if (!entry || entry.fingerprint !== fingerprint) {
        return null;
      }
      return {
        publishes: entry.publishes,
        contracts: entry.contracts,
        endpoints: entry.endpoints,
        calls: entry.calls,
        schema: entry.schema,
        dataUses: entry.dataUses,
      };
    },

    set(root: string, fingerprint: string | null, facts: CachedRepoFacts): void {
      if (fingerprint === null) {
        return;
      }
      store.entries[path.resolve(root)] = {
        fingerprint,
        publishes: facts.publishes,
        contracts: facts.contracts,
        endpoints: facts.endpoints,
        calls: facts.calls,
        schema: facts.schema,
        dataUses: facts.dataUses,
      };
      dirty = true;
    },

    save(): void {
      if (!dirty) {
        return;
      }
      writeStore(file, store);
      dirty = false;
    },
  };
}

/** Remove the persisted workspace cache. Intended for tests and administrative resets. */
export function clearWorkspaceCache(file = workspaceCachePath()): void {
  fs.rmSync(file, { force: true });
}

function emptyStore(): StoreFile {
  return { version: WORKSPACE_CACHE_VERSION, entries: {} };
}

function readStore(file: string): StoreFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoreFile>;
    if (parsed.version !== WORKSPACE_CACHE_VERSION || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return emptyStore();
    }
    const entries: Record<string, StoreEntry> = {};
    for (const [root, entry] of Object.entries(parsed.entries)) {
      if (
        typeof entry?.fingerprint !== 'string' ||
        !Array.isArray(entry?.contracts) ||
        !Array.isArray(entry?.endpoints) ||
        !Array.isArray(entry?.calls)
      ) {
        continue;
      }
      entries[root] = {
        fingerprint: entry.fingerprint,
        publishes: isCoordinate(entry.publishes) ? entry.publishes : null,
        contracts: entry.contracts,
        endpoints: entry.endpoints,
        calls: entry.calls,
        schema: isSchema(entry.schema) ? entry.schema : null,
        dataUses: Array.isArray(entry.dataUses) ? entry.dataUses : [],
      };
    }
    return { version: WORKSPACE_CACHE_VERSION, entries };
  } catch {
    // A missing or corrupt cache is an empty cache, never an error.
    return emptyStore();
  }
}

function writeStore(file: string, store: StoreFile): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(store));
    fs.renameSync(temporary, file);
  } catch {
    // Persistence is best-effort and must never fail an analysis.
  }
}

function isCoordinate(value: unknown): value is PublishedCoordinate {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PublishedCoordinate).ecosystem === 'string' &&
    typeof (value as PublishedCoordinate).name === 'string' &&
    typeof (value as PublishedCoordinate).source === 'string'
  );
}

function isSchema(value: unknown): value is SchemaSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as SchemaSnapshot).tables) &&
    Array.isArray((value as SchemaSnapshot).files)
  );
}
