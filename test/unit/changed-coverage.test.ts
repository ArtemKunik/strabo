import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  computeChangedLineCoverage,
  summariseChangedCoverage,
} from '../../src/analysis/changed-coverage.ts';
import type { FileDiff } from '../../src/analysis/diff.ts';
import type { MeasuredCoverageSummary } from '../../src/analysis/measured-coverage.ts';
import type { FunctionEntry } from '../../src/analysis/functions.ts';
import type { SymbolChange } from '../../src/analysis/review-types.ts';

test('computeChangedLineCoverage intersects changed lines with covered lines (U4)', () => {
  const diff: FileDiff = {
    file: 'src/parser.ts',
    header: [],
    added: 5,
    removed: 1,
    binary: false,
    hunks: [
      {
        header: '@@ -10,3 +10,5 @@',
        oldStart: 10,
        oldLines: 3,
        newStart: 10,
        newLines: 5,
        lines: [
          { kind: 'context', text: 'function setup() {', oldLine: 10, newLine: 10 },
          { kind: 'add', text: '  const x = 1;', oldLine: null, newLine: 11 },
          { kind: 'add', text: '  const y = 2;', oldLine: null, newLine: 12 },
          { kind: 'add', text: '  const z = 3;', oldLine: null, newLine: 13 },
          { kind: 'add', text: '  const w = 4;', oldLine: null, newLine: 14 },
          { kind: 'context', text: '}', oldLine: 11, newLine: 15 },
        ],
      },
      {
        header: '@@ -30,2 +32,3 @@',
        oldStart: 30,
        oldLines: 2,
        newStart: 32,
        newLines: 3,
        lines: [
          { kind: 'add', text: 'export function parseRow() {', oldLine: null, newLine: 32 },
          { kind: 'context', text: '  return null;', oldLine: 31, newLine: 33 },
        ],
      },
    ],
  };

  const measured: MeasuredCoverageSummary = {
    available: true,
    basis: 'measured',
    format: 'lcov',
    reportPath: 'coverage/lcov.info',
    reportModified: '2026-09-28T12:00:00Z',
    reportAgeMs: 1000,
    files: [
      {
        file: 'src/parser.ts',
        rawPath: 'src/parser.ts',
        inGraph: true,
        lastCommit: '2026-09-28T10:00:00Z',
        stale: false,
        linesFound: 50,
        linesHit: 30,
        lineCoverage: 60,
        functions: [],
        functionsFound: 2,
        functionsHit: 1,
        // Lines 11 and 12 are covered; 13, 14, 32 are uncovered
        coveredLines: [10, 11, 12, 15, 33],
      },
    ],
  };

  const functions: FunctionEntry[] = [
    {
      name: 'setup',
      owner: '',
      visibility: 'private',
      line: 10,
      metrics: { lines: 6, decisionPoints: 1, maxNesting: 1 },
      calls: [],
      callers: [],
      signals: [],
    },
    {
      name: 'parseRow',
      owner: '',
      visibility: 'public',
      line: 32,
      metrics: { lines: 2, decisionPoints: 1, maxNesting: 1 },
      calls: [],
      callers: [],
      signals: [],
    },
  ];

  const publicSymbols: SymbolChange[] = [
    {
      name: 'parseRow',
      owner: '',
      visibility: 'public',
      change: 'changed-signature',
      typeBefore: null,
      typeAfter: null,
      parametersBefore: null,
      parametersAfter: null,
    },
  ];

  const result = computeChangedLineCoverage(diff, measured, { functions, publicSymbols });

  assert.equal(result.file, 'src/parser.ts');
  assert.equal(result.basis, 'measured');
  assert.equal(result.linesChanged, 5); // lines 11, 12, 13, 14, 32
  assert.equal(result.linesCovered, 2); // lines 11, 12
  assert.equal(result.linesUncovered, 3); // lines 13, 14, 32
  assert.equal(result.coveragePercent, 40); // 2 of 5 = 40%
  assert.deepEqual(result.coveredLines, [11, 12]);
  assert.deepEqual(result.uncoveredLines, [13, 14, 32]);

  // Public function parseRow is uncovered and listed first!
  assert.equal(result.uncoveredFunctions.length, 2);
  assert.equal(result.uncoveredFunctions[0]?.name, 'parseRow');
  assert.equal(result.uncoveredFunctions[0]?.isPublic, true);
  assert.equal(result.uncoveredFunctions[0]?.linesUncovered, 1);

  assert.equal(result.uncoveredFunctions[1]?.name, 'setup');
  assert.equal(result.uncoveredFunctions[1]?.isPublic, false);
  assert.equal(result.uncoveredFunctions[1]?.linesUncovered, 2);
});

