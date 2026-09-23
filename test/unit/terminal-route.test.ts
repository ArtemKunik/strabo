import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import express from 'express';

import { createTerminalRouter } from '../../src/api/routes/terminal.ts';
import type { StraboConfig } from '../../src/types.ts';

const servers: Array<ReturnType<typeof express.application.listen>> = [];
const created: string[] = [];

after(() => {
  for (const server of servers) {
    server.close();
  }
  for (const dir of created) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function makeRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-terminal-route-'));
  created.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const absolute = path.join(root, name);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents, 'utf8');
  }
  return root;
}

async function mount(config: StraboConfig): Promise<string> {
  const host = express();
  host.use(express.json());
  host.use('/api/strabo', createTerminalRouter(config));
  return new Promise((resolve) => {
    const server = host.listen(0, '127.0.0.1', () => {
      servers.push(server);
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

test('GET /terminal/presets derives presets from the requested repository', async () => {
  const app = makeRepo({ 'package.json': JSON.stringify({ scripts: { build: 'tsc', test: 'node --test' } }) });
  const config: StraboConfig = { workspaceRoot: app, scanCeiling: app };
  const base = await mount(config);

  const defaulted = await fetch(`${base}/api/strabo/terminal/presets`);
  const defaultedBody = (await defaulted.json()) as { presets: Array<{ id: string }> };
  assert.equal(defaulted.status, 200);
  assert.deepEqual(defaultedBody.presets.map((preset) => preset.id), ['pkg:build', 'pkg:test']);
});

test('GET /terminal/presets resolves a requested repository under the ceiling', async () => {
  const ceiling = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-terminal-route-'));
  created.push(ceiling);
  const app = path.join(ceiling, 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }), 'utf8');
  const config: StraboConfig = { workspaceRoot: app, scanCeiling: ceiling };
  const base = await mount(config);

  const requested = await fetch(`${base}/api/strabo/terminal/presets?repo=${encodeURIComponent('.')}`);
  assert.equal(requested.status, 200);
});

test('GET /terminal/presets rejects a repository outside the ceiling', async () => {
  const app = makeRepo({ 'package.json': JSON.stringify({ scripts: { build: 'tsc' } }) });
  const config: StraboConfig = { workspaceRoot: app, scanCeiling: app };
  const base = await mount(config);

  const response = await fetch(`${base}/api/strabo/terminal/presets?repo=${encodeURIComponent('..')}`);
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /scan ceiling/);
});
