import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeRiskyUntested, riskyUntestedCaption } from '../../src/analysis/coverage-risk.ts';

function hotspots(list) {
  return {
    available: true,
    filesScanned: 1,
    filesSkipped: 0,
    functionsExamined: list.length,
    hotspots: list,
  };
}

test('computeRiskyUntested ranks by complexity × churn × uncovered, showing every input (U5)', () => {
  const report = computeRiskyUntested({
    hotspots: hotspots([
      {
        file: 'a.ts',
        owner: 'A',
        name: 'parseRow',
        line: 5,
        decisionPoints: 20,
        lines: 60,
        signals: [],
        coverage: { name: 'parseRow', line: 5, linesFound: 40, linesHit: 0, lineCoverage: 0, hits: 0 },
      },
      {
        file: 'b.ts',
        owner: 'B',
        name: 'small',
        line: 9,
        decisionPoints: 2,
        lines: 8,
        signals: [],
        coverage: { name: 'small', line: 9, linesFound: 4, linesHit: 4, lineCoverage: 100, hits: 1 },
      },
      {
        file: 'c.ts',
        owner: 'C',
        name: 'noInputs',
        line: 1,
        decisionPoints: 0,
        lines: 3,
        signals: [],
      },
    ]),
    churnByFile: new Map([
      ['a.ts', 12],
      ['b.ts', 2],
    ]),
  });

  assert.equal(report.available, true);
  assert.deepEqual(report.rows.map((row) => row.name), ['parseRow', 'small']);
  assert.deepEqual(report.rows[0], {
    file: 'a.ts',
    name: 'parseRow',
    line: 5,
    complexity: 20,
    churn: 12,
    uncoveredShare: 1,
    inputs: ['complexity', 'churn', 'uncovered'],
    rankScore: 240,
    untested: true,
  });
  assert.equal(report.rows[1]?.untested, false, 'a fully covered function is not untested');
  assert.equal(report.unranked, 1, 'a function with no input is counted, not ranked');
  assert.deepEqual(report.inputs, { complexity: true, churn: true, coverage: true });
});

test('computeRiskyUntested names a missing input instead of counting it as zero (U5)', () => {
  const report = computeRiskyUntested({
    hotspots: hotspots([
      {
        file: 'a.ts',
        owner: 'A',
        name: 'run',
        line: 2,
        decisionPoints: 8,
        lines: 20,
        signals: [],
      },
    ]),
  });
  assert.deepEqual(report.rows[0]?.inputs, ['complexity']);
  assert.equal(report.rows[0]?.churn, null);
  assert.equal(report.rows[0]?.uncoveredShare, null);
  assert.equal(report.rows[0]?.untested, true, 'no coverage figure means we cannot call it tested');
  assert.deepEqual(report.inputs, { complexity: true, churn: false, coverage: false });

  const caption = riskyUntestedCaption(report);
  assert.match(caption, /ranked by complexity/);
  assert.match(caption, /churn and uncovered share not recorded here/);
});

test('riskyUntestedCaption reports an empty or unavailable list plainly (U5)', () => {
  assert.match(riskyUntestedCaption(null), /unavailable/);
  assert.match(
    riskyUntestedCaption({ available: true, rows: [], inputs: { complexity: false, churn: false, coverage: false }, unranked: 0 }),
    /No function has a recorded/,
  );
});
