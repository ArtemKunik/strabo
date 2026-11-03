/**
 * Remove what Strabo's own cache and temp files leave behind.
 *
 * The cache directory also holds state by default (the repository list, settings, the narrator
 * key, check baselines), and `STRABO_CACHE_DIR` can name any directory. So a file is removed only
 * when its name matches a pattern below, never because it is old. Everything here can be rebuilt:
 * the worst a wrong removal costs is one rescan. A failed removal waits for the next sweep.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { stateRoot } from '../state/repository-store.ts';
import { CACHE_ARTIFACT_VERSION, cacheRoot, readArtifactRoot } from './graph-cache.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A write takes milliseconds, so a temporary file this old lost its process. */
const ABANDONED_WRITE_MS = HOUR_MS;
/** Revision checkouts and report files last as long as one request or command. */
const ABANDONED_TEMP_MS = DAY_MS;
/** Another installed version may still read its own artifact, so it gets a short grace period. */
const SUPERSEDED_MS = DAY_MS;
const CACHE_RETENTION_MS = 30 * DAY_MS;
/** Well past the response cache's own expiry, which callers can configure. */
const RISK_RETENTION_MS = 7 * DAY_MS;
const MAX_CACHE_BYTES = 1024 * 1024 * 1024;

/**
 * The per-repository caches. Group 1 is the root's hash, cut to the 16 characters the shorter
 * names carry, and it is what ties a repository's files together.
 */
const CACHE_FILE = /^strabo-(?:cache-.+|revision-graph-\d+|change-metrics-\d+)-([0-9a-f]{16})[0-9a-f]*\.json$/;
const GRAPH_FILE_PREFIX = 'strabo-cache-';
const ABANDONED_WRITE = /^strabo-.+\.json\.\d+\.tmp$/;
const RISK_FILE = /^[0-9a-f]{64}\.json(?:\.\d+\.tmp)?$/;
const TEMP_LEFTOVER = /^strabo-(?:rev-[A-Za-z0-9_-]{6}|report-\d+-\d+\.html)$/;

export interface SweepOptions {
  now?: number;
  cacheDir?: string;
  stateDir?: string;
  tempDir?: string;
  maxCacheBytes?: number;
}

interface Entry {
  name: string;
  file: string;
  mtimeMs: number;
  size: number;
}

function entriesOf(directory: string, pattern: RegExp): Entry[] {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return []; // Nothing written here yet.
  }
  return names.flatMap((name) => {
    if (!pattern.test(name)) return [];
    const file = path.join(directory, name);
    try {
      const { mtimeMs, size } = fs.statSync(file);
      return [{ name, file, mtimeMs, size }];
    } catch {
      return []; // Already gone.
    }
  });
}

function remove(file: string, removed: string[]): void {
  try {
    fs.rmSync(file, { recursive: true, force: true });
    removed.push(file);
  } catch {
    // Held open; the next sweep tries again.
  }
}

function rootKey(name: string): string {
  return CACHE_FILE.exec(name)?.[1] ?? '';
}

/** Hashes of the repositories whose directory is gone, from the root each graph records. */
function goneRepositories(entries: Entry[]): Set<string> {
  const gone = new Set<string>();
  for (const { name, file } of entries) {
    if (!name.startsWith(GRAPH_FILE_PREFIX)) continue;
    const root = readArtifactRoot(file);
    if (root !== null && !fs.existsSync(root)) gone.add(rootKey(name));
  }
  return gone;
}

function sweepRepositoryCaches(directory: string, now: number, maxBytes: number, removed: string[]): void {
  const entries = entriesOf(directory, CACHE_FILE);
  const gone = goneRepositories(entries);
  const kept: Entry[] = [];
  for (const entry of entries) {
    const superseded =
      entry.name.startsWith(GRAPH_FILE_PREFIX) && !entry.name.startsWith(`${CACHE_ARTIFACT_VERSION}-`);
    const retention = superseded ? SUPERSEDED_MS : CACHE_RETENTION_MS;
    if (gone.has(rootKey(entry.name)) || now - entry.mtimeMs > retention) {
      remove(entry.file, removed);
    } else {
      kept.push(entry);
    }
  }

  // Newest first, and the newest always stays: removing a repository's only artifact because it
  // alone exceeds the cap would only make the next request rebuild it.
  let total = 0;
  kept
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .forEach((entry, index) => {
      total += entry.size;
      if (index > 0 && total > maxBytes) remove(entry.file, removed);
    });
}

function removeOlderThan(entries: Entry[], maxAgeMs: number, now: number, removed: string[]): void {
  for (const entry of entries) {
    if (now - entry.mtimeMs > maxAgeMs) remove(entry.file, removed);
  }
}

/** Sweep the cache, the abandoned writes beside it and the state, and the OS temp directory. */
export function sweepCaches(options: SweepOptions = {}): string[] {
  const now = options.now ?? Date.now();
  const cacheDir = options.cacheDir ?? cacheRoot();
  const stateDir = options.stateDir ?? stateRoot();
  const tempDir = options.tempDir ?? os.tmpdir();
  const removed: string[] = [];

  sweepRepositoryCaches(cacheDir, now, options.maxCacheBytes ?? MAX_CACHE_BYTES, removed);
  for (const directory of new Set([cacheDir, stateDir])) {
    removeOlderThan(entriesOf(directory, ABANDONED_WRITE), ABANDONED_WRITE_MS, now, removed);
  }
  // Same location as `riskCacheDir`: the risk client sits above this tier.
  removeOlderThan(entriesOf(path.join(cacheDir, 'risk'), RISK_FILE), RISK_RETENTION_MS, now, removed);
  removeOlderThan(entriesOf(tempDir, TEMP_LEFTOVER), ABANDONED_TEMP_MS, now, removed);
  return removed;
}
