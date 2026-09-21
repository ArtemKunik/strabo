import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { createStraboRouter } from '../../src/index.ts';
import { createStraboServer } from '../../src/index.ts';
import { createRepositoryStore } from '../../src/index.ts';
import type { StraboConfig } from '../../src/index.ts';
import { createSettingsStore } from '../../src/state/settings-store.ts';

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

  const response = await fetch(`${base}/api/strabo/symbols?file=main.go`);
  const body = (await response.json()) as { available: boolean; reason?: string };
  assert.equal(body.available, false);
  assert.equal(body.reason, 'not-implemented');
});

test('the symbol and file-health endpoints serve SQL members and mark cohesion unavailable', async () => {
  const host = express();
  host.use('/api/strabo', createStraboRouter(config));
  const base = await listen(host);
  const query = `repository=${encodeURIComponent(path.join(fixtures, 'sql-repo'))}&file=db/schema/002_orders.sql`;

  const symbols = (await (await fetch(`${base}/api/strabo/symbols?${query}`)).json()) as {
    available: boolean;
    language: string;
    symbols: Array<{ kind: string; name: string; owner: string; type?: string }>;
    memberMap: { types: Array<{ name: string; fields: Array<{ name: string; type?: string }> }> };
  };
  assert.equal(symbols.available, true);
  assert.equal(symbols.language, 'sql');
  assert.deepEqual(
    symbols.memberMap.types.map((type) => [type.name, type.fields.map((field) => `${field.name}: ${field.type}`)]),
    [['orders', ['id: INT', 'user_id: INT', 'total: DECIMAL(10, 2)']]],
  );

  const health = (await (await fetch(`${base}/api/strabo/analysis/file-health?${query}`)).json()) as {
    axes: Array<{ key: string; value: number | null; detail: string }>;
  };
  const cohesion = health.axes.find((axis) => axis.key === 'cohesion');
  assert.equal(cohesion?.value, null);
  assert.match(cohesion?.detail ?? '', /not measured: sql members have no methods/);
});

test('the impact-passport endpoint serves one file card and rejects a missing file', async () => {
  const host = express();
  host.use('/api/strabo', createStraboRouter(config));
  const base = await listen(host);
  const query = `repository=${encodeURIComponent(path.join(fixtures, 'block-repo'))}&file=src/util.ts`;

  const missing = await fetch(`${base}/api/strabo/analysis/impact-passport`);
  assert.equal(missing.status, 400);

  const card = (await (await fetch(`${base}/api/strabo/analysis/impact-passport?${query}`)).json()) as {
    path: string;
    risk: { score: number; band: string } | null;
    snapshot: { blastRadius: number; directImporters: number; directImports: number };
    complexity: { maxAfter: number | null };
    mostComplex: Array<{ name: string }>;
    signals: unknown[];
  };
  assert.equal(card.path, 'src/util.ts');
  assert.ok(card.snapshot, 'the current-graph snapshot is always present');
  assert.ok(card.risk, 'a bounded risk reading is always present');
  assert.ok(Array.isArray(card.mostComplex));
  assert.ok(Array.isArray(card.signals));
});

