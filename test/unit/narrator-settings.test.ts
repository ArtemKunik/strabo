import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import express from 'express';

import { createStraboRouter } from '../../src/index.ts';
import type { StraboConfig } from '../../src/index.ts';
import { effectiveNarratorConfig, endpointHostOf, narratorLocks } from '../../src/narrator/effective.ts';
import { createNarratorKeyStore } from '../../src/narrator/key-store.ts';
import { createSettingsStore } from '../../src/state/settings-store.ts';

const servers: Array<ReturnType<typeof express.application.listen>> = [];
const tempDirs: string[] = [];

after(() => {
  for (const server of servers) {
    server.close();
  }
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-narrator-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      servers.push(server);
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function makeConfig(): StraboConfig {
  return { workspaceRoot: process.cwd() };
}

async function mount(
  config: StraboConfig,
  env: NodeJS.ProcessEnv,
): Promise<{ base: string; settingsFile: string; keyFile: string }> {
  const settingsFile = tempFile('strabo-settings.json');
  const keyFile = tempFile('strabo-narrator-key.json');
  const host = express();
  host.use(express.json());
  host.use(
    '/api/strabo',
    createStraboRouter(config, undefined, createSettingsStore({ file: settingsFile }), {
      keyStore: createNarratorKeyStore({ file: keyFile }),
      env,
    }),
  );
  return { base: await listen(host), settingsFile, keyFile };
}

test('effectiveNarratorConfig lets the environment win over persisted settings', () => {
  const persisted = {
    narratorEndpoint: 'http://127.0.0.1:1234/v1/chat/completions',
    narratorModel: 'stored-model',
    narratorKeyEnv: 'STORED_KEY',
    narratorSendSource: false,
    narratorBudget: 5,
  };
  const merged = effectiveNarratorConfig(
    { STRABO_NARRATOR_MODEL: 'env-model' },
    persisted,
  );
  assert.equal(merged?.endpoint, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(merged?.model, 'env-model');
  assert.equal(merged?.apiKeyEnv, 'STORED_KEY');
  assert.equal(merged?.requestBudget, 5);
  assert.equal(merged?.sendSource, undefined);
});

test('narratorLocks reports the env var that locks each field', () => {
  const locks = narratorLocks({
    STRABO_NARRATOR_ENDPOINT: 'https://x.example/v1',
    STRABO_NARRATOR_MODEL: 'm',
    STRABO_NARRATOR_BUDGET: '7',
  });
  assert.equal(locks.endpoint, 'STRABO_NARRATOR_ENDPOINT');
  assert.equal(locks.model, 'STRABO_NARRATOR_MODEL');
  assert.equal(locks.budget, 'STRABO_NARRATOR_BUDGET');
  assert.equal(locks.apiKeyEnv, null);
  assert.equal(locks.sendSource, null);
});

test('endpointHostOf returns the host with port or null', () => {
  assert.equal(endpointHostOf('https://api.openai.com/v1/chat/completions'), 'api.openai.com');
  assert.equal(endpointHostOf('http://127.0.0.1:11434/v1'), '127.0.0.1:11434');
  assert.equal(endpointHostOf('not a url'), null);
  assert.equal(endpointHostOf(null), null);
});

test('the key store is host-bound and never returns a key for another host', () => {
  const store = createNarratorKeyStore({ file: tempFile('key.json') });
  store.write('api.openai.com', 'sk-secret');
  assert.equal(store.has('api.openai.com'), true);
  assert.equal(store.has('evil.example.com'), false);
  assert.equal(store.read('evil.example.com'), null);
  assert.equal(store.read('api.openai.com'), 'sk-secret');
  assert.equal(store.host(), 'api.openai.com');
  store.clear();
  assert.equal(store.host(), null);
});

test('PUT /settings persists the narrator and GET /settings merges it', async () => {
  const config = makeConfig();
  const { base } = await mount(config, {});

  const updated = await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      narrator: {
        endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
        model: 'llama3.1',
        sendSource: false,
        requestBudget: 9,
      },
    }),
  });
  assert.equal(updated.status, 200);
  const view = (await updated.json()) as {
    narrator: { endpoint: string | null; model: string | null; requestBudget: number | null; key: { source: string } };
  };
  assert.equal(view.narrator.endpoint, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(view.narrator.model, 'llama3.1');
  assert.equal(view.narrator.requestBudget, 9);
  assert.equal(view.narrator.key.source, 'none');

  // The live config was updated too, so the narrator router sees it without a restart.
  assert.equal(config.narrator?.model, 'llama3.1');
});

