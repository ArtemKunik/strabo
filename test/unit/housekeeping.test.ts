import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { startHousekeeping } from '../../src/api/housekeeping.ts';
import { CACHE_ARTIFACT_VERSION, readArtifactRoot } from '../../src/cache/graph-cache.ts';
import { sweepCaches } from '../../src/cache/housekeeping.ts';
import { WORKSPACE_CACHE_VERSION, pruneWorkspaceCache } from '../../src/cache/workspace-cache.ts';
import { daemonEndpoint, sweepDaemonEndpoints, writeDaemonToken } from '../../src/terminal/daemon.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

let base: string;
let cacheDir: string;
let stateDir: string;
let tempDir: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-'));
  cacheDir = path.join(base, 'cache');
  stateDir = path.join(base, 'state');
  tempDir = path.join(base, 'temp');
  for (const directory of [cacheDir, stateDir, tempDir]) fs.mkdirSync(directory);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function write(directory: string, name: string, ageMs = 0, body = '{}'): string {
  const file = path.join(directory, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  age(file, ageMs);
  return file;
}

function age(target: string, ageMs: number): void {
  const when = new Date(NOW - ageMs);
  fs.utimesSync(target, when, when);
}

function hashOf(root: string): string {
  return createHash('sha256').update(path.resolve(root)).digest('hex');
}

/** A graph artifact shaped the way `writeArtifact` writes it. */
function graph(root: string, ageMs = 0, version = CACHE_ARTIFACT_VERSION): string {
  return write(
    cacheDir,
    `${version}-${hashOf(root)}.json`,
    ageMs,
    JSON.stringify({ version, root: path.resolve(root), fingerprint: 'f', report: {} }),
  );
}

function sweep(maxCacheBytes?: number): string[] {
  return sweepCaches({
    now: NOW,
    cacheDir,
    stateDir,
    tempDir,
    ...(maxCacheBytes === undefined ? {} : { maxCacheBytes }),
  });
}

function names(directory: string): string[] {
  return fs.readdirSync(directory).sort();
}

test('a repository that no longer exists loses its whole cache, however recent', () => {
  const gone = path.join(base, 'deleted-repo');
  const key = hashOf(gone).slice(0, 16);
  graph(gone);
  write(cacheDir, `strabo-revision-graph-2-${key}.json`);
  write(cacheDir, `strabo-change-metrics-2-${key}.json`);

  sweep();

  assert.deepEqual(names(cacheDir), []);
});

test('a repository that still exists keeps its cache', () => {
  const key = hashOf(base).slice(0, 16);
  const artifact = graph(base);
  const history = write(cacheDir, `strabo-revision-graph-2-${key}.json`);

  sweep();

  assert.ok(fs.existsSync(artifact));
  assert.ok(fs.existsSync(history));
});

test('cache files go once they are past the retention window', () => {
  const key = hashOf(base).slice(0, 16);
  const expiring = write(cacheDir, `strabo-revision-graph-2-${key}.json`, 31 * DAY_MS);
  const recent = write(cacheDir, `strabo-change-metrics-2-${key}.json`, 29 * DAY_MS);

  sweep();

  assert.equal(fs.existsSync(expiring), false);
  assert.ok(fs.existsSync(recent));
});

test('a graph from another version goes after a day of grace', () => {
  const old = graph(base, 2 * DAY_MS, 'strabo-cache-5+0.1.0');
  const current = graph(base, 2 * DAY_MS);
  const justUpgraded = graph(path.join(base, 'state'), 0, 'strabo-cache-5+0.1.0');

  sweep();

  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(current));
  assert.ok(fs.existsSync(justUpgraded));
});

test('state beside the cache is never removed, however old', () => {
  const state = [
    'strabo-repositories.json',
    'strabo-settings.json',
    'strabo-narrator-key.json',
    'strabo-workspace.json',
    `strabo-baseline-${hashOf(base).slice(0, 16)}.json`,
  ];
  for (const name of state) write(cacheDir, name, 365 * DAY_MS);

  sweep(0);

  assert.deepEqual(names(cacheDir), [...state].sort());
});

test('files Strabo does not recognize are left alone', () => {
  // STRABO_CACHE_DIR can name a directory that holds other things.
  const foreign = ['notes.json', 'report.html', 'strabo-cache-notes.json', 'strabo-rev-of-my-project'];
  for (const name of foreign) write(cacheDir, name, 365 * DAY_MS);
  const other = path.join(tempDir, 'strabo-rev-of-my-project');
  fs.mkdirSync(other);
  age(other, 365 * DAY_MS);

  sweep(0);

  assert.deepEqual(names(cacheDir), [...foreign].sort());
  assert.ok(fs.existsSync(other));
});

