import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { exportSite } from '../../src/index.ts';
import { config, fixtures, stateDir } from './support/interop.ts';

test('exportSite writes an index and one page per repository', async () => {
  const outDir = path.join(stateDir, 'site');
  const pages = await exportSite({
    workspaceRoot: config.workspaceRoot,
    scanCeiling: fixtures,
    outDir,
    repositories: [config.workspaceRoot],
    generatedAt: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.name, 'sample-repo');
  assert.ok(fs.existsSync(path.join(outDir, 'index.html')));
  assert.ok(fs.existsSync(path.join(outDir, 'sample-repo', 'index.html')));
  assert.ok(fs.existsSync(path.join(outDir, 'sample-repo', 'map.svg')));
  assert.ok(fs.existsSync(path.join(outDir, 'sample-repo', 'map.mmd')));
  assert.ok(fs.existsSync(path.join(outDir, 'sample-repo', 'map.json')));
});
