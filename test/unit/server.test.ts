import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { createStraboRouter } from '../../src/api/router.ts';
import { createStraboServer } from '../../src/server.ts';
import type { StraboConfig } from '../../src/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '..', 'fixtures');
const config: StraboConfig = {
  workspaceRoot: path.join(fixtures, 'block-repo'),
  scanCeiling: fixtures,
};

const servers: Array<ReturnType<typeof express.application.listen>> = [];

after(() => {
  for (const server of servers) {
    server.close();
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

test('createStraboServer serves the UI and the API from one app', async () => {
  const base = await listen(createStraboServer(config));

  const ui = await fetch(`${base}/`);
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /<html/i);

  const health = await fetch(`${base}/api/strabo/health`);
  assert.deepEqual(await health.json(), { ok: true });

  const graph = await fetch(`${base}/api/strabo/graph?blockDepth=1`);
  const body = (await graph.json()) as { nodes: unknown[]; cache: { status: string } };
  assert.ok(body.nodes.length > 0);
  assert.ok(body.cache.status.length > 0);
});

test('the router embeds in a host Express app at any mount point', async () => {
  const host = express();
  host.use('/internal/strabo', createStraboRouter(config));
  const base = await listen(host);

  const health = await fetch(`${base}/internal/strabo/health`);
  assert.deepEqual(await health.json(), { ok: true });

  const browse = await fetch(`${base}/internal/strabo/browse`);
  const listing = (await browse.json()) as { directories: unknown[] };
  assert.ok(Array.isArray(listing.directories));

  // The host's own routes are untouched.
  const missing = await fetch(`${base}/api/strabo/health`);
  assert.equal(missing.status, 404);
});

test('the symbol endpoint reports not-implemented rather than an empty list', async () => {
  const host = express();
  host.use('/api/strabo', createStraboRouter(config));
  const base = await listen(host);

  const response = await fetch(`${base}/api/strabo/symbols?file=main.ts`);
  const body = (await response.json()) as { available: boolean; reason?: string };
  assert.equal(body.available, false);
  assert.equal(body.reason, 'not-implemented');
});
