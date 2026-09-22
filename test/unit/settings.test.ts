import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { createSettingsStore, createStraboRouter, createStraboServer } from '../../src/index.ts';
import { isAllowedHost } from '../../src/api/http.ts';
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

/** A fresh settings file per mount, so tests never read a real state directory. */
function freshSettingsFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-settings-'));
  tempDirs.push(dir);
  return path.join(dir, 'strabo-settings.json');
}

async function mount(config: StraboConfig, settingsFile = freshSettingsFile()): Promise<string> {
  const host = express();
  host.use(express.json());
  host.use(
    '/api/strabo',
    createStraboRouter(config, undefined, createSettingsStore({ file: settingsFile })),
  );
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
    restartAvailable: boolean;
  };

  assert.equal(settings.workspaceRoot, path.join(fixtures, 'block-repo'));
  assert.equal(settings.scanCeiling, fixtures);
  assert.equal(settings.defaultScanCeiling, fixtures);
  assert.equal(settings.configPath, null);
  assert.equal(settings.riskOnline, false);
  assert.equal(settings.allowCeilingWidening, false);
  // An embedded host owns its own process, so restart is not offered by default.
  assert.equal(settings.restartAvailable, false);
});

test('POST /settings/restart refuses when the host wired no restart capability', async () => {
  const base = await mount(makeConfig());
  const response = await fetch(`${base}/api/strabo/settings/restart`, { method: 'POST' });
  assert.equal(response.status, 501);
});

test('POST /settings/restart relaunches only after the reply is flushed', async () => {
  let restarts = 0;
  const config: StraboConfig = { ...makeConfig(), restart: () => { restarts += 1; } };
  const base = await mount(config);

  const settings = (await (await fetch(`${base}/api/strabo/settings`)).json()) as {
    restartAvailable: boolean;
  };
  assert.equal(settings.restartAvailable, true);

  const accepted = await fetch(`${base}/api/strabo/settings/restart`, { method: 'POST' });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { restarting: true });

  // The relaunch is scheduled on the response's `finish`, which lands just after the body.
  for (let attempt = 0; attempt < 100 && restarts === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(restarts, 1);
});

test('POST /settings/restart is refused from another origin', async () => {
  let restarts = 0;
  const config: StraboConfig = { ...makeConfig(), restart: () => { restarts += 1; } };
  const base = await mount(config);

  const response = await fetch(`${base}/api/strabo/settings/restart`, {
    method: 'POST',
    headers: { origin: 'http://evil.example' },
  });
  assert.equal(response.status, 403);
  assert.equal(restarts, 0);
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

test('PUT /settings widens the ceiling when allowCeilingWidening is set at startup', async () => {
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

test('PUT /settings refuses the widening flag: it is startup-only, never granted by request', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-ceiling-'));
  tempDirs.push(outside);
  const base = await mount(makeConfig());

  // Refused before the opt-in, exactly as when the environment gate is absent.
  const denied = await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanCeiling: outside }),
  });
  assert.equal(denied.status, 400);

  // One request cannot enable the permission, alone or combined with a wider ceiling.
  for (const body of [
    { allowCeilingWidening: true },
    { allowCeilingWidening: true, scanCeiling: outside },
  ]) {
    const refused = await fetch(`${base}/api/strabo/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(refused.status, 400);
  }

  // The refusals changed nothing: the boundary is still narrow.
  const stillDenied = await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanCeiling: outside }),
  });
  assert.equal(stillDenied.status, 400);
  const settings = (await (await fetch(`${base}/api/strabo/settings`)).json()) as {
    scanCeiling: string;
    allowCeilingWidening: boolean;
  };
  assert.equal(settings.scanCeiling, fixtures);
  assert.equal(settings.allowCeilingWidening, false);
});

test('persisted settings are re-applied when the server starts again', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-ceiling-'));
  tempDirs.push(outside);
  const settingsFile = freshSettingsFile();

  // Widening is a startup-only permission, so the persisted ceiling here must stay
  // inside the startup boundary; the test proves ceiling + risk survive a restart.
  const inside = path.join(fixtures, 'block-repo');
  const first = await mount(makeConfig(), settingsFile);
  await fetch(`${first}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanCeiling: inside, riskOnline: true }),
  });

  // A fresh config from the same environment, sharing only the persisted file.
  const config = makeConfig();
  const second = await mount(config, settingsFile);
  const settings = (await (await fetch(`${second}/api/strabo/settings`)).json()) as {
    scanCeiling: string;
    riskOnline: boolean;
    allowCeilingWidening: boolean;
  };
  assert.equal(settings.scanCeiling, path.resolve(inside));
  assert.equal(settings.riskOnline, true);
  assert.equal(settings.allowCeilingWidening, false);
  assert.equal(config.scanCeiling, path.resolve(inside));
});

