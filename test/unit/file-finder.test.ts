import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import express from 'express';
import { JSDOM } from 'jsdom';

import { createStraboRouter, type StraboConfig } from '../../src/index.ts';
import { createSettingsStore } from '../../src/state/settings-store.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.document = dom.window.document;
globalThis.window = dom.window as never;
globalThis.Event = dom.window.Event;

const { createFileFinder, fileMatchScore, rankFiles } = await import('../../ui/strabo-file-finder.js');

const servers: Array<ReturnType<typeof express.application.listen>> = [];
const tempDirs: string[] = [];

after(() => {
  for (const server of servers) {
    server.close();
  }
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const files = [
  { id: 'src/api/routes/files.ts', kind: 'module' },
  { id: 'src/scan/graph.ts', kind: 'module' },
  { id: 'ui/strabo-graph.js', kind: 'module' },
  { id: 'ui/strabo-graph-query.js', kind: 'module' },
  { id: 'test/unit/graph.test.ts', kind: 'test' },
  { id: 'docs/paragraph.md', kind: 'module' },
];

test('an exact file name ranks first, then a name prefix, then a name substring', () => {
  assert.deepEqual(
    rankFiles(files, 'graph').map((file) => file.id),
    [
      'src/scan/graph.ts',
      'test/unit/graph.test.ts',
      'ui/strabo-graph.js',
      'ui/strabo-graph-query.js',
      'docs/paragraph.md',
    ],
  );
});

test('a name match beats a directory match, and a slash matches on the path', () => {
  assert.ok(fileMatchScore('src/api/routes/files.ts', 'files') > fileMatchScore('files/index.ts', 'files'));
  assert.deepEqual(rankFiles(files, 'api/rou').map((file) => file.id), ['src/api/routes/files.ts']);
});

test('a fuzzy subsequence still matches, and a miss scores -1', () => {
  assert.ok(fileMatchScore('ui/strabo-graph-query.js', 'sgq') >= 0);
  assert.equal(fileMatchScore('ui/strabo-graph.js', 'zzz'), -1);
  assert.deepEqual(rankFiles(files, 'zzz'), []);
});

test('picking a file in a directory view switches to Files and selects it', async () => {
  const selected: string[] = [];
  const detail = document.createElement('select');
  detail.append(new dom.window.Option('Blocks', 'block'), new dom.window.Option('Files', 'file'));
  const state = { mode: 'block', filter: '', repository: null as string | null };
  const app = {
    state,
    elements: { detail, filter: document.createElement('input'), status: document.createElement('div') },
    current: { nodes: [{ id: 'src' }] },
    view: {
      cy: {
        getElementById: () => ({ nonempty: () => false }),
        nodes: () => ({ filter: () => ({ nonempty: () => false }) }),
      },
    },
    request: async (url: string) => {
      assert.equal(url, '/files');
      return { files };
    },
    selection: { selectNode: (id: string) => selected.push(id) },
    applyFilterToView() {},
    scanSettled: async () => {},
  };
  // Stands in for the Detail menu's handler: switch mode and draw the file graph.
  detail.addEventListener('change', () => {
    state.mode = detail.value;
    app.current = { nodes: files.map((file) => ({ id: file.id })) };
  });

  const finder = createFileFinder(app);
  await finder.open();
  const input = document.querySelector<HTMLInputElement>('#file-finder-overlay input')!;
  input.value = 'files';
  input.dispatchEvent(new dom.window.Event('input'));
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter' }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(state.mode, 'file');
  assert.deepEqual(selected, ['src/api/routes/files.ts']);
  assert.equal(finder.isOpen(), false);
});

test('GET /files lists every scanned file, not the rolled-up view', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-file-finder-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'deep', 'needle.ts'), 'export const needle = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), "import { needle } from './deep/needle';\nexport { needle };\n");

  const config: StraboConfig = { workspaceRoot: root, scanCeiling: root };
  const host = express();
  // A temp settings store, so the machine's own saved scan ceiling does not apply.
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-file-finder-settings-')), 'settings.json');
  tempDirs.push(path.dirname(settingsFile));
  host.use('/api/strabo', createStraboRouter(config, undefined, createSettingsStore({ file: settingsFile })));
  const base = await new Promise<string>((resolve) => {
    const server = host.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });

  const response = await fetch(`${base}/api/strabo/files`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { files: Array<{ id: string }> };
  assert.deepEqual(body.files.map((file) => file.id).sort(), ['src/deep/needle.ts', 'src/index.ts']);
});
