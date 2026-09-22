import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildFunctions,
  computeArchitectureHealth,
  computeCoverage,
  computeMeasuredCoverage,
  detectCoverageFormat,
  extractTypeScriptSymbols,
  mapReportPath,
  measuredFileFigure,
  parseCobertura,
  parseJacoco,
  parseLcov,
  scanRepository,
} from '../../src/index.ts';
import type { Graph, MeasuredCoverageSummary } from '../../src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'coverage-repo');
const noReportFixture = path.resolve(here, '..', 'fixtures', 'sample-repo');

async function loadGraph(root = fixture): Promise<Graph> {
  return (await scanRepository(root)).graph;
}

function fileOf(report: ReturnType<typeof parseLcov>, rawPath: string) {
  const entry = report.files.find((candidate) => candidate.rawPath === rawPath);
  assert.ok(entry, `expected ${rawPath}`);
  return entry;
}

test('parseLcov reads per-file lines and per-function execution counts', () => {
  const report = parseLcov(
    [
      'SF:src/zero.ts',
      'FN:1,zero',
      'FNDA:0,zero',
      'FNF:1',
      'FNH:0',
      'DA:1,0',
      'DA:2,0',
      'end_of_record',
    ].join('\n'),
  );

  const entry = fileOf(report, 'src/zero.ts');
  assert.equal(entry.linesFound, 2);
  assert.equal(entry.linesHit, 0);
  assert.equal(entry.lineCoverage, 0);
  assert.equal(entry.functions[0]?.name, 'zero');
  assert.equal(entry.functions[0]?.hits, 0);
  // LCOV records execution, not a function line span, so per-function line coverage is null.
  assert.equal(entry.functions[0]?.lineCoverage, null);
});

test('parseCobertura reads classes, class lines, and method lines without double-counting', () => {
  const report = parseCobertura(
    [
      '<?xml version="1.0" ?>',
      '<coverage line-rate="0.5" lines-valid="4" lines-covered="2">',
      '<packages><package name="app"><classes>',
      '<class name="app.A" filename="app/a.py" lines-valid="4" lines-covered="2">',
      '<methods>',
      '<method name="run" signature="()" line-rate="1.0"><lines>',
      '<line number="3" hits="1"/><line number="4" hits="2"/></lines></method>',
      '<method name="skip" signature="()" line-rate="0.0"><lines>',
      '<line number="8" hits="0"/></lines></method>',
      '</methods>',
      '<lines><line number="1" hits="0"/><line number="3" hits="1"/>',
      '<line number="4" hits="2"/><line number="8" hits="0"/></lines>',
      '</class></classes></package></packages></coverage>',
    ].join('\n'),
  );

  const entry = fileOf(report, 'app/a.py');
  assert.equal(entry.linesFound, 4);
  assert.equal(entry.linesHit, 2);
  assert.equal(entry.lineCoverage, 50);
  const run = entry.functions.find((fn) => fn.name === 'run');
  const skip = entry.functions.find((fn) => fn.name === 'skip');
  assert.equal(run?.linesHit, 2);
  assert.equal(run?.lineCoverage, 100);
  assert.equal(skip?.lineCoverage, 0);
});

test('parseJacoco reads package/sourcefile paths and per-method line counters', () => {
  const report = parseJacoco(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<report name="demo">',
      '<package name="com/example">',
      '<sourcefile name="A.java">',
      '<line nr="3" mi="0" ci="5" mb="0" cb="0"/>',
      '<line nr="4" mi="1" ci="0" mb="0" cb="0"/>',
      '</sourcefile>',
      '<class name="com/example/A" sourcefilename="A.java">',
      '<method name="run" desc="()V" line="3"><counter type="LINE" missed="0" covered="2"/></method>',
      '<method name="skip" desc="()V" line="8"><counter type="LINE" missed="1" covered="0"/></method>',
      '<counter type="LINE" missed="1" covered="1"/>',
      '</class>',
      '</package></report>',
    ].join('\n'),
  );

  const entry = fileOf(report, 'com/example/A.java');
  assert.equal(entry.linesFound, 2);
  assert.equal(entry.linesHit, 1);
  assert.equal(entry.lineCoverage, 50);
  const run = entry.functions.find((fn) => fn.name === 'run');
  assert.equal(run?.lineCoverage, 100);
  assert.equal(run?.line, 3);
  assert.equal(entry.functions.find((fn) => fn.name === 'skip')?.lineCoverage, 0);
});

