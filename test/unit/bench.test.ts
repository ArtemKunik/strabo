import assert from 'node:assert/strict';
import { test } from 'node:test';

import { STAGE_NAMES, formatBenchmark } from '../../scripts/bench.mjs';

function sampleResult() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-02T03:04:05.000Z',
    root: 'D:\\repo',
    rootName: 'repo',
    revision: { head: 'abc123', dirty: false, gitUrl: null },
    fingerprint: 'abc123:deadbeef',
    cacheDir: 'C:\\cache\\bench',
    files: { scanned: 3, edges: 2, diagnostics: 0, excluded: 1 },
    graphCache: {
      cold: { status: 'miss', ms: 100.25 },
      memory: { status: 'memory', ms: 0.5 },
      disk: { status: 'disk', ms: 2.75 },
    },
    history: { available: true, windowDays: 90, commitsScanned: 4 },
    stages: STAGE_NAMES.map((stage) => ({
      stage,
      coldMs: 1.5,
      warmMs: stage === 'history' ? 0.25 : null,
      approximate: stage === 'read' || stage === 'parse' || stage === 'extract' || stage === 'resolve',
      source: `${stage}-source`,
      includes: `${stage}-includes`,
    })),
    notes: ['a note'],
  };
}

test('the benchmark names every stage P1 must time', () => {
  assert.deepEqual(STAGE_NAMES, [
    'walk',
    'read',
    'parse',
    'extract',
    'resolve',
    'metrics',
    'analysis',
    'history',
  ]);
});

test('the benchmark formatter is deterministic and covers every stage', () => {
  const result = sampleResult();
  const first = formatBenchmark(result);

  assert.equal(first, formatBenchmark(result));
  for (const stage of STAGE_NAMES) {
    assert.match(first, new RegExp(`\\b${stage}\\b`));
  }
  assert.match(first, /miss/);
  assert.match(first, /memory/);
  assert.match(first, /disk/);
});
