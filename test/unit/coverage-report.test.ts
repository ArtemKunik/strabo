import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  computeMeasuredCoverage,
  fileCoverageReport,
  folderCoverageReport,
  normaliseFolder,
  projectCoverageReport,
  scanRepository,
} from '../../src/index.ts';
import type { Graph } from '../../src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'coverage-repo');
const noReportFixture = path.resolve(here, '..', 'fixtures', 'sample-repo');

/** Fixed dates so staleness never depends on this repository's own git history. */
const freshDates = {
  modifiedAt: () => '2024-06-01T00:00:00.000Z',
  lastCommitAt: async () => '2024-01-01T00:00:00.000Z',
};

async function loadGraph(root = fixture): Promise<Graph> {
  return (await scanRepository(root)).graph;
}

test('projectCoverageReport sums measured figures and never counts not-in-report as 0%', async () => {
  const graph = await loadGraph();
  const measured = await computeMeasuredCoverage(fixture, graph, freshDates);
  const report = projectCoverageReport(graph, measured);

  assert.equal(report.scope, 'project');
  assert.equal(report.subject, '.');
  assert.equal(report.threshold, 50);
  assert.equal(report.provenance.available, true);
  assert.equal(report.provenance.format, 'lcov');
  assert.equal(report.totals.files, graph.nodes.length);
  assert.equal(report.totals.basis, 'measured');
  assert.equal(report.totals.filesMeasured, 2);
  assert.equal(report.totals.notInReport, 2, 'the two test files are named by no report');
  assert.equal(report.totals.linesHit, 3);
  assert.equal(report.totals.linesFound, 6);
  assert.equal(report.totals.value, 50);
  assert.equal(report.totals.reached, graph.nodes.length);
  assert.equal(report.totals.untested, 1, 'only src/zero.ts is used and under 50%');

  assert.deepEqual(
    report.folders?.map((entry) => ({
      folder: entry.folder,
      files: entry.files,
      filesMeasured: entry.filesMeasured,
      value: entry.value,
    })),
    [{ folder: 'src', files: graph.nodes.length, filesMeasured: 2, value: 50 }],
  );
});

test('projectCoverageReport honours a caller threshold', async () => {
  const graph = await loadGraph();
  const measured = await computeMeasuredCoverage(fixture, graph, freshDates);
  const report = projectCoverageReport(graph, measured, 80);
  assert.equal(report.threshold, 80);
  assert.equal(report.totals.untested, 2, 'half.ts at 75% is under an 80% cut-off');
});

test('projectCoverageReport falls back to reachability with no report', async () => {
  const graph = await loadGraph(noReportFixture);
  const measured = await computeMeasuredCoverage(noReportFixture, graph);
  const report = projectCoverageReport(graph, measured);

  assert.equal(report.provenance.available, false);
  assert.equal(report.provenance.reason, 'no-report-found');
  assert.equal(report.totals.basis, 'reachable');
  assert.equal(report.totals.value, null);
  assert.equal(report.totals.filesMeasured, 0);
  assert.equal(report.totals.notInReport, 0);
});

test('folderCoverageReport rolls up the subtree and lists its direct files', async () => {
  const graph = await loadGraph();
  const measured = await computeMeasuredCoverage(fixture, graph, freshDates);
  const report = folderCoverageReport(graph, measured, 'src');

  assert.equal(report.scope, 'folder');
  assert.equal(report.subject, 'src');
  assert.equal(report.totals.value, 50);
  assert.equal(report.totals.filesMeasured, 2);
  assert.equal(report.totals.untested, 1);
  assert.deepEqual(report.folders, [], 'src holds no subfolder in this fixture');
  assert.deepEqual(
    report.files?.map((entry) => entry.file),
    ['src/half.test.ts', 'src/half.ts', 'src/zero.test.ts', 'src/zero.ts'],
  );
});

test('normaliseFolder maps the root and strips separators', () => {
  assert.equal(normaliseFolder('/'), '.');
  assert.equal(normaliseFolder(''), '.');
  assert.equal(normaliseFolder('./src/'), 'src');
  assert.equal(normaliseFolder('src\\api\\'), 'src/api');
});

test('fileCoverageReport names the tests and importers behind the figure', async () => {
  const graph = await loadGraph();
  const measured = await computeMeasuredCoverage(fixture, graph, freshDates);

  const half = fileCoverageReport(graph, measured, 'src/half.ts');
  assert.ok(half?.file);
  assert.equal(half.file.value, 75);
  assert.equal(half.file.basis, 'measured');
  assert.equal(half.file.untested, false);
  assert.deepEqual(half.file.tests, ['src/half.test.ts']);
  assert.deepEqual(half.file.importers, ['src/half.test.ts']);

  const zero = fileCoverageReport(graph, measured, 'src/zero.ts');
  assert.equal(zero?.file?.value, 0);
  assert.equal(zero?.file?.untested, true);

  assert.equal(fileCoverageReport(graph, measured, 'src/missing.ts'), null);
});

test('fileCoverageReport reports a file the report does not name as not-in-report', async () => {
  const graph = await loadGraph();
  const measured = await computeMeasuredCoverage(fixture, graph, freshDates);
  const test = fileCoverageReport(graph, measured, 'src/half.test.ts');

  assert.equal(test?.file?.basis, 'reachable');
  assert.equal(test?.file?.value, null);
  assert.equal(test?.file?.notInReport, true);
  assert.deepEqual(test?.file?.tests, ['src/half.test.ts']);
});
