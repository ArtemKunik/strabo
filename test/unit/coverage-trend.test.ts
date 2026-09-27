import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

import {
  collectCoverageTrend,
  computeCoverageTrendMeasures,
  COVERAGE_TREND_MEASURES,
} from '../../src/analysis/coverage-trend.ts';
import { clearStructuralDiffCache } from '../../src/analysis/structural-diff.ts';
import type { Graph } from '../../src/types.ts';

const created: string[] = [];
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-trend-cache-'));
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-trend-'));
  created.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Tester');
  git(root, 'config', 'commit.gpgsign', 'false');
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

function graph(nodes: Graph['nodes'], edges: Graph['edges']): Graph {
  return { nodes, edges, diagnostics: [], excluded: [] };
}

function edge(source: string, target: string): Graph['edges'][number] {
  return { source, target, kind: 'import', evidence: { line: 1, specifier: target, resolution: 'exact' } };
}

function measureOf(report: { measures: Array<{ key: string; value: number | null }> }, key: string) {
  return report.measures.find((entry) => entry.key === key)?.value ?? null;
}

test('computeCoverageTrendMeasures measures used files, reach, and tests', () => {
  const sample = graph(
    [
      { id: 'src/a.ts', kind: 'module', directory: 'src' },
      { id: 'src/b.ts', kind: 'module', directory: 'src' },
      { id: 'src/a.test.ts', kind: 'test', directory: 'src' },
      { id: 'src/orphan.ts', kind: 'module', directory: 'src' },
    ],
    [edge('src/a.test.ts', 'src/a.ts'), edge('src/a.ts', 'src/b.ts')],
  );
  const measures = computeCoverageTrendMeasures(sample);

  assert.deepEqual(
    measures.map((entry) => entry.key),
    COVERAGE_TREND_MEASURES.map((entry) => entry.key),
  );
  assert.equal(measureOf({ measures }, 'untested'), 0);
  assert.equal(measureOf({ measures }, 'used'), 2, 'the orphan with no dependents is not used');
  assert.equal(measureOf({ measures }, 'reach-share'), 100);
  assert.equal(measureOf({ measures }, 'tests'), 1);
});

test('collectCoverageTrend walks the window and reports the movement per measure', async () => {
  const root = tempRepo();

  // A: a.ts imports b.ts, no tests. Only b is used, and no test reaches it.
  write(root, 'src/b.ts', 'export const b = 1;\n');
  write(root, 'src/a.ts', "import './b.ts';\nexport const a = 1;\n");
  const first = commit(root, 'a imports b');

  // B: a.test.ts reaches a.ts and, through it, b.ts.
  write(root, 'src/a.test.ts', "import { a } from './a.ts';\nexport const t = a;\n");
  const second = commit(root, 'add a test');

  // C: d imports e, and nothing tests either, so e becomes a used-but-untested file.
  write(root, 'src/d.ts', "import './e.ts';\nexport const d = 1;\n");
  write(root, 'src/e.ts', 'export const e = 1;\n');
  const third = commit(root, 'add an untested pair');

  const report = await collectCoverageTrend(root, 'fixture');

  assert.equal(report.available, true);
  assert.equal(report.days, 7);
  assert.deepEqual(
    report.points.map((point) => point.revision),
    [third, second, first],
  );

  assert.deepEqual(
    report.points.map((point) => measureOf(point, 'untested')),
    [1, 0, 1],
  );
  assert.deepEqual(
    report.points.map((point) => measureOf(point, 'used')),
    [3, 2, 1],
  );
  assert.deepEqual(
    report.points.map((point) => measureOf(point, 'reach-share')),
    [66.7, 100, 0],
  );

  const delta = (key: string) => report.deltas.find((entry) => entry.key === key);
  assert.deepEqual(delta('untested'), {
    key: 'untested',
    label: 'Untested used files',
    from: 1,
    to: 1,
    change: 0,
  });
  assert.equal(delta('used')?.change, 2);
  assert.equal(delta('reach-share')?.change, 66.7);
  assert.equal(delta('tests')?.change, 1);
});

test('collectCoverageTrend reports an unavailable repository rather than an empty trend', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-trend-plain-'));
  created.push(root);
  write(root, 'src/a.ts', 'export const a = 1;\n');

  const report = await collectCoverageTrend(root, 'fixture');

  assert.equal(report.available, false);
  assert.equal(report.reason, 'not-a-git-repository');
  assert.deepEqual(report.points, []);
  assert.equal(report.deltas.every((delta) => delta.change === null), true);
});
