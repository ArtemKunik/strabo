import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApiDispatch } from '../../src/index.ts';
import { config } from './support/interop.ts';

test('the in-process dispatch reuses the router handlers', async () => {
  const dispatch = createApiDispatch(config);

  const cycles = await dispatch('GET', '/analysis/cycles');
  assert.equal(cycles.status, 200);
  assert.ok(Array.isArray(cycles.body));

  const pathResult = await dispatch(
    'GET',
    '/analysis/dependency-path?from=src%2Fcycle-a.ts&to=src%2Fcycle-b.ts',
  );
  assert.equal(pathResult.status, 200);
  const body = pathResult.body as { found: boolean; path: string[] };
  assert.equal(body.found, true);
  assert.deepEqual(body.path, ['src/cycle-a.ts', 'src/cycle-b.ts']);

  const status = await dispatch('GET', '/status');
  assert.equal(status.status, 200);
  assert.ok('stale' in (status.body as object));

  const missing = await dispatch('GET', '/nope');
  assert.equal(missing.status, 404);
});

test('the export route serves json, dot, and svg', async () => {
  const dispatch = createApiDispatch(config);
  const json = await dispatch('GET', '/export?format=json');
  assert.equal(json.status, 200);
  assert.ok(typeof json.body === 'string');

  const svg = await dispatch('GET', '/export?format=svg&view=system');
  assert.equal(svg.status, 200);
  assert.match(svg.body as string, /<svg/);

  const bad = await dispatch('GET', '/export?format=exe');
  assert.equal(bad.status, 400);
});