test('a persisted widening flag from an older version does not reopen the boundary', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-ceiling-'));
  tempDirs.push(outside);
  const settingsFile = freshSettingsFile();
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ version: 1, scanCeiling: null, riskOnline: null, allowCeilingWidening: true }),
  );

  const config = makeConfig();
  const base = await mount(config, settingsFile);
  const settings = (await (await fetch(`${base}/api/strabo/settings`)).json()) as {
    allowCeilingWidening: boolean;
  };
  assert.equal(settings.allowCeilingWidening, false);

  const widened = await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanCeiling: outside }),
  });
  assert.equal(widened.status, 400);
});

test('resetting the ceiling clears the persisted override', async () => {
  const settingsFile = freshSettingsFile();
  const first = await mount(makeConfig(), settingsFile);
  await fetch(`${first}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanCeiling: path.join(fixtures, 'block-repo') }),
  });
  await fetch(`${first}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanCeiling: null }),
  });

  const second = await mount(makeConfig(), settingsFile);
  const settings = (await (await fetch(`${second}/api/strabo/settings`)).json()) as { scanCeiling: string };
  assert.equal(settings.scanCeiling, fixtures);
});

function fakeHostRequest(host: string | undefined): Parameters<typeof isAllowedHost>[0] {
  return {
    get: (name: string) => (name.toLowerCase() === 'host' ? host : undefined),
  } as Parameters<typeof isAllowedHost>[0];
}

test('isAllowedHost accepts loopback and the configured host, refuses anything else', () => {
  for (const host of ['127.0.0.1:3000', 'localhost:3000', 'LOCALHOST:3000', '[::1]:3000']) {
    assert.equal(isAllowedHost(fakeHostRequest(host)), true, host);
  }
  assert.equal(isAllowedHost(fakeHostRequest('evil.example:3000')), false);
  assert.equal(isAllowedHost(fakeHostRequest('192.168.1.5:3000')), false);
  assert.equal(isAllowedHost(fakeHostRequest(undefined)), true);
  assert.equal(isAllowedHost(fakeHostRequest('myhost.local:3000'), 'myhost.local'), true);
  assert.equal(isAllowedHost(fakeHostRequest('evil.example:3000'), 'myhost.local'), false);
  // Deliberately exposed on every interface: direct IP literals still work, DNS names do not.
  assert.equal(isAllowedHost(fakeHostRequest('192.168.1.5:3000'), '0.0.0.0'), true);
  assert.equal(isAllowedHost(fakeHostRequest('evil.example:3000'), '0.0.0.0'), false);
});

test('the standalone server refuses a rebinding Host before any route runs', async () => {
  const app = createStraboServer({ workspaceRoot: fixtures, scanCeiling: fixtures });
  const { port } = await new Promise<AddressInfo>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(server.address() as AddressInfo);
    });
  });

  // `fetch` treats Host as a forbidden header and cannot spoof it, so the rebinding
  // requests go over raw HTTP with the attacker's Host on the wire.
  const rawPut = (host: string, body: unknown): Promise<number> =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/strabo/settings',
          method: 'PUT',
          headers: { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode ?? 0));
        },
      );
      request.on('error', reject);
      request.end(payload);
    });

  // The reported attack: enable-then-widen, plus a plain settings write, all under a
  // rebinding Host. Every one is refused at the gate.
  for (const body of [
    { allowCeilingWidening: true, scanCeiling: '/' },
    { allowCeilingWidening: true },
    { scanCeiling: '/' },
  ]) {
    assert.equal(await rawPut('evil.example', body), 403);
  }

  const base = `http://127.0.0.1:${port}`;
  // And the same bodies without the hostile Host fail for the right reason: the flag is
  // startup-only (400), and widening past the ceiling is refused (400).
  const flag = await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allowCeilingWidening: true }),
  });
  assert.equal(flag.status, 400);
  const widen = await fetch(`${base}/api/strabo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanCeiling: '/' }),
  });
  assert.equal(widen.status, 400);

  // Reads under the real Host still work.
  const health = await fetch(`${base}/api/strabo/health`);
  assert.equal(health.status, 200);
});
