/**
 * Persist how the operator arranged the directory islands, per repository.
 *
 * The computed layout is deterministic, so a moved plate is a deliberate departure from it:
 * the offset from that layout is stored under a key naming the repository root, mirroring
 * `strabo.view.` for the other per-repository view preferences. Reading is defensive — the
 * value comes back from localStorage, so it is run through `normalizeIslandOffsets` before
 * it can move anything. A repository with no edits writes nothing, so the default layout
 * stays the default.
 */

import { normalizeIslandOffsets } from './strabo-islands.js';

export const ISLAND_LAYOUT_PREFIX = 'strabo.islands.';

export function islandLayoutKey(repository) {
  return `${ISLAND_LAYOUT_PREFIX}${repository ?? 'default'}`;
}

/** The recorded moves for a repository, or `{}` when there are none or the value is unusable. */
export function readIslandLayout(repository, storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(islandLayoutKey(repository));
    if (!raw) {
      return {};
    }
    return normalizeIslandOffsets(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * Store a repository's moves, dropping the key entirely when nothing is left moved.
 *
 * Returns the sanitized map so the caller keeps the same shape it persisted. A blocked
 * quota only costs persistence, never the in-memory arrangement.
 */
export function writeIslandLayout(repository, offsets, storage = globalThis.localStorage) {
  const normalized = normalizeIslandOffsets(offsets);
  try {
    if (Object.keys(normalized).length === 0) {
      storage?.removeItem(islandLayoutKey(repository));
    } else {
      storage?.setItem(islandLayoutKey(repository), JSON.stringify(normalized));
    }
  } catch {
    // Storage is optional; a blocked quota only costs persistence.
  }
  return normalized;
}
