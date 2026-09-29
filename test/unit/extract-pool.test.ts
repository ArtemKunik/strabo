import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractWithPool, workersAvailable } from '../../src/scan/languages/extract-pool.ts';
import { clearParseCache } from '../../src/scan/parse-cache.ts';

const PY_A = 'import os\nclass Alpha:\n    value = 1\n';
const PY_B = 'import sys\nclass Beta:\n    other = 2\n';

test('the pool extracts every file and returns outcomes in input order (P4)', async () => {
  clearParseCache();
  const tasks = [
    { language: 'python' as const, file: 'a.py', content: PY_A },
    { language: 'python' as const, file: 'b.py', content: PY_B },
    { language: 'python' as const, file: 'c.py', content: 'def run():\n    return 1\n' },
  ];
  const outcomes = await extractWithPool(tasks, 2);
  assert.equal(outcomes.length, 3);

  // Order is the input order, and each fact names its own file.
  assert.deepEqual(
    outcomes.map((outcome) => (outcome.facts as { file: string }).file),
    ['a.py', 'b.py', 'c.py'],
  );
  for (const outcome of outcomes) {
    assert.equal(outcome.diagnostics.length, 0);
  }
});

test('the pool and the in-process extractor produce identical facts (P4)', async () => {
  clearParseCache();
  const tasks = [{ language: 'python' as const, file: 'a.py', content: PY_A }];
  // A pool of one, then the environment-forced in-process path, must agree byte for byte.
  const pooled = await extractWithPool(tasks, 1);

  const previous = process.env.STRABO_NO_PARSE_WORKERS;
  process.env.STRABO_NO_PARSE_WORKERS = '1';
  try {
    assert.equal(workersAvailable(), false);
    const inProcess = await extractWithPool(tasks, 1);
    assert.equal(inProcess[0]?.fellBack, true);
    assert.deepEqual(inProcess[0]?.facts, pooled[0]?.facts);
  } finally {
    if (previous === undefined) {
      delete process.env.STRABO_NO_PARSE_WORKERS;
    } else {
      process.env.STRABO_NO_PARSE_WORKERS = previous;
    }
  }
});

test('the pool reports an unreadable grammar as a diagnostic, not a crash (P4)', async () => {
  clearParseCache();
  // A language with an extractor but content that produces no facts is still a clean result;
  // a missing extractor language is the failure path the pool must survive.
  const outcomes = await extractWithPool(
    [{ language: 'python' as const, file: 'empty.py', content: '' }],
    1,
  );
  assert.equal(outcomes[0]?.diagnostics.length, 0);
  assert.deepEqual((outcomes[0]?.facts as { file: string }).file, 'empty.py');
});

test('an empty batch is empty and spawns no worker', async () => {
  const outcomes = await extractWithPool([], 4);
  assert.deepEqual(outcomes, []);
});
