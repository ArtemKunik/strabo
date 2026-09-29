import { createHash } from 'node:crypto';

/**
 * A per-file extraction cache keyed by content hash (Phase 18 P5).
 *
 * Parsing is the dominant cost of a scan, and a rescan touches few files: this caches the
 * extract result of one file so an unchanged file is not re-parsed. The key is the SHA-256 of
 * the file's content plus an extractor version, so a grammar or rule change invalidates every
 * entry rather than serving a stale fact. The store is in memory for the process's life; it is
 * not persisted, because the whole-graph cache already avoids a rescan and a stale on-disk
 * parse cache would be harder to invalidate than to rebuild.
 *
 * Only pure-within-a-content extractions are cached: the JS/TS reference read and each
 * language's tree-sitter facts. Resolution (joining a file to the rest of the set) is not
 * cached here, because it depends on the whole file set, which changes between scans.
 */

/** Bump when the extractor rules or a grammar change, so every cached entry is invalidated. */
export const PARSE_CACHE_VERSION = 1;

/** A capped LRU so a huge monorepo does not grow the cache without bound. */
const MAX_ENTRIES = 200_000;

interface Entry<T> {
  value: T;
  /** Insertion order token, for eviction when the cap is reached. */
  serial: number;
}

const store = new Map<string, Entry<unknown>>();
let serial = 0;
let hits = 0;
let misses = 0;

/** The cache key for one extractor result: version, namespace (language), and content hash. */
export function parseCacheKey(namespace: string, content: string): string {
  const hash = createHash('sha256').update(content).digest('hex');
  return `${PARSE_CACHE_VERSION}:${namespace}:${hash}`;
}

/**
 * Return the cached extraction for a key, running `produce` on a miss.
 *
 * A miss stores the result under the cap; the least-recently-inserted entry is evicted when
 * the store is full, so memory stays bounded and the hottest recent files survive.
 */
export async function withParseCache<T>(
  key: string,
  produce: () => Promise<T> | T,
): Promise<T> {
  const cached = store.get(key);
  if (cached) {
    hits += 1;
    return cached.value as T;
  }
  misses += 1;
  const value = await produce();
  store.set(key, { value, serial: (serial += 1) });
  if (store.size > MAX_ENTRIES) {
    evictOldest();
  }
  return value;
}

/** Drop the oldest entries until the store is back under the cap. */
function evictOldest(): void {
  const excess = store.size - MAX_ENTRIES;
  if (excess <= 0) {
    return;
  }
  // `Map` iterates in insertion order, so the first `excess` keys are the oldest.
  let removed = 0;
  for (const key of store.keys()) {
    store.delete(key);
    removed += 1;
    if (removed >= excess) {
      break;
    }
  }
}

/** Cache hit/miss counts, for the benchmark and a test. */
export function parseCacheStats(): { size: number; hits: number; misses: number } {
  return { size: store.size, hits, misses };
}

/** Clear the cache and its counters; tests call this so one case cannot read another's. */
export function clearParseCache(): void {
  store.clear();
  serial = 0;
  hits = 0;
  misses = 0;
}
