import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

import { collectDrift, computeDriftMeasures, DRIFT_MEASURES } from '../../src/analysis/drift.ts';
import { clearStructuralDiffCache } from '../../src/analysis/structural-diff.ts';
import type { Graph } from '../../src/types.ts';

const created: string[] = [];
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-drift-cache-'));
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-drift-'));
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

function measureOf(graphValue: Graph, key: string): number | null {
  const measure = computeDriftMeasures(graphValue).find((entry) => entry.key === key);
  return measure ? measure.value : null;
}

test('computeDriftMeasures derives counts from a hand-built graph', () => {
  const sample = graph(
    [
      { id: 'src/a.ts', kind: 'module', directory: 'src' },
      { id: 'src/b.ts', kind: 'module', directory: 'src' },
      { id: 'src/nested/c.ts', kind: 'module', directory: 'src/nested' },
      { id: 'lib/d.ts', kind: 'module', directory: 'lib' },
      { id: 'e.ts', kind: 'module', directory: '.' },
    ],
    [
      edge('src/a.ts', 'src/b.ts'),
      edge('src/b.ts', 'src/a.ts'),
      edge('src/a.ts', 'src/nested/c.ts'),
      edge('src/nested/c.ts', 'lib/d.ts'),
    ],
  );

  const measures = computeDriftMeasures(sample);
  assert.deepEqual(
    measures.map((entry) => entry.key),
    DRIFT_MEASURES.map((entry) => entry.key),
  );
  assert.equal(measures.length, 8);
  assert.equal(measureOf(sample, 'cycles'), 1);
  assert.equal(measureOf(sample, 'largest-cycle'), 2);
  assert.equal(measureOf(sample, 'modules'), 5);
  assert.equal(measureOf(sample, 'largest-module'), 3);
  assert.equal(measureOf(sample, 'edges'), 4);
  assert.equal(measureOf(sample, 'largest-blast-radius'), 3);
  assert.equal(measureOf(sample, 'hidden-coupling-share'), null);
  assert.equal(measureOf(sample, 'tier-violations'), null);
});

test('collectDrift walks three commits and reports the structural timeline', async () => {
  const root = tempRepo();

  // A: two files, a.ts imports b.ts.
  write(root, 'src/b.ts', 'export const b = 1;\n');
  write(root, 'src/a.ts', "import './b.ts';\nexport const a = 1;\n");
  const first = commit(root, 'a imports b');

  // B: a third file, c.ts imports a.ts.
  write(root, 'src/c.ts', "import './a.ts';\nexport const c = 1;\n");
  const second = commit(root, 'c imports a');

  // C: close the loop, b.ts imports c.ts.
  write(root, 'src/b.ts', "import './c.ts';\nexport const b = 1;\n");
  const third = commit(root, 'b imports c');

  const report = await collectDrift(root, 'fixture');

  assert.equal(report.available, true);
  assert.equal(report.repository, 'fixture');
  assert.equal(report.base, null);
  assert.equal(report.points.length, 3);

  // `git log` walks newest first, so C, B, A.
  assert.deepEqual(
    report.points.map((point) => point.revision),
    [third, second, first],
  );
  assert.equal(report.points[0].short.length, 7);
  assert.equal(typeof report.points[0].date, 'string');
  assert.equal(report.points[0].subject, 'b imports c');

  const series = (key: string) => report.series.find((entry) => entry.key === key);
  // Newest first: C introduces the cycle, B and A have none.
  assert.deepEqual(series('cycles')?.points.map((point) => point.value), [1, 0, 0]);
  // Modules grow 2 -> 3 -> 3, so newest first is 3, 3, 2.
  assert.deepEqual(series('modules')?.points.map((point) => point.value), [3, 3, 2]);
  assert.deepEqual(
    series('hidden-coupling-share')?.points.map((point) => point.value),
    [null, null, null],
  );
  assert.deepEqual(
    series('tier-violations')?.points.map((point) => point.value),
    [null, null, null],
  );
  // Every series carries the same revisions in the same order as the points.
  assert.deepEqual(
    series('cycles')?.points.map((point) => point.revision),
    report.points.map((point) => point.revision),
  );
});

test('collectDrift reports an unavailable repository rather than an empty timeline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-drift-plain-'));
  created.push(root);
  write(root, 'src/a.ts', 'export const a = 1;\n');

  const report = await collectDrift(root, 'fixture');

  assert.equal(report.available, false);
  assert.equal(report.reason, 'not-a-git-repository');
  assert.deepEqual(report.points, []);
});