test('detectCoverageFormat tells the three formats apart', () => {
  assert.equal(detectCoverageFormat('coverage/lcov.info', 'SF:src/a.ts\nDA:1,1\n'), 'lcov');
  assert.equal(detectCoverageFormat('coverage.xml', '<coverage line-rate="1"/>'), 'cobertura');
  assert.equal(detectCoverageFormat('target/site/jacoco/jacoco.xml', '<report name="r"/>'), 'jacoco');
  assert.equal(detectCoverageFormat('notes.txt', 'hello'), null);
});

test('mapReportPath maps an absolute path under root and keeps an outside one literal', () => {
  const root = path.resolve('/work/repo');
  assert.equal(mapReportPath(root, 'src/a.ts'), 'src/a.ts');
  assert.equal(mapReportPath(root, './src/a.ts'), 'src/a.ts');
  assert.equal(mapReportPath(root, path.join(root, 'src', 'a.ts')), 'src/a.ts');
  assert.equal(mapReportPath(root, path.join('/', 'elsewhere', 'a.ts')).replace(/\\/g, '/'), '/elsewhere/a.ts');
});

test('acceptance: a file imported by a test with zero covered lines is reachable yet measured 0%', async () => {
  const graph = await loadGraph();
  const reach = computeCoverage(graph);
  assert.ok(reach.reached.includes('src/zero.ts'), 'zero.ts is imported by a test');

  const measured = await computeMeasuredCoverage(fixture, graph);
  assert.equal(measured.available, true);
  assert.equal(measured.basis, 'measured');
  assert.equal(measured.format, 'lcov');
  assert.equal(measured.reportPath, 'coverage/lcov.info');

  const figure = measuredFileFigure(measured, 'src/zero.ts');
  assert.equal(figure?.basis, 'measured');
  assert.equal(figure?.value, 0);

  const zero = measured.files.find((entry) => entry.file === 'src/zero.ts');
  assert.equal(zero?.inGraph, true);
  assert.equal(zero?.lineCoverage, 0);
  assert.equal(zero?.linesHit, 0);

  // The test file is the one that reaches it, so the two methods genuinely disagree.
  const half = measured.files.find((entry) => entry.file === 'src/half.ts');
  assert.equal(half?.lineCoverage, 75);
});

test('a report path outside the graph is listed, never silently dropped', async () => {
  const graph = await loadGraph();
  const measured = await computeMeasuredCoverage(fixture, graph);

  assert.deepEqual(measured.outOfGraph, ['vendor/generated.ts']);
  const entry = measured.files.find((candidate) => candidate.file === 'vendor/generated.ts');
  assert.equal(entry?.inGraph, false);
  // Only graph nodes count toward the summary.
  assert.equal(measured.summary.filesMeasured, 2);
});

test('a report older than the file last commit is marked stale, and younger is not', async () => {
  const graph = await loadGraph();
  const stale = await computeMeasuredCoverage(fixture, graph, {
    modifiedAt: () => '2024-01-01T00:00:00.000Z',
    lastCommitAt: async () => '2024-06-01T00:00:00.000Z',
  });
  assert.ok(stale.stale.includes('src/zero.ts'));
  assert.ok(stale.stale.includes('src/half.ts'));

  const fresh = await computeMeasuredCoverage(fixture, graph, {
    modifiedAt: () => '2024-06-01T00:00:00.000Z',
    lastCommitAt: async () => '2024-01-01T00:00:00.000Z',
  });
  assert.deepEqual(fresh.stale, []);
});

