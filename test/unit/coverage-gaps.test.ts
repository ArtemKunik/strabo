import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  computeCoverageGaps,
  computeMeasuredCoverage,
  scanRepository,
} from '../../src/index.ts';
import type { Graph, GraphEdge, GraphNode } from '../../src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'coverage-repo');

/** Fixed dates so staleness never depends on this repository's own git history. */
const freshDates = {
  modifiedAt: () => '2024-06-01T00:00:00.000Z',
  lastCommitAt: async () => '2024-01-01T00:00:00.000Z',
};

function node(id: string, kind: GraphNode['kind'] = 'module'): GraphNode {
  return { id, kind, directory: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '.' };
}

function edge(source: string, target: string): GraphEdge {
  return { source, target, kind: 'import', evidence: { line: 1, specifier: target, resolution: 'exact' } };
}

function graphOf(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  return { nodes, edges, diagnostics: [], excluded: [] };
}

test('computeCoverageGaps ranks a used, uncovered file on the measured basis', async () => {
  const graph = (await scanRepository(fixture)).graph;
  const measured = await computeMeasuredCoverage(fixture, graph, freshDates);
  const report = computeCoverageGaps(graph, measured);

  assert.equal(report.basis, 'measured');
  assert.equal(report.threshold, 50);
  assert.equal(report.total, 1);
  assert.equal(report.notInReport, 0);
  assert.deepEqual(report.gaps.map((gap) => gap.file), ['src/zero.ts']);

  const zero = report.gaps[0];
  assert.ok(zero);
  assert.equal(zero.basis, 'measured');
  assert.equal(zero.value, 0);
  assert.equal(zero.dependents, 1);
  assert.equal(zero.transitiveDependents, 1);
  assert.equal(zero.reached, true, 'a test reaches it; it is still under the threshold');
  assert.deepEqual(zero.tests, ['src/zero.test.ts']);
});

test('computeCoverageGaps honours a caller threshold and caps the listed gaps', async () => {
  const graph = (await scanRepository(fixture)).graph;
  const measured = await computeMeasuredCoverage(fixture, graph, freshDates);

  const raised = computeCoverageGaps(graph, measured, { threshold: 80 });
  assert.deepEqual(raised.gaps.map((gap) => gap.file), ['src/zero.ts', 'src/half.ts']);
  assert.equal(raised.threshold, 80);

  const capped = computeCoverageGaps(graph, measured, { threshold: 80, limit: 1 });
  assert.equal(capped.total, 2, 'total stays the full count');
  assert.equal(capped.gaps.length, 1);
});

test('computeCoverageGaps falls back to reachability and ranks by blast radius', () => {
  const graph = graphOf(
    [node('src/testA.ts', 'test'), node('src/a.ts'), node('src/d.ts'), node('src/e.ts'), node('src/b.ts')],
    [edge('src/testA.ts', 'src/a.ts'), edge('src/d.ts', 'src/e.ts'), edge('src/e.ts', 'src/b.ts')],
  );
  const report = computeCoverageGaps(graph, null);

  assert.equal(report.basis, 'reachable');
  assert.deepEqual(report.gaps.map((gap) => gap.file), ['src/b.ts', 'src/e.ts']);
  const b = report.gaps[0];
  assert.ok(b);
  assert.equal(b.basis, 'reachable');
  assert.equal(b.value, null);
  assert.equal(b.dependents, 1);
  assert.equal(b.transitiveDependents, 2, 'd and e both depend on b');
  assert.equal(b.reached, false);
  assert.deepEqual(b.tests, []);
});

test('computeCoverageGaps marks a file in a recorded cycle', () => {
  const graph = graphOf(
    [node('src/p.ts'), node('src/q.ts')],
    [edge('src/p.ts', 'src/q.ts'), edge('src/q.ts', 'src/p.ts')],
  );
  const report = computeCoverageGaps(graph, null);

  assert.equal(report.total, 2);
  assert.deepEqual(
    report.gaps.map((gap) => gap.cycleSize),
    [2, 2],
  );
});

test('computeCoverageGaps counts a used file the report does not name without calling it 0%', async () => {
  const graph = (await scanRepository(fixture)).graph;
  const measured = await computeMeasuredCoverage(fixture, graph, freshDates);
  // Name only half.ts, so zero.ts is a used file the report leaves out.
  const partial = {
    ...measured,
    files: measured.files.filter((entry) => entry.file === 'src/half.ts'),
  };
  const report = computeCoverageGaps(graph, partial);

  assert.equal(report.basis, 'measured');
  assert.equal(report.notInReport, 1, 'src/zero.ts is used and unnamed');
  assert.deepEqual(report.gaps, [], 'an unnamed file is not counted as a gap');
});
