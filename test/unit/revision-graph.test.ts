import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, beforeEach, test } from 'node:test';

import {
  clearStructuralDiffCache,
  computeStructuralDiff,
  revisionGraph,
  revisionGraphCachePath,
  REVISION_GRAPH_VERSION,
} from '../../src/analysis/structural-diff.ts';
import { scanRepository } from '../../src/scan/scan.ts';

const created: string[] = [];
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-revision-cache-'));
created.push(cacheDir);
process.env.STRABO_CACHE_DIR = cacheDir;

after(() => {
  clearStructuralDiffCache();
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

beforeEach(() => {
  clearStructuralDiffCache();
});

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
}

function tempRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-revision-'));
  created.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Tester');
  git(root, 'config', 'core.autocrlf', 'false');
  return root;
}

function write(root: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

function commit(root: string, message: string): string {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD').trim();
}

/** Two commits: a.ts imports b.ts, then a.ts imports c.ts instead. */
function seed(root: string): { first: string; second: string } {
  write(root, 'src/b.ts', 'export const b = 1;\n');
  write(root, 'src/c.ts', 'export const c = 1;\n');
  write(root, 'src/a.ts', "import './b.ts';\nexport const a = 1;\n");
  const first = commit(root, 'import b');
  write(root, 'src/a.ts', "import './c.ts';\nexport const a = 1;\n");
  const second = commit(root, 'import c');
  return { first, second };
}

function edgeKeys(graph: { edges: Array<{ source: string; target: string }> }): string[] {
  return graph.edges.map((edge) => `${edge.source} -> ${edge.target}`).sort();
}

test('revisionGraph builds from committed blobs, never the working tree', async () => {
  const root = tempRepo();
  const { first } = seed(root);
  // Dirty the working tree after committing: the graph at the commit must ignore it.
  write(root, 'src/a.ts', 'export const a = 1;\n');

  const result = await revisionGraph(root, first, 'fixture');

  assert.equal(result.source, 'build');
  assert.deepEqual(edgeKeys(result.graph), ['src/a.ts -> src/b.ts']);
  assert.equal(result.graph.nodes.some((node) => node.id === 'src/c.ts'), true);
  const worktrees = git(root, 'worktree', 'list', '--porcelain');
  assert.equal(/strabo-base-/.test(worktrees), false);
});

test('a revision graph is served from memory on the second call', async () => {
  const root = tempRepo();
  const { first } = seed(root);

  const built = await revisionGraph(root, first, 'fixture');
  const again = await revisionGraph(root, first, 'fixture');

  assert.equal(built.source, 'build');
  assert.equal(again.source, 'memory');
  assert.deepEqual(edgeKeys(again.graph), edgeKeys(built.graph));
});

test('the persisted store serves a fresh module boundary and survives a new process', async () => {
  const root = tempRepo();
  const { first } = seed(root);

  const built = await revisionGraph(root, first, 'fixture');
  assert.equal(built.source, 'build');

  const file = revisionGraphCachePath(root);
  assert.equal(file.startsWith(cacheDir), true, 'the store lives under the repo cache root');
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    version: string;
    entries: Record<string, unknown>;
  };
  assert.equal(persisted.version, REVISION_GRAPH_VERSION);
  assert.equal(Object.keys(persisted.entries).length, 1);

  // Dropping memory and the parsed store is a fresh module boundary for the cache.
  clearStructuralDiffCache();
  const fromDisk = await revisionGraph(root, first, 'fixture');
  assert.equal(fromDisk.source, 'disk');
  assert.deepEqual(edgeKeys(fromDisk.graph), edgeKeys(built.graph));

  // A separate process sees the same persisted entry and builds nothing.
  const script = [
    `const m = await import(${JSON.stringify(pathToFileURL(path.resolve('src/analysis/structural-diff.ts')).href)});`,
    `const r = await m.revisionGraph(${JSON.stringify(root)}, ${JSON.stringify(first)}, 'fixture');`,
    `process.stdout.write(JSON.stringify({ source: r.source, edges: r.graph.edges.length, nodes: r.graph.nodes.length }));`,
  ].join('\n');
  const output = execFileSync('node', ['--input-type=module', '--eval', script], {
    cwd: path.resolve('.'),
    env: { ...process.env, STRABO_CACHE_DIR: cacheDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  const child = JSON.parse(output) as { source: string; edges: number; nodes: number };
  assert.equal(child.source, 'disk');
  assert.equal(child.edges, built.graph.edges.length);
  assert.equal(child.nodes, built.graph.nodes.length);
});

test('a changed revision produces a distinct key and a distinct graph', async () => {
  const root = tempRepo();
  const { first, second } = seed(root);

  const before = await revisionGraph(root, first, 'fixture');
  const after = await revisionGraph(root, second, 'fixture');

  assert.equal(before.source, 'build');
  assert.equal(after.source, 'build');
  assert.deepEqual(edgeKeys(before.graph), ['src/a.ts -> src/b.ts']);
  assert.deepEqual(edgeKeys(after.graph), ['src/a.ts -> src/c.ts']);

  const persisted = JSON.parse(fs.readFileSync(revisionGraphCachePath(root), 'utf8')) as {
    entries: Record<string, unknown>;
  };
  assert.equal(Object.keys(persisted.entries).length, 2);

  clearStructuralDiffCache();
  assert.equal((await revisionGraph(root, first, 'fixture')).source, 'disk');
  assert.equal((await revisionGraph(root, second, 'fixture')).source, 'disk');
});

test('a corrupted or wrong-version store is ignored and rebuilt', async () => {
  const root = tempRepo();
  const { first } = seed(root);
  const file = revisionGraphCachePath(root);

  await revisionGraph(root, first, 'fixture');
  clearStructuralDiffCache();
  fs.writeFileSync(file, 'this is not json');
  const rebuilt = await revisionGraph(root, first, 'fixture');
  assert.equal(rebuilt.source, 'build');
  assert.deepEqual(edgeKeys(rebuilt.graph), ['src/a.ts -> src/b.ts']);

  clearStructuralDiffCache();
  fs.writeFileSync(file, JSON.stringify({ version: 'stale-version', entries: { junk: {} } }));
  const afterStale = await revisionGraph(root, first, 'fixture');
  assert.equal(afterStale.source, 'build');
  assert.deepEqual(edgeKeys(afterStale.graph), ['src/a.ts -> src/b.ts']);
});

test('computeStructuralDiff takes the base from cache after the first build', async () => {
  const root = tempRepo();
  const { first } = seed(root);
  const headGraph = (await scanRepository(root)).graph;

  const cold = await computeStructuralDiff(root, first, { headGraph, repository: 'fixture' });
  assert.equal(cold.available, true);
  if (!cold.available) return;
  assert.equal(cold.cached, false);
  assert.deepEqual(cold.diff.edgesAdded.map((edge) => `${edge.source} -> ${edge.target}`), ['src/a.ts -> src/c.ts']);

  clearStructuralDiffCache();
  const warm = await computeStructuralDiff(root, first, { headGraph, repository: 'fixture' });
  assert.equal(warm.available, true);
  if (!warm.available) return;
  assert.equal(warm.cached, true);
  assert.deepEqual(warm.diff.counts, cold.diff.counts);
});

test('a repo with no relative commit is reported unavailable, never scanned', async () => {
  const root = tempRepo();
  write(root, 'a.ts', 'export const a = 1;\n');
  commit(root, 'only commit');

  const noRelative = await computeStructuralDiff(root, 'HEAD~1');
  assert.equal(noRelative.available, false);
  assert.equal(noRelative.available === false && noRelative.reason, 'unknown-revision');

  const empty = tempRepo();
  const noCommits = await computeStructuralDiff(empty, 'HEAD');
  assert.equal(noCommits.available, false);
});
