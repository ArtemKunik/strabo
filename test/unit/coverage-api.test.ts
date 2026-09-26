import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { createApiDispatch } from '../../src/index.ts';
import type { StraboConfig } from '../../src/index.ts';
import { fixtures } from './support/interop.ts';

const coverageRoot = path.join(fixtures, 'coverage-repo');
const config: StraboConfig = { workspaceRoot: coverageRoot, scanCeiling: fixtures };

test('the project coverage route reads the repository report and names its basis', async () => {
  const dispatch = createApiDispatch(config);
  const result = await dispatch('GET', '/analysis/coverage/project');

  assert.equal(result.status, 200);
  const body = result.body as {
    scope: string;
    subject: string;
    totals: { value: number | null; filesMeasured: number; basis: string; untested: number };
    provenance: { available: boolean; format: string | null };
    folders: Array<{ folder: string }>;
  };
  assert.equal(body.scope, 'project');
  assert.equal(body.subject, '.');
  assert.equal(body.provenance.available, true);
  assert.equal(body.provenance.format, 'lcov');
  assert.equal(body.totals.value, 50);
  assert.equal(body.totals.filesMeasured, 2);
  assert.equal(body.totals.basis, 'measured');
  assert.equal(body.totals.untested, 1);
  assert.deepEqual(body.folders.map((entry) => entry.folder), ['src']);
});

test('the project coverage route honours the threshold query', async () => {
  const dispatch = createApiDispatch(config);
  const result = await dispatch('GET', '/analysis/coverage/project?threshold=80');
  const body = result.body as { threshold: number; totals: { untested: number } };
  assert.equal(body.threshold, 80);
  assert.equal(body.totals.untested, 2);
});

test('the folder coverage route rolls up a subtree and rejects a missing parameter', async () => {
  const dispatch = createApiDispatch(config);

  const ok = await dispatch('GET', '/analysis/coverage/folder?folder=src');
  assert.equal(ok.status, 200);
  const body = ok.body as { scope: string; subject: string; totals: { value: number | null } };
  assert.equal(body.scope, 'folder');
  assert.equal(body.subject, 'src');
  assert.equal(body.totals.value, 50);

  const root = await dispatch('GET', '/analysis/coverage/folder?folder=.');
  assert.equal(root.status, 200);
  assert.equal((root.body as { subject: string }).subject, '.');

  const missing = await dispatch('GET', '/analysis/coverage/folder');
  assert.equal(missing.status, 400);

  const unknown = await dispatch('GET', '/analysis/coverage/folder?folder=does-not-exist');
  assert.equal(unknown.status, 404);
});

test('the file coverage route returns the figure, its tests, and its importers', async () => {
  const dispatch = createApiDispatch(config);

  const ok = await dispatch('GET', '/analysis/coverage/file?file=src%2Fhalf.ts');
  assert.equal(ok.status, 200);
  const body = ok.body as {
    scope: string;
    file: { file: string; value: number | null; tests: string[]; importers: string[] };
  };
  assert.equal(body.scope, 'file');
  assert.equal(body.file.file, 'src/half.ts');
  assert.equal(body.file.value, 75);
  assert.deepEqual(body.file.tests, ['src/half.test.ts']);
  assert.deepEqual(body.file.importers, ['src/half.test.ts']);

  const missing = await dispatch('GET', '/analysis/coverage/file');
  assert.equal(missing.status, 400);

  const unknown = await dispatch('GET', '/analysis/coverage/file?file=src%2Fmissing.ts');
  assert.equal(unknown.status, 404);
});
