import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

import { JSDOM } from 'jsdom';

import {
  clearChangeMetricsCache,
  computeCommitMetrics,
  computeMetricsHistory,
  computeWorkingTreeMetrics,
  readBlobs,
  reviewWorkingTree,
  scanRepository,
} from '../../src/index.ts';
import { getTimeline } from '../../src/analysis/timeline.ts';
import {
  changeMetricSummary,
  commitMetricBadge,
  metricDelta,
  orderMetricFiles,
} from '../../ui/strabo-overlays.js';

const created: string[] = [];
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-metrics-cache-'));
created.push(cacheDir);
process.env.STRABO_CACHE_DIR = cacheDir;

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

beforeEach(() => {
  clearChangeMetricsCache();
});

function tempRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-metrics-'));
  created.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Tester');
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
}

function write(root: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

function commit(root: string, message: string): void {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
}

const SIMPLE = `export function pick(a: number): number {\n  return a;\n}\n`;
const BRANCHY = `import { log } from './log';\n\nexport function pick(a: number): number {\n  if (a > 1) {\n    log('big');\n    return a;\n  }\n  if (a < 0) {\n    return 0;\n  }\n  return 1;\n}\n`;

/** Three commits: a baseline, one that adds branches and an import, one that removes both. */
function seed(root: string): void {
  write(root, 'src/log.ts', `export function log(message: string): void {\n  console.log(message);\n}\n`);
  write(root, 'src/pick.ts', SIMPLE);
  commit(root, 'baseline');
  write(root, 'src/pick.ts', BRANCHY);
  commit(root, 'branch');
  write(root, 'src/pick.ts', SIMPLE);
  commit(root, 'simplify');
}

test('computeCommitMetrics reports complexity and coupling moves for one commit', async () => {
  const root = tempRepo();
  seed(root);

  const result = await computeCommitMetrics(root, 'HEAD~1');
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.kind, 'commit');
  assert.equal(result.ref, git(root, 'rev-parse', 'HEAD~1').trim());
  assert.equal(result.baseline, git(root, 'rev-parse', 'HEAD~2').trim());

  const file = result.files.find((entry) => entry.path === 'src/pick.ts');
  assert.ok(file);
  assert.ok(file.before?.complexity != null && file.after?.complexity != null);
  assert.ok(file.after.complexity > file.before.complexity, 'branches raise complexity');
  assert.deepEqual(file.complexityChange, { added: file.after.complexity - file.before.complexity, removed: 0 });
  assert.deepEqual(file.fanOut, { before: 0, after: 1 });
  assert.deepEqual(file.importsAdded, ['src/log.ts']);
  assert.deepEqual(result.totals.coupling, { added: 1, removed: 0 });
  assert.equal(file.functions[0]?.name, 'pick');

  const reverse = await computeCommitMetrics(root, 'HEAD');
  assert.equal(reverse.available, true);
  if (!reverse.available) return;
  assert.deepEqual(reverse.totals.coupling, { added: 0, removed: 1 });
  assert.equal(reverse.totals.complexity.added, 0);
  assert.equal(reverse.totals.complexity.removed, file.complexityChange.added);
});

test('fan-in moves for a target that a changed file starts importing', async () => {
  const root = tempRepo();
  write(root, 'src/log.ts', `export const log = (m: string) => m;\n`);
  write(root, 'src/a.ts', `export const a = 1;\n`);
  commit(root, 'baseline');
  write(root, 'src/a.ts', `import { log } from './log';\nexport const a = log('x');\n`);
  write(root, 'src/log.ts', `export const log = (m: string) => m + '!';\n`);
  commit(root, 'wire');

  const result = await computeCommitMetrics(root, 'HEAD');
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.files.find((entry) => entry.path === 'src/log.ts')?.fanInDelta, 1);
  assert.equal(result.files.find((entry) => entry.path === 'src/a.ts')?.fanInDelta, 0);
});