test('an absent report is unavailable with a reason, not zeros', async () => {
  const graph = await loadGraph(noReportFixture);
  const measured = await computeMeasuredCoverage(noReportFixture, graph);

  assert.equal(measured.available, false);
  assert.equal(measured.basis, 'reachable');
  assert.equal(measured.reason, 'no-report-found');
  assert.deepEqual(measured.files, []);
  assert.equal(measured.summary.lineCoverage, null);
});

test('a malformed report is unavailable with a reason, not zeros', async () => {
  const graph = await loadGraph();
  const measured = await computeMeasuredCoverage(fixture, graph, {
    reportPaths: ['coverage/lcov.info'],
    readReport: () => 'this is not a coverage report',
  });

  assert.equal(measured.available, false);
  assert.equal(measured.reason, 'report-malformed');
  assert.deepEqual(measured.skipped, [{ path: 'coverage/lcov.info', reason: 'malformed' }]);
});

test('an explicit report path outside the scan ceiling is never read', async () => {
  const graph = await loadGraph();
  const outside = path.resolve(fixture, '..', 'sample-repo', 'lcov.info');
  const measured = await computeMeasuredCoverage(fixture, graph, {
    reportPaths: [outside],
    ceiling: fixture,
  });
  assert.equal(measured.reason, 'no-report-found');
});

test('the architecture health coverage axis labels measured when a report is read', async () => {
  const graph = await loadGraph();
  const measured = await computeMeasuredCoverage(fixture, graph);
  const report = computeArchitectureHealth(graph, measured);
  const coverage = report.axes.find((axis) => axis.key === 'coverage');

  assert.equal(coverage?.basis, 'measured');
  assert.equal(coverage?.value, 50);
  assert.match(coverage?.detail ?? '', /measured 50% line coverage/);
  assert.equal(report.coverage?.basis, 'measured');

  const fallback = computeArchitectureHealth(graph);
  const reachable = fallback.axes.find((axis) => axis.key === 'coverage');
  assert.equal(reachable?.basis, 'reachable');
  assert.match(reachable?.detail ?? '', /reachable from tests/);
});

test('a measured report with no line counts falls back to reachable and says so', async () => {
  const graph = await loadGraph();
  const noLines: MeasuredCoverageSummary = {
    available: true,
    basis: 'measured',
    format: 'lcov',
    reportPath: 'coverage/lcov.info',
    reportModified: '2024-01-01T00:00:00.000Z',
    reportAgeMs: 1000,
    reason: 'no-lines-recorded',
    skipped: [],
    outOfGraph: [],
    files: [],
    stale: [],
    summary: { filesMeasured: 2, linesFound: 0, linesHit: 0, lineCoverage: null },
  };

  const coverage = computeArchitectureHealth(graph, noLines).axes.find((axis) => axis.key === 'coverage');
  assert.equal(coverage?.basis, 'reachable');
  assert.match(coverage?.detail ?? '', /records no line counts/);
});

test('buildFunctions attaches measured coverage and leaves an unnamed function unavailable', async () => {
  const source = ['function measured(): number {', '  return 1;', '}', 'function unnamed(): number {', '  return 2;', '}'].join('\n');
  const { symbols, calls = [] } = await extractTypeScriptSymbols('m.ts', source);
  const report = buildFunctions('m.ts', symbols, calls, [
    { name: 'measured', line: 1, linesFound: 2, linesHit: 0, lineCoverage: 0, hits: 0 },
  ]);

  const measured = report.functions.find((entry) => entry.name === 'measured');
  const unnamed = report.functions.find((entry) => entry.name === 'unnamed');
  assert.equal(measured?.coverage?.lineCoverage, 0);
  assert.equal(unnamed?.coverage, undefined);
});
