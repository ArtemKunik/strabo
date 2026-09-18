import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isInside } from '../boundary/repository-root.ts';

/**
 * A repository the operator has opened before.
 *
 * `lastOpenedAt` drives both ordering and the "remember the last one" default, so the
 * picker can reopen what was in use when the server last stopped.
 */
export interface KnownRepository {
  root: string;
  name: string;
  addedAt: string;
  lastOpenedAt: string | null;
}

export interface RepositoryStore {
  list(): KnownRepository[];
  get(root: string): KnownRepository | null;
  /** Add a repository, or touch `lastOpenedAt` when it is already known. */
  remember(root: string): KnownRepository;
  forget(root: string): boolean;
  /** The root to select on load, or null when nothing has been opened. */
  active(): string | null;
  setActive(root: string): void;
}

export const REPOSITORY_STORE_VERSION = 1;

interface StoreFile {
  version: number;
  active: string | null;
  repositories: KnownRepository[];
}

/**
 * Strabo's local state directory.
 *
 * State lives outside the scanned repository for the same reason the cache does: writing
 * it inside would dirty the working tree and make the scan fingerprint self-invalidating.
 */
function stateRoot(): string {
  const configured = process.env.STRABO_STATE_DIR?.trim() || process.env.STRABO_CACHE_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.tmpdir(), 'strabo-cache');
}

/** Path of the persisted repository list. Exposed for diagnostics and tests. */
export function repositoryStorePath(): string {
  return path.join(stateRoot(), 'strabo-repositories.json');
}

function emptyStore(): StoreFile {
  return { version: REPOSITORY_STORE_VERSION, active: null, repositories: [] };
}

function readStore(file: string): StoreFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoreFile>;
    if (parsed.version !== REPOSITORY_STORE_VERSION || !Array.isArray(parsed.repositories)) {
      return emptyStore();
    }
    const repositories = parsed.repositories.filter(
      (entry): entry is KnownRepository =>
        typeof entry?.root === 'string' && typeof entry?.name === 'string',
    );
    return {
      version: REPOSITORY_STORE_VERSION,
      active: typeof parsed.active === 'string' ? parsed.active : null,
      repositories,
    };
  } catch {
    // A missing or corrupt file is treated as an empty list, never an error.
    return emptyStore();
  }
}

/** Write through a temporary file and rename so readers never see a partial list. */
function writeStore(file: string, store: StoreFile): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(store, null, 2));
    fs.renameSync(temporary, file);
  } catch {
    // Persistence is best-effort and must never fail a request.
  }
}

/**
 * A small JSON-backed list of known repositories.
 *
 * The store is intentionally synchronous and dependency-free; it is read and written only
 * when the operator opens a repository or picks a different one.
 */
export function createRepositoryStore(options: { file?: string; now?: () => Date } = {}): RepositoryStore {
  const file = options.file ?? repositoryStorePath();
  const now = options.now ?? (() => new Date());

  const load = (): StoreFile => readStore(file);
  const save = (store: StoreFile): void => writeStore(file, store);

  const find = (store: StoreFile, root: string): KnownRepository | undefined => {
    const resolved = path.resolve(root);
    return store.repositories.find((entry) => entry.root === resolved);
  };

  return {
    list(): KnownRepository[] {
      return [...load().repositories].sort(
        (a, b) =>
          (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? '') || a.name.localeCompare(b.name),
      );
    },

    get(root: string): KnownRepository | null {
      return find(load(), root) ?? null;
    },

    remember(root: string): KnownRepository {
      const resolved = path.resolve(root);
      const store = load();
      const timestamp = now().toISOString();
      const existing = find(store, resolved);
      if (existing) {
        existing.lastOpenedAt = timestamp;
        existing.name = path.basename(resolved);
        save(store);
        return existing;
      }
      const entry: KnownRepository = {
        root: resolved,
        name: path.basename(resolved),
        addedAt: timestamp,
        lastOpenedAt: timestamp,
      };
      store.repositories.push(entry);
      save(store);
      return entry;
    },

    forget(root: string): boolean {
      const resolved = path.resolve(root);
      const store = load();
      const remaining = store.repositories.filter((entry) => entry.root !== resolved);
      if (remaining.length === store.repositories.length) {
        return false;
      }
      store.repositories = remaining;
      if (store.active === resolved) {
        store.active = remaining[0]?.root ?? null;
      }
      save(store);
      return true;
    },

    active(): string | null {
      return load().active;
    },

    setActive(root: string): void {
      const store = load();
      store.active = path.resolve(root);
      save(store);
    },
  };
}

/**
 * Known repositories that are still inside the scan ceiling.
 *
 * The store can outlive a ceiling change, and offering a repository that every request
 * would reject is worse than omitting it, so out-of-scope entries are filtered here.
 */
export function knownRepositoriesInside(store: RepositoryStore, ceiling: string): KnownRepository[] {
  return store.list().filter((entry) => isInside(entry.root, ceiling));
}