test('a root commit has no baseline and measures only the after side', async () => {
  const root = tempRepo();
  write(root, 'src/pick.ts', BRANCHY);
  commit(root, 'root');

  const result = await computeCommitMetrics(root, 'HEAD');
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.baseline, null);
  const file = result.files[0];
  assert.equal(file?.status, 'added');
  assert.equal(file?.before, null);
  assert.ok((file?.after?.complexity ?? 0) > 0);
});

test('commit metrics are served from the on-disk cache on a second request', async () => {
  const root = tempRepo();
  seed(root);

  const first = await computeCommitMetrics(root, 'HEAD~1');
  assert.equal(first.available && first.cached, undefined);
  clearChangeMetricsCache();
  const second = await computeCommitMetrics(root, 'HEAD~1');
  assert.equal(second.available && second.cached, true);
  assert.deepEqual(second.available && second.totals, first.available && first.totals);
});

test('an unsafe or unknown revision is reported, never passed to git as an option', async () => {
  const root = tempRepo();
  seed(root);
  assert.deepEqual(await computeCommitMetrics(root, '--output=x'), {
    available: false,
    reason: 'unknown-revision',
    detail: 'Unknown revision "--output=x".',
  });
  const unknown = await computeCommitMetrics(root, 'no-such-branch');
  assert.equal(unknown.available, false);
});

test('computeWorkingTreeMetrics compares uncommitted edits with HEAD', async () => {
  const root = tempRepo();
  write(root, 'src/log.ts', `export function log(message: string): void {\n  console.log(message);\n}\n`);
  write(root, 'src/pick.ts', SIMPLE);
  commit(root, 'baseline');
  write(root, 'src/pick.ts', BRANCHY);
  write(root, 'src/new.ts', `export function fresh(x: number) {\n  return x ? 1 : 2;\n}\n`);

  const report = await scanRepository(root);
  const review = await reviewWorkingTree(root, report.graph);
  assert.equal(review.available, true);
  if (!review.available) return;
  const result = await computeWorkingTreeMetrics(root, review.files);
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.kind, 'working-tree');
  assert.equal(result.baseline, 'HEAD');
  const pick = result.files.find((entry) => entry.path === 'src/pick.ts');
  assert.deepEqual(pick?.importsAdded, ['src/log.ts']);
  const fresh = result.files.find((entry) => entry.path === 'src/new.ts');
  assert.equal(fresh?.status, 'untracked');
  assert.equal(fresh?.before, null);
  assert.ok((fresh?.after?.complexity ?? 0) > 0);
});

test('computeMetricsHistory returns totals for each timeline commit', async () => {
  const root = tempRepo();
  seed(root);
  const timeline = await getTimeline(root, 10);
  assert.equal(timeline.available, true);
  if (!timeline.available) return;
  const history = await computeMetricsHistory(root, timeline.commits);
  assert.equal(history.length, 3);
  assert.deepEqual(
    history.map((entry) => entry.totals?.coupling),
    [
      { added: 0, removed: 1 },
      { added: 1, removed: 0 },
      { added: 0, removed: 0 },
    ],
  );
});

test('readBlobs reads many revisions in one batch and nulls what is missing', async () => {
  const root = tempRepo();
  seed(root);
  const blobs = await readBlobs(root, ['HEAD~1:src/pick.ts', 'HEAD:src/pick.ts', 'HEAD:missing.ts']);
  assert.equal(blobs.get('HEAD~1:src/pick.ts'), BRANCHY);
  assert.equal(blobs.get('HEAD:src/pick.ts'), SIMPLE);
  assert.equal(blobs.get('HEAD:missing.ts'), null);
});

/* ------------------------------------------------------------------ Browser formatting */

test('metricDelta reads a rise in complexity as worse and names a missing side', () => {
  assert.deepEqual(metricDelta(3, 7), { tone: 'worse', delta: 4, text: '+4' });
  assert.deepEqual(metricDelta(7, 3), { tone: 'better', delta: -4, text: '−4' });
  assert.deepEqual(metricDelta(2, 2), { tone: 'flat', delta: 0, text: '±0' });
  assert.deepEqual(metricDelta(null, 2), { tone: 'none', delta: null, text: '—' });
  assert.equal(metricDelta(1, 2, { moreIsWorse: false }).tone, 'better');
});

