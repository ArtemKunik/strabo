import { readThroughGraphCache, type CacheOptions, type CachedGraph } from '../cache/graph-cache.ts';
import { scanRepository } from './scan.ts';

export type { CacheOptions, CachedGraph } from '../cache/graph-cache.ts';

/**
 * A repository's graph, read through the two-tier cache and scanned on a miss.
 *
 * The cache is the data tier and stores whatever scanner it is handed; this is where the
 * default scanner is chosen, so the dependency runs from the scanner down to its cache and
 * never from the cache up into the scanner. `options.scan` still overrides it for tests.
 */
export function getCachedGraph(root: string, options: CacheOptions = {}): Promise<CachedGraph> {
  return readThroughGraphCache(root, scanRepository, options);
}
