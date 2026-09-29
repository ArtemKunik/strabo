import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildBaseline,
  computeFreshness,
  defaultBaselinePath,
  parseFailOnRules,
  parseUncoveredChangeThreshold,
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

test('parseFailOnRules maps the contract boundary aliases (K6)', () => {
  assert.deepEqual(parseFailOnRules(['contract-boundary', 'contract-drift']), [
    'contract-ungoverned-boundary',
    'contract-drift-detected',
  ]);
  assert.deepEqual(parseFailOnRules(['contract-ungoverned-boundary,contract-drift-detected']), [
    'contract-ungoverned-boundary',
    'contract-drift-detected',
  ]);
});

test('runCheck answers the contract rules from recorded facts (K6)', async () => {
  const result = await runCheck({
    workspaceRoot: config.workspaceRoot,
    scanCeiling: fixtures,
    rules: ['contract-ungoverned-boundary', 'contract-drift-detected'],
  });
  assert.deepEqual(result.rules, ['contract-ungoverned-boundary', 'contract-drift-detected']);
  for (const finding of result.findings) {
    assert.ok(
      finding.rule === 'contract-ungoverned-boundary' || finding.rule === 'contract-drift-detected',
    );
    assert.ok(finding.key.length > 0 && finding.node.length > 0 && finding.detail.length > 0);
  }
});

test('parseFailOnRules and parseUncoveredChangeThreshold parse coverage gate flags (U7)', () => {
  const rules = parseFailOnRules(['uncovered-change:85', 'coverage-stale', 'cycles']);
  assert.deepEqual(rules, ['cycles', 'uncovered-change', 'coverage-stale']);

  const threshold = parseUncoveredChangeThreshold(['uncovered-change:85']);
  assert.equal(threshold, 85);

  const defaultThreshold = parseUncoveredChangeThreshold(['uncovered-change', 'coverage-stale']);
  assert.equal(defaultThreshold, undefined);
});

test('layer-violations finding detail includes tierFlow aggregate (Y8)', async () => {
  const findings = await runCheck({
    workspaceRoot: config.workspaceRoot,
    scanCeiling: fixtures,
    rules: ['layer-violations'],
  });
  for (const finding of findings.findings) {
    if (finding.rule === 'layer-violations') {
      assert.ok(finding.detail.includes('tierFlow:'), 'finding detail contains tierFlow summary');
      assert.ok(typeof finding.inputs?.crossTierEdges === 'number');
    }
  }
});