const TOTALS = {
  files: 2,
  measured: 1,
  complexity: { before: 4, after: 9, added: 6, removed: 1 },
  functions: { before: 2, after: 3 },
  signals: { before: 0, after: 1 },
  lines: { before: 10, after: 20 },
  coupling: { added: 2, removed: 1 },
};

test('changeMetricSummary and commitMetricBadge summarise a change set', () => {
  assert.equal(
    changeMetricSummary(TOTALS),
    'complexity +6 −1 (4 → 9) · functions 2 → 3 · signals +1 · coupling +2 −1 import(s)',
  );
  assert.equal(
    changeMetricSummary({ ...TOTALS, measured: 0 }),
    'complexity not measured · coupling +2 −1 import(s)',
  );
  assert.deepEqual(
    { text: commitMetricBadge(TOTALS)?.text, tone: commitMetricBadge(TOTALS)?.tone },
    { text: 'cx +5 · cpl +1', tone: 'worse' },
  );
  assert.equal(commitMetricBadge(null), null);
});

test('orderMetricFiles leads with the files that moved most', () => {
  const ordered = orderMetricFiles([
    { path: 'b', complexityChange: { added: 1, removed: 0 }, importsAdded: [], importsRemoved: [], fanInDelta: 0 },
    { path: 'a', complexityChange: null, importsAdded: [], importsRemoved: [], fanInDelta: 0 },
    { path: 'c', complexityChange: { added: 2, removed: 3 }, importsAdded: ['x'], importsRemoved: [], fanInDelta: -1 },
  ]);
  assert.deepEqual(ordered.map((file: { path: string }) => file.path), ['c', 'b', 'a']);
});

test('renderReview shows the change metrics table and the timeline shows per-commit badges', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  const { renderReview, renderTimeline } = await import('../../ui/strabo-panels.js');

  const review = document.createElement('div');
  renderReview(review, {
    available: true,
    kind: 'working-tree',
    files: [],
    totals: { files: 1, insertions: 1, deletions: 0, uncounted: 0 },
    impact: { affected: [], outsideGraph: [] },
    metrics: {
      available: true,
      kind: 'working-tree',
      baseline: 'HEAD',
      capped: false,
      totals: TOTALS,
      files: [
        {
          path: 'src/pick.ts',
          status: 'modified',
          before: { lines: 3, functions: 1, complexity: 1, maxComplexity: 1, maxNesting: 0, signals: 0, cohesion: null },
          after: { lines: 12, functions: 1, complexity: 3, maxComplexity: 3, maxNesting: 1, signals: 0, cohesion: null },
          fanOut: { before: 0, after: 1 },
          importsAdded: ['src/log.ts'],
          importsRemoved: [],
          fanInDelta: 0,
          complexityChange: { added: 2, removed: 0 },
          functions: [{ name: 'pick', owner: '', before: 1, after: 3 }],
        },
      ],
    },
  });
  assert.equal(
    review.querySelector('[data-role="change-metrics-summary"]')?.textContent,
    changeMetricSummary(TOTALS),
  );
  const cells = [...review.querySelectorAll('[data-role="change-metrics"] tr:nth-child(2) td')].map(
    (cell) => cell.textContent,
  );
  assert.deepEqual(cells, ['src/pick.ts', '+2', '+1', '±0', '+9']);

  const timeline = document.createElement('div');
  const commitEntry = { hash: 'abc', shortHash: 'abc', author: 'T', date: '2026-09-21T00:00:00Z', subject: 's' };
  renderTimeline(timeline, { available: true, commits: [commitEntry] }, () => {}, {
    metrics: new Map([['abc', TOTALS]]),
  });
  assert.equal(timeline.querySelector('[data-role="commit-metrics"]')?.textContent, 'cx +5 · cpl +1');
});
