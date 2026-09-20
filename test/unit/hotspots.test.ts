import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FunctionEntry, FunctionsReport } from '../../src/analysis/functions.ts';
import { rankHotspots } from '../../src/analysis/hotspots.ts';
import type { FunctionSignal } from '../../src/analysis/signals.ts';

function entry(overrides: Partial<FunctionEntry> = {}): FunctionEntry {
  return {
    name: 'f',
    owner: 'A',
    visibility: 'public',
    line: 1,
    calls: [],
    callers: [],
    signals: [],
    ...overrides,
  };
}

function report(file: string, functions: FunctionEntry[]): FunctionsReport {
  return { file, available: true, functions };
}

const nested: FunctionSignal = { kind: 'nested-loops', line: 3, detail: 'loop nesting 2' };
const long: FunctionSignal = { kind: 'long-function', line: 3, detail: '60 lines' };
const recursion: FunctionSignal = { kind: 'recursion', line: 3, detail: 'calls itself' };

test('rankHotspots keeps only functions with signals and ranks deterministically', () => {
  const result = rankHotspots(
    [
      report('src/b.ts', [
        entry({ name: 'clean', line: 1, signals: [] }),
        entry({ name: 'busy', line: 5, signals: [nested, long], decisionPoints: 4 }),
      ]),
      report('src/a.ts', [
        entry({ name: 'loop', line: 2, signals: [nested], decisionPoints: 6 }),
        entry({ name: 'recur', line: 9, signals: [recursion], decisionPoints: 2 }),
      ]),
    ],
    { limit: 10 },
  );

  assert.equal(result.available, true);
  assert.equal(result.functionsExamined, 4);
  assert.deepEqual(
    result.hotspots.map((spot) => spot.name),
    ['busy', 'loop', 'recur'],
  );
});

test('rankHotspots breaks ties by complexity, size, then file and line', () => {
  const metrics = (decisionPoints: number, lines: number) => ({
    endLine: lines,
    lines,
    statementCount: 1,
    decisionPoints,
    maxNestingDepth: 1,
    loopNestingDepth: 1,
    loops: 0,
    loopScans: [],
    loopSorts: [],
    recursive: false,
  });
  const result = rankHotspots(
    [
      report('src/b.ts', [entry({ name: 'second', line: 1, signals: [nested], metrics: metrics(3, 5) })]),
      report('src/a.ts', [entry({ name: 'first', line: 8, signals: [nested], metrics: metrics(3, 5) })]),
    ],
    { limit: 10 },
  );
  assert.deepEqual(
    result.hotspots.map((spot) => spot.name),
    ['first', 'second'],
  );
});

test('rankHotspots applies the limit and reports skipped files', () => {
  const result = rankHotspots(
    [report('src/a.ts', [entry({ name: 'one', signals: [nested] }), entry({ name: 'two', signals: [long] })])],
    { limit: 1, filesScanned: 2, filesSkipped: 3 },
  );
  assert.equal(result.hotspots.length, 1);
  assert.equal(result.filesScanned, 2);
  assert.equal(result.filesSkipped, 3);
});
