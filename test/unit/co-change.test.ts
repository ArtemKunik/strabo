import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { buildCoChangeEdges } from '../../src/analysis/co-change.ts';
import { clearHistoryCache, collectHistory } from '../../src/analysis/history.ts';
import { scanRepository } from '../../src/index.ts';
import type { CoChangeCommit, HistorySummary } from '../../src/analysis/history.ts';
import type { Graph } from '../../src/types.ts';

const created: string[] = [];
after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-cochange-'));
  created.push(directory);
  return directory;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
}

function initRepo(root: string): void {
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Tester');
  git(root, 'config', 'commit.gpgsign', 'false');
}

function commitAll(root: string, message: string, date: string): void {
  git(root, 'add', '.');
  // Pin the author and committer dates so the pair's evidence is deterministic.
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd: root,
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

function commit(hash: string, date = '2026-01-01', subject = 'change'): CoChangeCommit {
  return { hash, date, subject };
}

function graph(files: string[], edges: Array<[string, string]> = []): Graph {
  return {
    nodes: files.map((id) => ({ id, kind: 'module' as const, directory: '.' })),
    edges: edges.map(([source, target]) => ({
      source,
      target,
      kind: 'import' as const,
      evidence: { line: 1, specifier: './x', resolution: 'exact' as const },
    })),
    diagnostics: [],
    excluded: [],
  };
}

interface PairSpec {
  a: string;
  b: string;
  commits: CoChangeCommit[];
  commitsShared?: number;
}

function summary(options: {
  churn: Record<string, number>;
  pairs: PairSpec[];
  skippedCommits?: Array<{ hash: string; files: number }>;
  maxKeptCommitsPerPair?: number;
  available?: boolean;
}): HistorySummary {
  const coChangeCommits = new Map(
    options.pairs.map((pair) => [`${pair.a}\u0000${pair.b}`, pair]),
  );
  return {
    churn: new Map(Object.entries(options.churn)),
    authors: new Map(),
    coChange: new Map(),
    coChangeCommits,
    windowDays: 365,
    commitsScanned: 10,
    skippedCommits: options.skippedCommits ?? [],
    maxKeptCommitsPerPair: options.maxKeptCommitsPerPair ?? 20,
    available: options.available ?? true,
  };
}

test('buildCoChangeEdges draws an edge from the recorded pair and its commits', () => {
  const report = buildCoChangeEdges(
    summary({
      churn: { 'config.json': 4, 'reader.ts': 4 },
      pairs: [{ a: 'config.json', b: 'reader.ts', commits: [commit('aaa'), commit('bbb'), commit('ccc')], commitsShared: 3 }],
    }),
    graph(['config.json', 'reader.ts']),
  );

  assert.equal(report.unavailable, false);
  assert.equal(report.edges.length, 1);
  const edge = report.edges[0];
  assert.equal(edge.source, 'config.json');
  assert.equal(edge.target, 'reader.ts');
  assert.equal(edge.commitsShared, 3);
  assert.equal(edge.commitsUnion, 5);
  assert.equal(edge.ratio, 0.6);
  assert.deepEqual(edge.commits.map((entry) => entry.hash), ['aaa', 'bbb', 'ccc']);
  assert.equal(report.thresholds.minCommits, 3);
  assert.equal(report.thresholds.minRatio, 0.5);
});

test('minCommits excludes a pair that changed together too rarely', () => {
  const report = buildCoChangeEdges(
    summary({
      churn: { 'a.ts': 1, 'b.ts': 1 },
      pairs: [{ a: 'a.ts', b: 'b.ts', commits: [commit('aaa')], commitsShared: 1 }],
    }),
    graph(['a.ts', 'b.ts']),
  );

  assert.deepEqual(report.edges, []);
});

test('the coupling ratio excludes a pair that usually changes apart', () => {
  // One shared commit out of a union of 10: 0.1, below the 0.5 floor.
  const report = buildCoChangeEdges(
    summary({
      churn: { 'a.ts': 9, 'b.ts': 2 },
      pairs: [{ a: 'a.ts', b: 'b.ts', commits: [commit('aaa')], commitsShared: 1 }],
    }),
    graph(['a.ts', 'b.ts']),
  );

  assert.deepEqual(report.edges, []);
});

test('a configurable threshold admits a low-ratio pair the default rejects', () => {
  const report = buildCoChangeEdges(
    summary({
      churn: { 'a.ts': 9, 'b.ts': 2 },
      pairs: [{ a: 'a.ts', b: 'b.ts', commits: [commit('aaa')], commitsShared: 1 }],
    }),
    graph(['a.ts', 'b.ts']),
    { minCommits: 1, minRatio: 0.1 },
  );

  assert.equal(report.edges.length, 1);
  assert.equal(report.edges[0].ratio, 0.1);
});

test('an edge with no listable commits is not drawn, and the gap is counted', () => {
  const report = buildCoChangeEdges(
    summary({
      churn: { 'a.ts': 3, 'b.ts': 3 },
      pairs: [{ a: 'a.ts', b: 'b.ts', commits: [], commitsShared: 3 }],
    }),
    graph(['a.ts', 'b.ts']),
  );

  assert.deepEqual(report.edges, []);
  assert.equal(report.fromUnavailable, 1);
});

test('files outside the graph are excluded and counted', () => {
  const report = buildCoChangeEdges(
    summary({
      churn: { 'a.ts': 3, 'outside.ts': 3 },
      pairs: [{ a: 'a.ts', b: 'outside.ts', commits: [commit('aaa'), commit('bbb'), commit('ccc')], commitsShared: 3 }],
    }),
    graph(['a.ts']),
  );

  assert.deepEqual(report.edges, []);
  assert.equal(report.fromUnavailable, 1);
});

test('a pair with no import path in either direction is hidden coupling', () => {
  // config.json and reader.ts share commits but nothing imports either one.
  const report = buildCoChangeEdges(
    summary({
      churn: { 'config.json': 3, 'reader.ts': 3 },
      pairs: [{ a: 'config.json', b: 'reader.ts', commits: [commit('a'), commit('b'), commit('c')], commitsShared: 3 }],
    }),
    graph(['config.json', 'reader.ts']),
  );

  assert.equal(report.edges.length, 1);
  assert.equal(report.edges[0].source, 'config.json');
  assert.equal(report.edges[0].hidden, true);
});

test('a direct import makes a co-change edge not hidden', () => {
  const report = buildCoChangeEdges(
    summary({
      churn: { 'a.ts': 3, 'b.ts': 3 },
      pairs: [{ a: 'a.ts', b: 'b.ts', commits: [commit('a'), commit('b'), commit('c')], commitsShared: 3 }],
    }),
    graph(['a.ts', 'b.ts'], [['a.ts', 'b.ts']]),
  );

  assert.equal(report.edges.length, 1);
  assert.equal(report.edges[0].hidden, false);
});

test('a path through a third file connects the pair, so it is not hidden', () => {
  // a.ts imports mid.ts, mid.ts imports b.ts: reachable in both directions, no direct edge.
  const report = buildCoChangeEdges(
    summary({
      churn: { 'a.ts': 3, 'b.ts': 3 },
      pairs: [{ a: 'a.ts', b: 'b.ts', commits: [commit('a'), commit('b'), commit('c')], commitsShared: 3 }],
    }),
    graph(['a.ts', 'b.ts', 'mid.ts'], [['a.ts', 'mid.ts'], ['mid.ts', 'b.ts']]),
  );

  assert.equal(report.edges.length, 1);
  assert.equal(report.edges[0].hidden, false);
});

test('a downward path the wrong way still counts as connected', () => {
  // b.ts imports a.ts: the import runs target -> source, and reachability is checked both ways.
  const report = buildCoChangeEdges(
    summary({
      churn: { 'a.ts': 3, 'b.ts': 3 },
      pairs: [{ a: 'a.ts', b: 'b.ts', commits: [commit('a'), commit('b'), commit('c')], commitsShared: 3 }],
    }),
    graph(['a.ts', 'b.ts'], [['b.ts', 'a.ts']]),
  );

  assert.equal(report.edges[0].hidden, false);
});

test('a declare edge does not connect a pair, since only use edges count', () => {
  const declareGraph: Graph = {
    nodes: [
      { id: 'a.ts', kind: 'module', directory: '.' },
      { id: 'b.ts', kind: 'module', directory: '.' },
    ],
    edges: [
      {
        source: 'a.ts',
        target: 'b.ts',
        kind: 'import',
        role: 'declare',
        evidence: { line: 1, specifier: './b', resolution: 'exact' },
      },
    ],
    diagnostics: [],
    excluded: [],
  };
  const report = buildCoChangeEdges(
    summary({
      churn: { 'a.ts': 3, 'b.ts': 3 },
      pairs: [{ a: 'a.ts', b: 'b.ts', commits: [commit('a'), commit('b'), commit('c')], commitsShared: 3 }],
    }),
    declareGraph,
  );

  assert.equal(report.edges[0].hidden, true);
});

test('mass commits are named and never join a pair', () => {
  const report = buildCoChangeEdges(
    summary({
      churn: { 'a.ts': 3, 'b.ts': 3 },
      pairs: [{ a: 'a.ts', b: 'b.ts', commits: [commit('a'), commit('b'), commit('c')], commitsShared: 3 }],
      skippedCommits: [{ hash: 'mass1', files: 120 }],
    }),
    graph(['a.ts', 'b.ts']),
  );

  assert.deepEqual(report.skippedCommits, [{ hash: 'mass1', files: 120, reason: 'mass-commit' }]);
  assert.equal(report.edges[0].commits.length, 3);
});

test('unavailable history yields no edges and says so', () => {
  const report = buildCoChangeEdges(
    summary({ churn: {}, pairs: [], available: false }),
    graph(['a.ts', 'b.ts']),
  );

  assert.equal(report.unavailable, true);
  assert.deepEqual(report.edges, []);
});

test('edges are sorted by shared commits, then paths, and capped', () => {
  const report = buildCoChangeEdges(
    summary({
      churn: { 'a.ts': 5, 'b.ts': 5, 'c.ts': 4, 'd.ts': 4 },
      pairs: [
        { a: 'a.ts', b: 'b.ts', commits: [commit('1'), commit('2'), commit('3')], commitsShared: 3 },
        { a: 'c.ts', b: 'd.ts', commits: [commit('1'), commit('2'), commit('3'), commit('4')], commitsShared: 4 },
      ],
    }),
    graph(['a.ts', 'b.ts', 'c.ts', 'd.ts']),
    { maxEdges: 1 },
  );

  assert.equal(report.edges.length, 1);
  assert.equal(report.edges[0].target, 'd.ts');
  assert.equal(report.edges[0].commitsShared, 4);
});

test('maxCommitsPerEdge trims the evidence list', () => {
  const report = buildCoChangeEdges(
    summary({
      churn: { 'a.ts': 5, 'b.ts': 5 },
      pairs: [
        {
          a: 'a.ts',
          b: 'b.ts',
          commits: [commit('1'), commit('2'), commit('3'), commit('4')],
          commitsShared: 4,
        },
      ],
      maxKeptCommitsPerPair: 20,
    }),
    graph(['a.ts', 'b.ts']),
    { maxCommitsPerEdge: 2 },
  );

  assert.equal(report.edges[0].commits.length, 2);
  assert.equal(report.edges[0].commitsShared, 4);
  assert.equal(report.thresholds.maxKeptCommitsPerPair, 20);
});

/**
 * The acceptance case: a real repository whose scripted history changes a config file and
 * its reader together, with no import between them, so exactly that pair surfaces as hidden
 * coupling carrying its commits.
 */
test('a config file and its reader surface as hidden coupling from a scripted history', async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'src'));
  // Two source files with no import between them: the config module and the reader that
  // reads its values. The scan retains both, and neither references the other.
  fs.writeFileSync(path.join(root, 'src/config.ts'), 'export const port = 8080;\n');
  fs.writeFileSync(path.join(root, 'src/reader.ts'), 'export const port = 8080;\n');
  fs.writeFileSync(path.join(root, 'src/unrelated.ts'), 'export const x = 1;\n');
  initRepo(root);
  commitAll(root, 'add config and reader', '2026-01-02T10:00:00Z');

  // Three commits touch both the config and its reader, and nothing else.
  for (const [n, day] of [[2, '03'], [3, '04'], [4, '05']] as const) {
    fs.appendFileSync(path.join(root, 'src/config.ts'), `// rev ${n}\n`);
    fs.appendFileSync(path.join(root, 'src/reader.ts'), `// rev ${n}\n`);
    commitAll(root, `retune port ${n}`, `2026-01-${day}T10:00:00Z`);
  }
  // A fifth commit touches only the unrelated file, so it is not part of the coupling.
  fs.appendFileSync(path.join(root, 'src/unrelated.ts'), '// alone\n');
  commitAll(root, 'unrelated tweak', '2026-01-06T10:00:00Z');

  const scan = await scanRepository(root);
  const files = scan.graph.nodes.map((node) => node.id);
  clearHistoryCache();
  const history = await collectHistory(root, files, { windowDays: 3650 });
  const report = buildCoChangeEdges(history, scan.graph, { minCommits: 3, minRatio: 0.5 });

  const hidden = report.edges.filter((edge) => edge.hidden);
  assert.equal(hidden.length, 1, 'exactly one hidden-coupling pair');
  const edge = hidden[0];
  assert.deepEqual([edge.source, edge.target], ['src/config.ts', 'src/reader.ts']);
  assert.equal(edge.commitsShared, 4);
  assert.equal(edge.commits.length, 4);
  assert.deepEqual(
    edge.commits.map((entry) => entry.subject),
    ['retune port 4', 'retune port 3', 'retune port 2', 'add config and reader'],
  );
  assert.ok(edge.commits.every((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry.date)));
  assert.ok(edge.commits.every((entry) => /^[0-9a-f]{7,}$/.test(entry.hash)));
  // No ordinary import edge connects the pair, which is why the edge is hidden.
  assert.equal(
    scan.graph.edges.some(
      (candidate) =>
        (candidate.source === 'src/config.ts' && candidate.target === 'src/reader.ts') ||
        (candidate.source === 'src/reader.ts' && candidate.target === 'src/config.ts'),
    ),
    false,
  );
  assert.equal(report.skippedCommits.length, 0);
});
