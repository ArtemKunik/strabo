import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ScanReport } from '../types.ts';
import { run } from '../process.ts';

/**
 * Bump the number when the on-disk artifact shape changes. The package version is part of
 * the key as well, so an upgrade never serves a graph that older scanners or resolvers
 * produced just because nobody remembered to bump the number.
 */
export const CACHE_ARTIFACT_VERSION = `strabo-cache-6+${packageVersion()}`;

function packageVersion(): string {
  try {
    const manifest = new URL('../../package.json', import.meta.url);
    return (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version?: string }).version ?? 'dev';
  } catch {
    return 'dev';
  }
}
export const MEMORY_TTL_MS = 60_000;

export type ScanFn = (root: string) => Promise<ScanReport>;

export interface CachedGraph {
  report: ScanReport;
  status: 'memory' | 'disk' | 'refreshed' | 'miss';
  fingerprint: string | null;
  /** True when a stale entry was served while a refresh runs in the background. */
  stale?: boolean;
}

export interface CacheOptions {
  /** Bypass both tiers and force a new scan. */
  refresh?: boolean;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Injectable scanner. The cache never picks one itself: the data tier does not reach up
   * into the scanner, so `getCachedGraph` in `src/scan/graph.ts` supplies the default.
   */
  scan?: ScanFn;
}

interface MemoryEntry {
  fingerprint: string | null;
  expiresAt: number;
  report: ScanReport;
}

const memory = new Map<string, MemoryEntry>();
const inflight = new Map<string, Promise<ScanReport>>();

/**
 * Artifacts live outside the scanned repository.
 *
 * Writing them inside the repo would make the cache self-invalidating: the new
 * untracked directory changes `git status`, which is part of the fingerprint. It would
 * also dirty the working tree of the repository being inspected.
 */
export function cacheRoot(): string {
  const configured = process.env.STRABO_CACHE_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.tmpdir(), 'strabo-cache');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function artifactPath(root: string): string {
  return path.join(cacheRoot(), `${CACHE_ARTIFACT_VERSION}-${hash(path.resolve(root))}.json`);
}

/** Path of the persisted artifact for a root. Exposed for diagnostics and tests. */
export function cacheArtifactPath(root: string): string {
  return artifactPath(root);
}

/** Past this many changed paths the per-file stat is skipped; Refresh remains the remedy. */
const MAX_STATTED_CHANGES = 5_000;

/**
 * HEAD, `git status --porcelain`, and the size and mtime of every changed path.
 *
 * Status alone cannot see a second edit to a file that is already listed as modified — the
 * status line does not change, so the map and the freshness badge kept claiming a graph that
 * was out of date. Statting each listed path closes that: saving the file moves its mtime.
 * Untracked files are listed one by one (`-uall`) so an edit inside a new directory counts too.
 */
export async function fingerprint(root: string): Promise<string | null> {
  try {
    const [{ stdout: revParse }, { stdout: status }] = await Promise.all([
      run('git', ['rev-parse', 'HEAD', '--show-toplevel'], { cwd: root }),
      run('git', ['status', '--porcelain', '-uall'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }),
    ]);
    const [head = '', topLevel = root] = revParse.split('\n').map((line) => line.trim());
    const changed = await statChangedPaths(topLevel, status);
    return `${head}:${hash(`${status.trim()}\n${changed}`)}`;
  } catch {
    return null;
  }
}

/** `size:mtime` for each path in porcelain output (paths are relative to the top level). */
async function statChangedPaths(topLevel: string, status: string): Promise<string> {
  const paths = status
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => {
      const entry = line.slice(3);
      const renamed = entry.lastIndexOf(' -> ');
      const target = renamed === -1 ? entry : entry.slice(renamed + 4);
      return target.startsWith('"') ? target.slice(1, -1) : target;
    });
  if (paths.length > MAX_STATTED_CHANGES) {
    return '';
  }
  const stamps = await Promise.all(
    paths.map(async (relative) => {
      try {
        const stat = await fs.promises.stat(path.join(topLevel, relative));
        return `${stat.size}:${stat.mtimeMs}`;
      } catch {
        return '-';
      }
    }),
  );
  return stamps.join('\n');
}