test('PUT /settings refuses a locked field set by the environment', async () => {
  const config = makeConfig();
  const { base } = await mount(config, { STRABO_NARRATOR_MODEL: 'env-model' });

  const denied = await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ narrator: { model: 'other-model' } }),
  });
  assert.equal(denied.status, 400);
  const body = (await denied.json()) as { error: string };
  assert.match(body.error, /STRABO_NARRATOR_MODEL/);
});

test('PUT /settings refuses a remote plaintext endpoint and changes nothing', async () => {
  const config = makeConfig();
  const { base } = await mount(config, {});

  const denied = await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ narrator: { endpoint: 'http://narrator.example.com/v1', model: 'm' } }),
  });
  assert.equal(denied.status, 400);
  assert.match(((await denied.json()) as { error: string }).error, /https:/);

  const settings = (await (await fetch(`${base}/api/strabo/settings`)).json()) as {
    narrator: { endpoint: string | null };
  };
  assert.equal(settings.narrator.endpoint, null);
});

test('changing the endpoint host clears the stored key and the env-var binding', async () => {
  const config = makeConfig();
  const { base, keyFile } = await mount(config, {});

  await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ narrator: { endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' } }),
  });
  const stored = await fetch(`${base}/api/strabo/narrator/key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'sk-secret' }),
  });
  assert.equal(stored.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(keyFile, 'utf8')).host, 'api.openai.com');

  const changed = await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ narrator: { endpoint: 'https://openrouter.ai/api/v1/chat/completions' } }),
  });
  assert.equal(changed.status, 200);
  assert.equal(((await changed.json()) as { narrator: { keyCleared?: boolean } }).narrator.keyCleared, true);
  assert.equal(fs.existsSync(keyFile), false);

  const settings = (await (await fetch(`${base}/api/strabo/settings`)).json()) as {
    narrator: { key: { storedSet: boolean } };
  };
  assert.equal(settings.narrator.key.storedSet, false);
});

test('GET /narrator reports the effective setup, locks, key source, and presets', async () => {
  const config = makeConfig();
  const { base } = await mount(config, { STRABO_NARRATOR_MODEL: 'env-model' });
  await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ narrator: { endpoint: 'http://127.0.0.1:11434/v1/chat/completions' } }),
  });

  const status = (await (await fetch(`${base}/api/strabo/narrator`)).json()) as {
    configured: boolean;
    model?: string;
    locked: { model: string | null; endpoint: string | null };
    key: { source: string };
    presets: Array<{ id: string }>;
  };
  assert.equal(status.configured, true);
  assert.equal(status.model, 'env-model');
  assert.equal(status.locked.model, 'STRABO_NARRATOR_MODEL');
  assert.equal(status.locked.endpoint, null);
  assert.equal(status.key.source, 'none');
  assert.ok(status.presets.some((preset) => preset.id === 'anthropic'));
});

test('a loopback narrator with no key is available, a remote one is not', async () => {
  const config = makeConfig();
  const { base } = await mount(config, {});

  // Loopback: no key needed, so narrating is attempted (and fails at the network, not auth).
  await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ narrator: { endpoint: 'http://127.0.0.1:9/v1/chat/completions', model: 'm' } }),
  });
  const loopbackReply = (await (
    await fetch(`${base}/api/strabo/narrator`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ evidence: 'decision points 3' }),
    })
  ).json()) as { available: boolean; reason: string };
  assert.equal(loopbackReply.available, false);
  assert.equal(loopbackReply.reason, 'provider-error');

  // Remote without a key: refused before anything is contacted.
  await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ narrator: { endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' } }),
  });
  const remoteReply = (await (
    await fetch(`${base}/api/strabo/narrator`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ evidence: 'decision points 3' }),
    })
  ).json()) as { available: boolean; reason: string };
  assert.equal(remoteReply.available, false);
  assert.equal(remoteReply.reason, 'not-authenticated');
});

test('settings writes from another origin are refused', async () => {
  const config = makeConfig();
  const { base } = await mount(config, {});

  const denied = await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
    body: JSON.stringify({ riskOnline: true }),
  });
  assert.equal(denied.status, 403);
});

test('Test connection reports plain-language errors without spending the budget', async () => {
  const config = makeConfig();
  const { base } = await mount(config, {});

  const denied = await fetch(`${base}/api/strabo/narrator/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
    body: JSON.stringify({}),
  });
  assert.equal(denied.status, 403);

  // No endpoint yet: a plain reason, not a crash.
  const unconfigured = (await (
    await fetch(`${base}/api/strabo/narrator/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
  ).json()) as { ok: boolean; reason: string };
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.reason, 'not-configured');

  const runs = (await (await fetch(`${base}/api/strabo/narrator/runs`)).json()) as { runs: unknown[] };
  assert.equal(runs.runs.length, 0);
});