test('computeChangedLineCoverage reports stale when report predates change (U4)', () => {
  const diff: FileDiff = {
    file: 'src/stale.ts',
    header: [],
    added: 2,
    removed: 0,
    binary: false,
    hunks: [
      {
        header: '@@ -1,1 +1,3 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 3,
        lines: [
          { kind: 'add', text: 'const a = 1;', oldLine: null, newLine: 1 },
          { kind: 'add', text: 'const b = 2;', oldLine: null, newLine: 2 },
          { kind: 'context', text: 'export {};', oldLine: 1, newLine: 3 },
        ],
      },
    ],
  };

  const measured: MeasuredCoverageSummary = {
    available: true,
    basis: 'measured',
    format: 'lcov',
    reportPath: 'coverage/lcov.info',
    reportModified: '2026-09-28T09:00:00Z',
    reportAgeMs: 50000,
    files: [
      {
        file: 'src/stale.ts',
        rawPath: 'src/stale.ts',
        inGraph: true,
        lastCommit: '2026-09-28T12:00:00Z',
        stale: true,
        linesFound: 10,
        linesHit: 8,
        lineCoverage: 80,
        functions: [],
        functionsFound: 0,
        functionsHit: 0,
        coveredLines: [1, 2],
      },
    ],
  };

  const result = computeChangedLineCoverage(diff, measured);
  assert.equal(result.basis, 'stale');
  assert.equal(result.coveragePercent, null);
  assert.equal(result.note, 'report predates the change');
});

test('computeChangedLineCoverage reports unavailable when report is missing or file not in report', () => {
  const diff: FileDiff = {
    file: 'src/unknown.ts',
    header: [],
    added: 1,
    removed: 0,
    binary: false,
    hunks: [
      {
        header: '@@ -0,0 +1,1 @@',
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        lines: [{ kind: 'add', text: 'console.log();', oldLine: null, newLine: 1 }],
      },
    ],
  };

  const unavail = computeChangedLineCoverage(diff, null);
  assert.equal(unavail.basis, 'unavailable');
  assert.equal(unavail.coveragePercent, null);

  const measured: MeasuredCoverageSummary = {
    available: true,
    basis: 'measured',
    format: 'lcov',
    reportPath: 'coverage/lcov.info',
    reportModified: '2026-09-28T12:00:00Z',
    reportAgeMs: 1000,
    files: [],
  };
  const notInReport = computeChangedLineCoverage(diff, measured);
  assert.equal(notInReport.basis, 'unavailable');
  assert.equal(notInReport.note, 'not in report');
});

test('summariseChangedCoverage aggregates across multiple changed files', () => {
  const items = [
    {
      file: 'a.ts',
      basis: 'measured' as const,
      linesChanged: 10,
      linesCovered: 8,
      linesUncovered: 2,
      coveragePercent: 80,
      changedLines: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      coveredLines: [1, 2, 3, 4, 5, 6, 7, 8],
      uncoveredLines: [9, 10],
      uncoveredFunctions: [{ name: 'f1', owner: '', isPublic: true, linesChanged: 5, linesCovered: 3, linesUncovered: 2 }],
    },
    {
      file: 'b.ts',
      basis: 'measured' as const,
      linesChanged: 10,
      linesCovered: 2,
      linesUncovered: 8,
      coveragePercent: 20,
      changedLines: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      coveredLines: [1, 2],
      uncoveredLines: [3, 4, 5, 6, 7, 8, 9, 10],
      uncoveredFunctions: [{ name: 'f2', owner: '', isPublic: false, linesChanged: 8, linesCovered: 0, linesUncovered: 8 }],
    },
  ];

  const totals = summariseChangedCoverage(items);
  assert.equal(totals.filesChanged, 2);
  assert.equal(totals.linesChanged, 20);
  assert.equal(totals.linesCovered, 10);
  assert.equal(totals.linesUncovered, 10);
  assert.equal(totals.coveragePercent, 50); // 10/20 = 50%
  assert.equal(totals.uncoveredFunctionsCount, 2);
});
