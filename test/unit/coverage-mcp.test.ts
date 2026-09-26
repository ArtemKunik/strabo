import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { createApiDispatch, createMcpHandler, createTools } from '../../src/index.ts';
import type { StraboConfig } from '../../src/index.ts';
import { fixtures, toolText } from './support/interop.ts';

const coverageRoot = path.join(fixtures, 'coverage-repo');
const config: StraboConfig = { workspaceRoot: coverageRoot, scanCeiling: fixtures };

test('strabo_coverage is an alias of get_coverage and is listed', async () => {
  const tools = createTools(createApiDispatch(config));
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const coverage = byName.get('get_coverage');
  const alias = byName.get('strabo_coverage');
  assert.ok(coverage, 'get_coverage is registered');
  assert.ok(alias, 'strabo_coverage is registered');
  assert.equal(alias.call, coverage.call);
  assert.match(alias.description, /^Alias of /);
});

test('the coverage tool answers the project scope by default', async () => {
  const handler = createMcpHandler(config);
  const body = JSON.parse(await toolText(handler, 'strabo_coverage', {})) as {
    scope: string;
    totals: { value: number | null; filesMeasured: number; untested: number };
    provenance: { available: boolean; format: string | null };
    folders: Array<{ folder: string }>;
  };
  assert.equal(body.scope, 'project');
  assert.equal(body.provenance.available, true);
  assert.equal(body.provenance.format, 'lcov');
  assert.equal(body.totals.value, 50);
  assert.equal(body.totals.filesMeasured, 2);
  assert.equal(body.totals.untested, 1);
  assert.deepEqual(body.folders.map((entry) => entry.folder), ['src']);
});

test('the coverage tool answers file and folder scopes, and honours the threshold', async () => {
  const handler = createMcpHandler(config);

  const file = JSON.parse(
    await toolText(handler, 'strabo_coverage', { file: 'src/half.ts' }),
  ) as { scope: string; file: { value: number | null; tests: string[] } };
  assert.equal(file.scope, 'file');
  assert.equal(file.file.value, 75);
  assert.deepEqual(file.file.tests, ['src/half.test.ts']);

  const folder = JSON.parse(
    await toolText(handler, 'strabo_coverage', { folder: 'src' }),
  ) as { scope: string; subject: string };
  assert.equal(folder.scope, 'folder');
  assert.equal(folder.subject, 'src');

  const strict = JSON.parse(
    await toolText(handler, 'strabo_coverage', { threshold: 80 }),
  ) as { threshold: number; totals: { untested: number } };
  assert.equal(strict.threshold, 80);
  assert.equal(strict.totals.untested, 2);
});