test('past the size cap the oldest files go first and the newest always stays', () => {
  const oldest = write(cacheDir, `strabo-revision-graph-2-${'a'.repeat(16)}.json`, 3 * DAY_MS, 'x'.repeat(100));
  const middle = write(cacheDir, `strabo-revision-graph-2-${'b'.repeat(16)}.json`, 2 * DAY_MS, 'x'.repeat(100));
  const newest = write(cacheDir, `strabo-revision-graph-2-${'c'.repeat(16)}.json`, DAY_MS, 'x'.repeat(100));

  sweep(150);
  assert.equal(fs.existsSync(oldest), false);
  assert.equal(fs.existsSync(middle), false);
  assert.ok(fs.existsSync(newest));

  sweep(1);
  assert.ok(fs.existsSync(newest));
});

test('an abandoned write goes after an hour, in the state directory too', () => {
  const cached = write(cacheDir, 'strabo-workspace.json.123.tmp', 2 * 60 * 60 * 1000);
  const key = write(stateDir, 'strabo-narrator-key.json.123.tmp', 2 * 60 * 60 * 1000);
  const writing = write(cacheDir, 'strabo-settings.json.456.tmp', 60 * 1000);

  sweep();

  assert.equal(fs.existsSync(cached), false);
  assert.equal(fs.existsSync(key), false);
  assert.ok(fs.existsSync(writing));
});

test('expired risk responses go', () => {
  const risk = path.join(cacheDir, 'risk');
  const old = write(risk, `${'a'.repeat(64)}.json`, 8 * DAY_MS);
  const recent = write(risk, `${'b'.repeat(64)}.json`, 6 * DAY_MS);

  sweep();

  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(recent));
});

test('revision checkouts and report files a killed process left go after a day', () => {
  const checkout = path.join(tempDir, 'strabo-rev-AbC123');
  write(checkout, 'src/index.ts');
  age(checkout, 2 * DAY_MS);
  const report = write(tempDir, 'strabo-report-42-1700000000000.html', 2 * DAY_MS);
  const running = path.join(tempDir, 'strabo-rev-XyZ789');
  fs.mkdirSync(running);
  age(running, 60 * 1000);

  sweep();

  assert.equal(fs.existsSync(checkout), false);
  assert.equal(fs.existsSync(report), false);
  assert.ok(fs.existsSync(running));
});

test('a directory that does not exist yet is not an error', () => {
  assert.deepEqual(
    sweepCaches({ now: NOW, cacheDir: path.join(base, 'a'), stateDir: path.join(base, 'b'), tempDir: path.join(base, 'c') }),
    [],
  );
});

test('readArtifactRoot reads an escaped root and declines anything else', () => {
  const root = 'C:\\Users\\some "one"\\repo';
  const artifact = write(cacheDir, 'a.json', 0, JSON.stringify({ version: 'v', root, fingerprint: 'f', report: {} }));
  assert.equal(readArtifactRoot(artifact), root);
  assert.equal(readArtifactRoot(write(cacheDir, 'b.json', 0, 'not json')), null);
  assert.equal(readArtifactRoot(path.join(cacheDir, 'missing.json')), null);
});

test('an artifact that does not name its root is kept until it expires', () => {
  const unreadable = write(cacheDir, `${CACHE_ARTIFACT_VERSION}-${'d'.repeat(64)}.json`, 0, 'corrupt');

  sweep();

  assert.ok(fs.existsSync(unreadable));
});

test('pruneWorkspaceCache drops repositories that are gone and keeps the rest', () => {
  const entry = { fingerprint: 'f', contracts: [], endpoints: [], calls: [] };
  const gone = path.join(base, 'deleted-repo');
  const file = write(
    cacheDir,
    'strabo-workspace.json',
    0,
    JSON.stringify({ version: WORKSPACE_CACHE_VERSION, entries: { [base]: entry, [gone]: entry } }),
  );

  pruneWorkspaceCache(file);

  assert.deepEqual(Object.keys((JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: object }).entries), [base]);
});

test('pruneWorkspaceCache leaves a missing file missing', () => {
  const file = path.join(cacheDir, 'strabo-workspace.json');
  pruneWorkspaceCache(file);
  assert.equal(fs.existsSync(file), false);
});

test('a stopped daemon loses its old token; a fresh token and a running daemon keep theirs', async (t) => {
  const stopped = daemonEndpoint(path.join(base, 'stopped'));
  const starting = daemonEndpoint(path.join(base, 'starting'));
  const running = daemonEndpoint(path.join(base, 'running'));
  for (const endpoint of [stopped, starting, running]) writeDaemonToken(endpoint, 'token');
  age(stopped.tokenFile, 8 * DAY_MS);
  age(running.tokenFile, 8 * DAY_MS);

  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(running.socketPath, resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const endpoint of [stopped, starting, running]) fs.rmSync(endpoint.tokenFile, { force: true });
  });

  const removed = await sweepDaemonEndpoints(NOW);

  assert.deepEqual(removed, [stopped.tokenFile]);
  assert.ok(fs.existsSync(starting.tokenFile));
  assert.ok(fs.existsSync(running.tokenFile));
});

test('STRABO_HOUSEKEEPING=off schedules nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const setTimeoutCalls = t.mock.method(globalThis, 'setTimeout');
  startHousekeeping(undefined, { STRABO_HOUSEKEEPING: 'off' });
  assert.equal(setTimeoutCalls.mock.callCount(), 0);
});
