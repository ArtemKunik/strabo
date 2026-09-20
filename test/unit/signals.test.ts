import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SIGNAL_THRESHOLDS, computeSignals } from '../../src/index.ts';
import type { CodeSymbol, FunctionMetrics } from '../../src/index.ts';

const BASE_METRICS: FunctionMetrics = {
  endLine: 10,
  lines: 10,
  statementCount: 5,
  decisionPoints: 1,
  maxNestingDepth: 1,
  loopNestingDepth: 1,
  loops: 1,
  loopScans: [],
  loopSorts: [],
  recursive: false,
};

function makeSymbol(overrides: Partial<CodeSymbol> = {}): CodeSymbol {
  return {
    name: 'f',
    kind: 'method',
    visibility: 'public',
    owner: 'A',
    line: 1,
    metrics: { ...BASE_METRICS },
    ...overrides,
  };
}

test('computeSignals records nothing for a signature without a body', () => {
  assert.deepEqual(computeSignals(makeSymbol({ metrics: undefined })), []);
});

test('computeSignals records nothing for a function below every threshold', () => {
  assert.deepEqual(computeSignals(makeSymbol()), []);
});

test('computeSignals flags each threshold it crosses', () => {
  const kinds = (overrides: Partial<CodeSymbol>, metrics: Partial<FunctionMetrics>) =>
    computeSignals(
      makeSymbol({ ...overrides, metrics: { ...BASE_METRICS, ...metrics } }),
    ).map((signal) => signal.kind);

  assert.deepEqual(kinds({}, { loopNestingDepth: SIGNAL_THRESHOLDS.nestedLoops }), ['nested-loops']);
  assert.deepEqual(kinds({}, { loopScans: ['includes'] }), ['linear-scan-in-loop']);
  assert.deepEqual(kinds({}, { loopSorts: ['sort'] }), ['sort-in-loop']);
  assert.deepEqual(kinds({}, { maxNestingDepth: SIGNAL_THRESHOLDS.deepNesting }), ['deep-nesting']);
  assert.deepEqual(kinds({}, { decisionPoints: SIGNAL_THRESHOLDS.highComplexity }), ['high-complexity']);
  assert.deepEqual(kinds({}, { lines: SIGNAL_THRESHOLDS.longFunction }), ['long-function']);
  assert.deepEqual(kinds({ parameters: SIGNAL_THRESHOLDS.manyParameters }, {}), ['many-parameters']);
  assert.deepEqual(kinds({}, { recursive: true }), ['recursion']);
});

test('computeSignals names the recorded value in its detail', () => {
  const signals = computeSignals(
    makeSymbol({ metrics: { ...BASE_METRICS, loopNestingDepth: 3 } }),
  );
  assert.equal(signals[0]?.kind, 'nested-loops');
  assert.match(signals[0]?.detail ?? '', /loop nesting 3/);
});
