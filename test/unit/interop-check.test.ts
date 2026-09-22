import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildBaseline,
  computeFreshness,
  defaultBaselinePath,
  readBaseline,
  runCheck,
  writeBaseline,
} from '../../src/index.ts';
import { config, fixtures, stateDir } from './support/interop.ts';

test('baseline round-trips through disk', () => {
  const file = path.join(stateDir, 'baseline.json');
  writeBaseline(file, {
    version: 1,
    repository: 'sample-repo',
    revision: null,
    fingerprint: null,
    generatedAt: '2026-01-01T00:00:00.000Z',
    findings: ['cycles:src/cycle-a.ts'],
    healthScore: 80,
  });
  const read = readBaseline(file);
  assert.equal(read?.healthScore, 80);
  assert.deepEqual(read?.findings, ['cycles:src/cycle-a.ts']);
  assert.equal(readBaseline(path.join(stateDir, 'missing.json')), null);
});

test('computeFreshness reports stale and no revision outside git', async () => {
  const freshness = await computeFreshness(stateDir, 'abc1234:deadbeef', '2026-01-01T00:00:00.000Z');
  assert.equal(freshness.indexed.revision, 'abc1234');
  assert.equal(freshness.current.fingerprint, null);
  assert.equal(freshness.behind, null);
  assert.equal(freshness.stale, true);
});

test('runCheck finds the fixture cycle and passes once it is baselined', async () => {
  const baselineFile = path.join(stateDir, 'sample-baseline.json');
  const baseline = await buildBaseline({ workspaceRoot: config.workspaceRoot, scanCeiling: fixtures });
  assert.ok(baseline.findings.some((key) => key.startsWith('cycles:')));

  const failing = await runCheck({
    workspaceRoot: config.workspaceRoot,
    scanCeiling: fixtures,
    rules: ['cycles'],
  });
  assert.equal(failing.passed, false);
  assert.equal(failing.findings.length, 1);
  assert.equal(failing.findings[0]?.rule, 'cycles');

  const passing = await runCheck({
    workspaceRoot: config.workspaceRoot,
    scanCeiling: fixtures,
    rules: ['cycles'],
    baseline,
  });
  assert.equal(passing.passed, true);
  assert.equal(passing.baselined.length, 1);
  assert.ok(baselineFile.length > 0);
  assert.equal(defaultBaselinePath(config.workspaceRoot).endsWith('.json'), true);
});

test('runCheck warns rather than failing when no rules are enabled', async () => {
  const result = await runCheck({ workspaceRoot: config.workspaceRoot, scanCeiling: fixtures });
  assert.equal(result.passed, true);
  assert.ok(result.warnings.some((warning) => warning.rule === 'check'));
});
