import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { createStraboRouter } from '../../src/index.ts';
import type { StraboConfig } from '../../src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '..', 'fixtures');

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
  return {
    workspaceRoot: path.join(fixtures, 'block-repo'),
    scanCeiling: fixtures,
  };
}

async function mount(config: StraboConfig): Promise<string> {
  const host = express();
  host.use(express.json());
  host.use('/api/strabo', createStraboRouter(config));
  return listen(host);
}

test('GET /settings reports the start root, ceiling, and risk switch', async () => {
  const base = await mount(makeConfig());
  const settings = (await (await fetch(`${base}/api/strabo/settings`)).json()) as {
    workspaceRoot: string;
    scanCeiling: string;
    defaultScanCeiling: string;
    configPath: string | null;
    riskOnline: boolean;
    allowCeilingWidening: boolean;
  };

  assert.equal(settings.workspaceRoot, path.join(fixtures, 'block-repo'));
  assert.equal(settings.scanCeiling, fixtures);
  assert.equal(settings.defaultScanCeiling, fixtures);
  assert.equal(settings.configPath, null);
  assert.equal(settings.riskOnline, false);
  assert.equal(settings.allowCeilingWidening, false);
});

test('PUT /settings refuses to widen the ceiling without the opt-in and changes nothing', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-ceiling-'));
  tempDirs.push(outside);
  const config = makeConfig();
  const base = await mount(config);

  // The temp dir is outside the startup ceiling, so remembering it is refused.
  const denied = await fetch(`${base}/api/strabo/repositories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: outside }),
  });
  assert.equal(denied.status, 400);

  const widened = await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanCeiling: outside }),
  });
  assert.equal(widened.status, 400);

  // The rejection leaves the boundary and the config untouched.
  const settings = (await (await fetch(`${base}/api/strabo/settings`)).json()) as { scanCeiling: string };
  assert.equal(settings.scanCeiling, fixtures);
  assert.equal(fixtures, config.scanCeiling);
});

test('PUT /settings widens the ceiling when allowCeilingWidening is set', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-ceiling-'));
  tempDirs.push(outside);
  const config = { ...makeConfig(), allowCeilingWidening: true };
  const base = await mount(config);

  const updated = await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanCeiling: outside }),
  });
  assert.equal(updated.status, 200);
  const body = (await updated.json()) as { scanCeiling: string; allowCeilingWidening: boolean };
  assert.equal(body.scanCeiling, path.resolve(outside));
  assert.equal(body.allowCeilingWidening, true);

  // The new boundary is in force immediately: the same root is now inside scope.
  const accepted = await fetch(`${base}/api/strabo/repositories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: outside }),
  });
  assert.equal(accepted.status, 201);
});

test('PUT /settings narrows the ceiling without the widening opt-in', async () => {
  const base = await mount(makeConfig());
  const inside = path.join(fixtures, 'block-repo');

  const narrowed = await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanCeiling: inside }),
  });
  assert.equal(narrowed.status, 200);
  const body = (await narrowed.json()) as { scanCeiling: string };
  assert.equal(body.scanCeiling, path.resolve(inside));
});

test('PUT /settings rejects a ceiling that is not an existing directory and changes nothing', async () => {
  const config = makeConfig();
  const base = await mount(config);

  const missing = await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanCeiling: path.join(os.tmpdir(), 'strabo-does-not-exist-xyz') }),
  });
  assert.equal(missing.status, 400);

  const settings = (await (await fetch(`${base}/api/strabo/settings`)).json()) as { scanCeiling: string };
  assert.equal(settings.scanCeiling, fixtures);
});

test('PUT /settings resets the ceiling to the startup value when passed null', async () => {
  const base = await mount(makeConfig());

  await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanCeiling: path.join(fixtures, 'block-repo') }),
  });
  const reset = await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanCeiling: null }),
  });
  const body = (await reset.json()) as { scanCeiling: string };
  assert.equal(body.scanCeiling, fixtures);
});

test('PUT /settings toggles the online risk lookup and rejects a non-boolean', async () => {
  const config = makeConfig();
  const base = await mount(config);

  const on = await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ riskOnline: true }),
  });
  assert.equal(on.status, 200);
  assert.equal(((await on.json()) as { riskOnline: boolean }).riskOnline, true);
  assert.equal(config.risk?.online, true);

  const bad = await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ riskOnline: 'yes' }),
  });
  assert.equal(bad.status, 400);
});
