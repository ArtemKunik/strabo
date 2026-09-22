import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import express from 'express';

import { createStraboRouter, type NarratorClient, type StraboConfig } from '../../src/index.ts';
import { createNarratorRouter } from '../../src/api/routes/narrator.ts';
import { createNarratorKeyStore } from '../../src/narrator/key-store.ts';
import { createSettingsStore } from '../../src/state/settings-store.ts';

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

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    stdio: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).toString();
}

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-commit-route-'));
  tempDirs.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Tester');
  fs.writeFileSync(path.join(root, 'file.txt'), 'one\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'one');
  return root;
}

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-commit-route-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

async function mount(root: string): Promise<string> {
  const config: StraboConfig = { workspaceRoot: root, scanCeiling: root };
  const host = express();
  host.use(express.json());
  host.use(
    '/api/strabo',
    createStraboRouter(config, undefined, createSettingsStore({ file: tempFile('settings.json') }), {
      keyStore: createNarratorKeyStore({ file: tempFile('key.json') }),
      env: {},
    }),
  );
  return new Promise((resolve) => {
    const server = host.listen(0, '127.0.0.1', () => {
      servers.push(server);
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

test('POST /analysis/commit commits the working tree from a confirmed message', async () => {
  const root = makeRepo();
  const base = await mount(root);
  fs.writeFileSync(path.join(root, 'file.txt'), 'two\n');

  const response = await fetch(`${base}/api/strabo/analysis/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'feat: update file', push: false }),
  });
  const body = (await response.json()) as { available?: boolean; subject?: string };
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.available, true);
  assert.equal(body.subject, 'feat: update file');
  assert.equal(git(root, 'log', '-1', '--pretty=%s').trim(), 'feat: update file');
  assert.equal(git(root, 'status', '--porcelain').trim(), '');
});

async function mountNarrator(root: string, client: NarratorClient): Promise<string> {
  const config: StraboConfig = { workspaceRoot: root, scanCeiling: root };
  const host = express();
  host.use(express.json());
  host.use('/api/strabo', createNarratorRouter(config, client));
  return new Promise((resolve) => {
    const server = host.listen(0, '127.0.0.1', () => {
      servers.push(server);
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

test('POST /narrator/commit-message builds server-side evidence for the narrator', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'file.txt'), 'two\n');
  let seen: { kind?: string; evidence?: string; instruction?: string } | null = null;
  const client: NarratorClient = {
    status: () => ({ configured: true }),
    runs: () => [],
    narrate: async (request) => {
      seen = request;
      return { available: true, kind: 'narrative', text: 'feat: change file', model: 'm', cached: false };
    },
  };
  const base = await mountNarrator(root, client);
  const response = await fetch(`${base}/api/strabo/narrator/commit-message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = (await response.json()) as { available?: boolean; message?: string };
  assert.equal(response.status, 200);
  assert.equal(body.available, true);
  assert.equal(body.message, 'feat: change file');
  assert.equal(seen?.kind, 'commit-message');
  assert.match(seen?.evidence ?? '', /file\.txt/);
});

test('POST /narrator/commit-message reports a clean tree without contacting the narrator', async () => {
  const root = makeRepo();
  let called = 0;
  const client: NarratorClient = {
    status: () => ({ configured: true }),
    runs: () => [],
    narrate: async () => {
      called += 1;
      return { available: true, kind: 'narrative', text: 'x', model: 'm', cached: false };
    },
  };
  const base = await mountNarrator(root, client);
  const response = await fetch(`${base}/api/strabo/narrator/commit-message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = (await response.json()) as { available?: boolean; reason?: string };
  assert.equal(body.available, false);
  assert.equal(body.reason, 'nothing-to-commit');
  assert.equal(called, 0);
});

test('POST /analysis/commit refuses another origin and an empty message', async () => {
  const root = makeRepo();
  const base = await mount(root);
  fs.writeFileSync(path.join(root, 'file.txt'), 'three\n');

  const crossOrigin = await fetch(`${base}/api/strabo/analysis/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://attacker.example' },
    body: JSON.stringify({ message: 'nope' }),
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(git(root, 'log', '-1', '--pretty=%s').trim(), 'one');

  const empty = await fetch(`${base}/api/strabo/analysis/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '   ' }),
  });
  const body = (await empty.json()) as { available?: boolean; reason?: string };
  assert.equal(body.available, false);
  assert.equal(body.reason, 'empty-message');
  assert.equal(git(root, 'log', '-1', '--pretty=%s').trim(), 'one');
});
