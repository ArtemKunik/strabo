import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import {
  CACHE_ARTIFACT_VERSION,
  MEMORY_TTL_MS,
  cacheArtifactPath,
  clearDiskCache,
  clearMemoryCache,
  fingerprint,
  getCachedGraph,
} from '../../src/cache/graph-cache.ts';
import { scanRepository } from '../../src/scan/scan.ts';
import type { ScanReport } from '../../src/types.ts';

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-cache-test-'));
process.env.STRABO_CACHE_DIR = cacheDir;

const created: string[] = [];

after(() => {
  clearMemoryCache();
  const remove = (target: string) =>
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  remove(cacheDir);
  for (const directory of created) {
    remove(directory);
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-repo-test-'));
  created.push(directory);
  return directory;
}

function makeGitRepo(): string {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), "import { b } from './b.ts';\nexport const a = b;\n");
  fs.writeFileSync(path.join(root, 'b.ts'), 'export const b = 1;\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Strabo Test');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return root;
}

function makePlainDir(): string {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  return root;
}

function countingScan(): { scan: (root: string) => Promise<ScanReport>; count: () => number } {
  let calls = 0;
  return {
    count: () => calls,
    scan: (root: string) => {
      calls += 1;
      return scanRepository(root);
    },
  };
}

test('a fresh scan is a miss, then a memory hit', async () => {
  const root = makeGitRepo();
  clearMemoryCache(root);
  clearDiskCache(root);

  const first = await getCachedGraph(root);
  const second = await getCachedGraph(root);

  assert.equal(first.status, 'miss');
  assert.equal(second.status, 'memory');
  assert.equal(second.report, first.report);
});

test('a disk artifact survives a memory reset', async () => {
  const root = makeGitRepo();
  clearMemoryCache(root);
  clearDiskCache(root);

  const first = await getCachedGraph(root);
  clearMemoryCache(root);
  const second = await getCachedGraph(root);

  assert.equal(first.status, 'miss');
  assert.equal(second.status, 'disk');
  assert.equal(second.fingerprint, first.fingerprint);
});

test('caching never writes into the scanned repository', async () => {
  const root = makeGitRepo();
  clearMemoryCache(root);
  clearDiskCache(root);

  await getCachedGraph(root);

  assert.equal(fs.existsSync(path.join(root, '.strabo-cache')), false);
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString();
  assert.equal(status.trim(), '');

  const artifacts = fs.readdirSync(cacheDir).filter((name) => name.startsWith(CACHE_ARTIFACT_VERSION));
  assert.ok(artifacts.length >= 1);
});

test('refresh bypasses both tiers and rescans every time', async () => {
  const root = makeGitRepo();
  clearMemoryCache(root);
  clearDiskCache(root);
  const { scan, count } = countingScan();

  const first = await getCachedGraph(root, { refresh: true, scan });
  const second = await getCachedGraph(root, { refresh: true, scan });

  assert.equal(first.status, 'refreshed');
  assert.equal(second.status, 'refreshed');
  assert.equal(count(), 2);
});

test('concurrent refreshes for one root are coalesced into a single scan', async () => {
  const root = makeGitRepo();
  clearMemoryCache(root);
  clearDiskCache(root);

  let calls = 0;
  let started = false;
  const scan = async (target: string): Promise<ScanReport> => {
    calls += 1;
    if (!started) {
      started = true;
      // Hold the first scan open long enough for the second request to finish its async
      // fingerprint and reach the in-flight check, so the assertion is not timing-dependent.
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return scanRepository(target);
  };

  const first = getCachedGraph(root, { refresh: true, scan });
  while (!started) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const second = getCachedGraph(root, { refresh: true, scan });

  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(firstResult.report, secondResult.report);
});

test('fingerprint changes when the working tree changes', async () => {
  const root = makeGitRepo();
  const before = await fingerprint(root);
  fs.appendFileSync(path.join(root, 'a.ts'), '// touched\n');
  const afterFingerprint = await fingerprint(root);

  assert.ok(before);
  assert.ok(afterFingerprint);
  assert.notEqual(before, afterFingerprint);
});

test('a changed working tree invalidates the cached graph', async () => {
  const root = makeGitRepo();
  clearMemoryCache(root);
  clearDiskCache(root);

  const first = await getCachedGraph(root);
  fs.appendFileSync(path.join(root, 'b.ts'), '\n// edited\n');
  const second = await getCachedGraph(root);

  assert.equal(first.status, 'miss');
  assert.equal(second.status, 'miss');
});

test('repositories without Git reuse memory but never persist to disk', async () => {
  const root = makePlainDir();
  clearMemoryCache(root);
  clearDiskCache(root);

  const first = await getCachedGraph(root);
  const second = await getCachedGraph(root);
  assert.equal(first.fingerprint, null);
  assert.equal(first.status, 'miss');
  assert.equal(second.status, 'memory');

  clearMemoryCache(root);
  const third = await getCachedGraph(root);
  assert.equal(third.status, 'miss');
});

test('a matching artifact past the memory TTL is served while refresh runs', async () => {
  const root = makeGitRepo();
  clearMemoryCache(root);
  clearDiskCache(root);
  const { scan, count } = countingScan();

  let now = 1_000;
  const clock = () => now;

  const first = await getCachedGraph(root, { now: clock, scan });
  assert.equal(first.status, 'miss');

  now += MEMORY_TTL_MS + 1;
  const stale = await getCachedGraph(root, { now: clock, scan });

  assert.equal(stale.status, 'disk');
  assert.equal(stale.stale, true);

  for (let attempt = 0; attempt < 50 && count() < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(count(), 2);
});

test('a tampered or stale-version artifact is rejected', async () => {
  const root = makeGitRepo();
  clearMemoryCache(root);
  clearDiskCache(root);

  await getCachedGraph(root);
  clearMemoryCache(root);

  const artifact = cacheArtifactPath(root);
  const parsed = JSON.parse(fs.readFileSync(artifact, 'utf8')) as { version: string };
  parsed.version = 'strabo-cache-tampered';
  fs.writeFileSync(artifact, JSON.stringify(parsed));

  const result = await getCachedGraph(root);
  assert.equal(result.status, 'miss');
});

test('clearDiskCache removes the persisted artifact', async () => {
  const root = makeGitRepo();
  clearMemoryCache(root);
  clearDiskCache(root);

  await getCachedGraph(root);
  clearMemoryCache(root);
  clearDiskCache(root);

  const result = await getCachedGraph(root);
  assert.equal(result.status, 'miss');
});
