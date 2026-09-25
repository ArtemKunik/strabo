import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  computeMeasuredCoverage,
  fileCoverage,
  scanRepository,
  summariseFileCoverage,
} from '../../src/index.ts';
import type { Graph } from '../../src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'coverage-repo');
const noReportFixture = path.resolve(here, '..', 'fixtures', 'sample-repo');

async function loadGraph(root = fixture): Promise<Graph> {
  return (await scanRepository(root)).graph;
}

/** Fixed dates so staleness never depends on this repository's own git history. */
const freshDates = {
  modifiedAt: () => '2024-06-01T00:00:00.000Z',
  lastCommitAt: async () => '2024-01-01T00:00:00.000Z',
};

test('fileCoverage: a file the report names is measured, and a reached 0% file stays 0%', async () => {
  const graph = await loadGraph();
  const measured = await computeMeasuredCoverage(fixture, graph, freshDates);
  const byFile = fileCoverage(graph, measured);

  const zero = byFile.get('src/zero.ts');
  assert.equal(zero?.basis, 'measured');
  assert.equal(zero?.value, 0);
  assert.equal(zero?.linesHit, 0);
  assert.equal(zero?.linesFound, 2);
  assert.equal(zero?.stale, false);
  // Reachability is kept alongside as the labelled fallback: a test does import it.
  assert.equal(zero?.reached, true);
  assert.equal(zero?.notInReport, false);

  const half = byFile.get('src/half.ts');
  assert.equal(half?.basis, 'measured');
  assert.equal(half?.value, 75);
  assert.equal(half?.linesHit, 3);
  assert.equal(half?.linesFound, 4);
});

test('fileCoverage: a graph file the report does not name is not in report, never 0%', async () => {
  const graph = await loadGraph();
  const measured = await computeMeasuredCoverage(fixture, graph, freshDates);
  const test = fileCoverage(graph, measured).get('src/zero.test.ts');

  assert.equal(test?.basis, 'reachable');
  assert.equal(test?.notInReport, true);
  assert.equal(test?.value, null);
  assert.equal(test?.linesHit, null);
  assert.equal(test?.linesFound, null);
});

test('fileCoverage: report-named paths outside the graph get no entry', async () => {
  const graph = await loadGraph();
  const measured = await computeMeasuredCoverage(fixture, graph, freshDates);
  const byFile = fileCoverage(graph, measured);

  assert.equal(byFile.has('vendor/generated.ts'), false);
  assert.deepEqual([...byFile.keys()].sort(), graph.nodes.map((node) => node.id).sort());
});

test('fileCoverage: a stale report marks its figures stale', async () => {
  const graph = await loadGraph();
  const measured = await computeMeasuredCoverage(fixture, graph, {
    modifiedAt: () => '2024-01-01T00:00:00.000Z',
    lastCommitAt: async () => '2024-06-01T00:00:00.000Z',
  });
  assert.equal(fileCoverage(graph, measured).get('src/half.ts')?.stale, true);
});

test('fileCoverage: with no report every file is reachable-basis and none is "not in report"', async () => {
  const graph = await loadGraph(noReportFixture);
  const measured = await computeMeasuredCoverage(noReportFixture, graph);
  assert.equal(measured.available, false);

  for (const figures of [fileCoverage(graph, measured), fileCoverage(graph, null), fileCoverage(graph)]) {
    assert.equal(figures.size, graph.nodes.length);
    for (const figure of figures.values()) {
      assert.equal(figure.basis, 'reachable');
      assert.equal(figure.value, null);
      assert.equal(figure.notInReport, false);
      assert.equal(figure.stale, null);
    }
  }
});

test('fileCoverage: the reachability fallback matches test reach', async () => {
  const graph = await loadGraph();
  const byFile = fileCoverage(graph);
  assert.equal(byFile.get('src/zero.ts')?.reached, true);
  assert.equal(byFile.get('src/half.ts')?.reached, true);
  // A test file counts as reached: it is the test.
  assert.equal(byFile.get('src/half.test.ts')?.reached, true);
});

test('fileCoverage: each figure carries the report age (U2)', async () => {
  const graph = await loadGraph();
  const measured = await computeMeasuredCoverage(fixture, graph, freshDates);
  const byFile = fileCoverage(graph, measured);

  assert.equal(byFile.get('src/zero.ts')?.reportModified, '2024-06-01T00:00:00.000Z');
  assert.equal(typeof byFile.get('src/zero.ts')?.reportAgeMs, 'number');
  // With no report, the age is unrecorded, never a stand-in date.
  assert.equal(fileCoverage(graph, null).get('src/zero.ts')?.reportModified, null);
  assert.equal(fileCoverage(graph, null).get('src/zero.ts')?.reportAgeMs, null);
});

test('summariseFileCoverage sums one basis and keeps not-in-report apart from 0% (U2)', async () => {
  const graph = await loadGraph();
  const measured = await computeMeasuredCoverage(fixture, graph, freshDates);
  const byFile = fileCoverage(graph, measured);

  const aggregate = summariseFileCoverage(['src/zero.ts', 'src/half.ts', 'src/zero.test.ts'], byFile);
  assert.equal(aggregate.basis, 'measured');
  assert.equal(aggregate.files, 3);
  assert.equal(aggregate.filesMeasured, 2);
  assert.equal(aggregate.notInReport, 1, 'zero.test.ts is named by no report, not counted as 0%');
  assert.equal(aggregate.linesFound, 6);
  assert.equal(aggregate.linesHit, 3);
  assert.equal(aggregate.value, 50);
  assert.equal(aggregate.reached, 3);
  assert.equal(aggregate.reportAgeMs !== null, true);
});

test('summariseFileCoverage falls back to reachability with no report (U2)', async () => {
  const graph = await loadGraph(noReportFixture);
  const measured = await computeMeasuredCoverage(noReportFixture, graph);
  assert.equal(measured.available, false);

  const first = graph.nodes[0]?.id;
  assert.ok(first, 'the fixture has a file to summarise');
  const aggregate = summariseFileCoverage([first], fileCoverage(graph, measured));
  assert.equal(aggregate.basis, 'reachable');
  assert.equal(aggregate.value, null);
  assert.equal(aggregate.reportAgeMs, null);
  assert.equal(aggregate.notInReport, 0);
});