test('the branch action routes refuse a cross-origin request and require a branch', async () => {
  const host = express();
  host.use('/api/strabo', createStraboRouter(config));
  const base = await listen(host);
  const repository = `?repository=${encodeURIComponent(path.join(fixtures, 'block-repo'))}`;

  const crossOrigin = await fetch(`${base}/api/strabo/analysis/branches/fetch${repository}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({}),
  });
  assert.equal(crossOrigin.status, 403);

  const missingBranch = await fetch(`${base}/api/strabo/analysis/branches/push${repository}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(missingBranch.status, 400);
});

test('the symbol endpoint serves the function inventory with body metrics', async () => {
  const host = express();
  host.use('/api/strabo', createStraboRouter(config));
  const base = await listen(host);
  const file = 'src/main/kotlin/com/acme/app/Counter.kt';
  const query = `repository=${encodeURIComponent(path.join(fixtures, 'member-repo'))}&file=${encodeURIComponent(file)}`;

  const body = (await (await fetch(`${base}/api/strabo/symbols?${query}`)).json()) as {
    available: boolean;
    functions: {
      available: boolean;
      functions: Array<{ name: string; metrics?: { decisionPoints: number } }>;
    };
  };
  assert.equal(body.available, true);
  assert.equal(body.functions.available, true);
  assert.deepEqual(
    body.functions.functions.map((fn) => fn.name),
    ['add', 'reset', 'fail'],
  );
  assert.ok(body.functions.functions.every((fn) => (fn.metrics?.decisionPoints ?? 0) >= 1));
});

test('the functions endpoint ranks hotspots across the repository', async () => {
  const host = express();
  host.use('/api/strabo', createStraboRouter(config));
  const base = await listen(host);

  const body = (await (await fetch(`${base}/api/strabo/analysis/functions`)).json()) as {
    available: boolean;
    filesScanned: number;
    functionsExamined: number;
    hotspots: unknown[];
  };
  assert.equal(body.available, true);
  assert.ok(body.filesScanned >= 1);
  assert.ok(body.functionsExamined >= 1);
  assert.ok(Array.isArray(body.hotspots));
});

test('the repository store seeds the configured root and remembers a selection', async () => {
  const file = path.join(os.tmpdir(), `strabo-router-store-${process.pid}-${Date.now()}.json`);
  const store = createRepositoryStore({ file });
  const host = express();
  host.use(express.json());
  host.use('/api/strabo', createStraboRouter(config, store));
  const base = await listen(host);

  const seeded = (await (await fetch(`${base}/api/strabo/repositories`)).json()) as {
    active: string | null;
    repositories: Array<{ name: string }>;
  };
  assert.equal(seeded.repositories.length, 1);
  assert.equal(seeded.repositories[0].name, 'block-repo');
  assert.equal(seeded.active, path.join(fixtures, 'block-repo'));

  const added = await fetch(`${base}/api/strabo/repositories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: path.join(fixtures, 'polyglot-repo') }),
  });
  assert.equal(added.status, 201);

  const after = (await (await fetch(`${base}/api/strabo/repositories`)).json()) as {
    active: string | null;
    repositories: Array<{ name: string }>;
  };
  assert.deepEqual(after.repositories.map((entry) => entry.name), ['polyglot-repo', 'block-repo']);
  assert.equal(after.active, path.join(fixtures, 'polyglot-repo'));

  const removed = await fetch(
    `${base}/api/strabo/repositories?root=${encodeURIComponent(path.join(fixtures, 'polyglot-repo'))}`,
    { method: 'DELETE' },
  );
  assert.deepEqual(await removed.json(), { removed: true });
  fs.rmSync(file, { force: true });
});

test('the repository store refuses a path outside the scan ceiling', async () => {
  const file = path.join(os.tmpdir(), `strabo-router-store-${process.pid}-${Date.now()}-deny.json`);
  const store = createRepositoryStore({ file });
  const host = express();
  host.use(express.json());
  // A fresh config and a no-override settings store: `createStraboRouter` overlays persisted
  // settings onto the config it is given, so a shared config would carry a widened ceiling
  // from another test and this boundary could not be asserted.
  const isolated: StraboConfig = {
    workspaceRoot: path.join(fixtures, 'block-repo'),
    scanCeiling: fixtures,
  };
  host.use(
    '/api/strabo',
    createStraboRouter(
      isolated,
      store,
      createSettingsStore({ file: path.join(os.tmpdir(), `${path.basename(file)}.settings.json`) }),
    ),
  );
  const base = await listen(host);

  const response = await fetch(`${base}/api/strabo/repositories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: path.dirname(fixtures) }),
  });
  assert.equal(response.status, 400);
  fs.rmSync(file, { force: true });
});

test('the workspace endpoint reports the single configured root', async () => {
  const host = express();
  host.use(express.json());
  host.use('/api/strabo', createStraboRouter(config));
  const base = await listen(host);

  const report = (await (await fetch(`${base}/api/strabo/workspace`)).json()) as {
    name: string;
    repositories: Array<{ name: string; publishes: unknown }>;
    flows: unknown[];
    contracts: unknown[];
    drift: unknown[];
    summary: { repositories: number; flows: number };
  };
  assert.equal(report.repositories.length, 1);
  assert.equal(report.repositories[0].name, 'block-repo');
  assert.deepEqual(report.flows, []);
  assert.equal(report.summary.repositories, 1);

  const contracts = (await (await fetch(`${base}/api/strabo/workspace/contracts`)).json()) as {
    repositories: string[];
    contracts: unknown[];
    drift: unknown[];
  };
  assert.deepEqual(contracts.repositories, ['block-repo']);
  assert.ok(Array.isArray(contracts.contracts));
  assert.ok(Array.isArray(contracts.drift));

  const services = (await (await fetch(`${base}/api/strabo/workspace/services`)).json()) as {
    repositories: string[];
    endpoints: unknown[];
    flows: unknown[];
  };
  assert.deepEqual(services.repositories, ['block-repo']);
  assert.deepEqual(services.endpoints, []);
  assert.deepEqual(services.flows, []);
});

test('the co-change endpoint serves the edges, their evidence, and the thresholds', async () => {
  const host = express();
  host.use('/api/strabo', createStraboRouter(config));
  const base = await listen(host);
  const repository = `?repository=${encodeURIComponent(path.join(fixtures, 'change-repo'))}`;

  const report = (await (await fetch(`${base}/api/strabo/analysis/co-change${repository}`)).json()) as {
    repository: string;
    edges: Array<{ source: string; target: string; commits: unknown[]; hidden: boolean }>;
    skippedCommits: unknown[];
    unavailable: boolean;
    thresholds: { minCommits: number; minRatio: number };
  };
  assert.equal(report.repository, 'change-repo');
  assert.ok(Array.isArray(report.edges));
  assert.ok(Array.isArray(report.skippedCommits));
  // Every drawn edge names its commits, whatever the fixture's history holds.
  assert.ok(report.edges.every((edge) => edge.commits.length > 0));
  assert.equal(report.thresholds.minCommits, 3);
  assert.equal(report.thresholds.minRatio, 0.5);
});

test('the co-change endpoint honours a lower coupling threshold', async () => {
  const host = express();
  host.use('/api/strabo', createStraboRouter(config));
  const base = await listen(host);
  const repository = encodeURIComponent(path.join(fixtures, 'change-repo'));

  const report = (await (
    await fetch(`${base}/api/strabo/analysis/co-change?repository=${repository}&minCommits=1&ratio=0.1`)
  ).json()) as { thresholds: { minCommits: number; minRatio: number } };
  assert.equal(report.thresholds.minCommits, 1);
  assert.equal(report.thresholds.minRatio, 0.1);
});