/**
 * Resolve a graph through the two-tier cache.
 *
 * The in-memory entry is accepted only when its fingerprint matches and its TTL is
 * unexpired; otherwise the artifact is accepted only when version, root, and
 * fingerprint all match. A matching artifact past the memory TTL is returned while a
 * background scan refreshes it.
 */
export async function readThroughGraphCache(
  root: string,
  defaultScan: ScanFn,
  options: CacheOptions = {},
): Promise<CachedGraph> {
  const now = options.now ?? Date.now;
  const scan = options.scan ?? defaultScan;
  const current = await fingerprint(root);

  if (options.refresh) {
    const report = await refreshGraph(root, current, scan, now);
    return { report, status: 'refreshed', fingerprint: current };
  }

  const entry = memory.get(root);
  if (entry && entry.fingerprint === current && entry.expiresAt > now()) {
    return { report: entry.report, status: 'memory', fingerprint: current };
  }

  const artifact = readArtifact(root, current);
  if (artifact) {
    const expired = entry !== undefined && entry.fingerprint === current && entry.expiresAt <= now();
    memory.set(root, { fingerprint: current, expiresAt: now() + MEMORY_TTL_MS, report: artifact });
    if (expired) {
      void refreshGraph(root, current, scan, now).catch(() => undefined);
      return { report: artifact, status: 'disk', fingerprint: current, stale: true };
    }
    return { report: artifact, status: 'disk', fingerprint: current };
  }

  const report = await refreshGraph(root, current, scan, now);
  return { report, status: 'miss', fingerprint: current };
}

/** Coalesce concurrent refreshes so one user request does not duplicate parser work. */
function refreshGraph(
  root: string,
  currentFingerprint: string | null,
  scan: ScanFn,
  now: () => number,
): Promise<ScanReport> {
  const existing = inflight.get(root);
  if (existing) {
    return existing;
  }
  const task = scan(root)
    .then((report) => {
      memory.set(root, {
        fingerprint: currentFingerprint,
        expiresAt: now() + MEMORY_TTL_MS,
        report,
      });
      if (currentFingerprint !== null) {
        writeArtifact(root, currentFingerprint, report);
      }
      return report;
    })
    .finally(() => {
      inflight.delete(root);
    });
  inflight.set(root, task);
  return task;
}

function readArtifact(root: string, currentFingerprint: string | null): ScanReport | null {
  if (currentFingerprint === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(artifactPath(root), 'utf8')) as {
      version: string;
      root: string;
      fingerprint: string;
      report: ScanReport;
    };
    if (
      parsed.version === CACHE_ARTIFACT_VERSION &&
      parsed.root === path.resolve(root) &&
      parsed.fingerprint === currentFingerprint
    ) {
      return parsed.report;
    }
  } catch {
    return null;
  }
  return null;
}

/** Write through a temporary file and rename so readers never see a partial artifact. */
function writeArtifact(root: string, currentFingerprint: string, report: ScanReport): void {
  try {
    fs.mkdirSync(cacheRoot(), { recursive: true });
    const target = artifactPath(root);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(
      temporary,
      JSON.stringify({
        version: CACHE_ARTIFACT_VERSION,
        root: path.resolve(root),
        fingerprint: currentFingerprint,
        report,
      }),
    );
    fs.renameSync(temporary, target);
  } catch {
    // Cache persistence is best-effort and must never fail a scan.
  }
}

export function clearMemoryCache(root?: string): void {
  if (root) {
    memory.delete(root);
  } else {
    memory.clear();
  }
}

/** Remove persisted artifacts. Intended for tests and administrative resets. */
export function clearDiskCache(root?: string): void {
  if (root) {
    fs.rmSync(artifactPath(root), { force: true });
    return;
  }
  fs.rmSync(cacheRoot(), { recursive: true, force: true });
}
