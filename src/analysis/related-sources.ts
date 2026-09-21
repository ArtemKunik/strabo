import fs from 'node:fs';

import { assertReadable } from '../boundary/repository-root.ts';
import type { Graph } from '../types.ts';

/** Most dependencies read for one extraction, so a widely-including file stays cheap. */
const DEFAULT_LIMIT = 25;

/** Largest dependency read, so one generated header cannot stall the request. */
const MAX_BYTES = 512 * 1024;

/**
 * Read the sources a file provably depends on, for languages that split a type across files.
 *
 * The dependencies come from the graph's own edges, so nothing here searches, guesses a
 * path, or widens what may be read: every target is a file the scan already resolved inside
 * the repository, and each is re-checked against the scan ceiling before it is opened. A
 * dependency that cannot be read, or is larger than the cap, is skipped rather than failing
 * the extraction — its declarations are simply not available, which the caller reports as
 * absent rather than as an empty class.
 */
export function collectRelatedSources(
  root: string,
  graph: Graph,
  file: string,
  limit: number = DEFAULT_LIMIT,
): Map<string, string> {
  const related = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.source !== file || related.has(edge.target)) {
      continue;
    }
    if (related.size >= limit) {
      break;
    }
    try {
      const resolved = assertReadable(root, edge.target);
      if (fs.statSync(resolved).size > MAX_BYTES) {
        continue;
      }
      related.set(edge.target, fs.readFileSync(resolved, 'utf8'));
    } catch {
      // A dependency that cannot be read contributes no declarations.
    }
  }
  return related;
}
