import assert from 'node:assert/strict';
import { test } from 'node:test';

import { STAGE_NAMES, formatBenchmark } from '../../scripts/bench.mjs';

function sampleResult() {
  return {
    schemaVersion: 2,
    generatedAt: '2026-01-02T03:04:05.000Z',
    root: 'D:\\repo',
    rootName: 'repo',
    revision: { head: 'abc123', dirty: false, gitUrl: null },
    fingerprint: 'abc123:deadbeef',
    cacheDir: 'C:\\cache\\bench',
    outputPath: null,
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
    firstPaint: {
      passport: {
        coldMs: 3.5,
        warmMs: 1.25,
        approximate: false,
        source: 'passport-source',
        includes: 'passport-includes',
      },
      system: {
        coldMs: 8.5,
        warmMs: 4.25,
        approximate: false,
        source: 'system-source',
        includes: 'system-includes',
      },
    },
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

test('the benchmark formatter names a synthetic corpus when the result carries one', () => {
  const result = sampleResult();
  result.corpus = {
    kind: 'synthetic',
    seed: 7,
    generatedFiles: 20175,
    regenerate: 'node scripts/bench-corpus.mjs',
  };
  const first = formatBenchmark(result);

  assert.match(first, /synthetic/);
  assert.match(first, /20175 files/);
  assert.equal(first, formatBenchmark(result));
});

test('the benchmark formatter reports first paint for the passport and System view', () => {
  const first = formatBenchmark(sampleResult());

  assert.match(first, /First paint/);
  assert.match(first, /passport/);
  assert.match(first, /system/);
  assert.match(first, /passport-source/);
  assert.match(first, /system-source/);
});
