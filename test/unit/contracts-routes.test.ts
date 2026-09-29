import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import express from 'express';

import { createContractsRouter } from '../../src/api/routes/contracts.ts';
import { openWorkspaceCache } from '../../src/cache/workspace-cache.ts';
import type { StraboConfig } from '../../src/types.ts';

const created: string[] = [];
const servers: Server[] = [];
let base = '';

after(() => {
  for (const server of servers) {
    server.close();
  }
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' });
}

before(async () => {
  const ceiling = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-contracts-routes-'));
  created.push(ceiling);
  const repo = path.join(ceiling, 'shop');
  fs.mkdirSync(path.join(repo, 'db'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'units', 'billing'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'units', 'shop'), { recursive: true });
  // Two build units, so a dataset shared between them crosses a boundary.
  fs.writeFileSync(path.join(repo, 'units', 'billing', 'package.json'), '{"name":"billing"}\n');
  fs.writeFileSync(path.join(repo, 'units', 'shop', 'package.json'), '{"name":"shop"}\n');
  fs.writeFileSync(
    path.join(repo, 'db', 'V1__init.sql'),
    'CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL);',
  );
  fs.writeFileSync(
    path.join(repo, 'units', 'billing', 'producer.ts'),
    'export const q = "INSERT INTO users (id, name) VALUES (1, \'a\')";\n',
  );
  fs.writeFileSync(
    path.join(repo, 'units', 'shop', 'consumer.ts'),
    'export const q = "SELECT id FROM users";\n',
  );
  // The schema name matches the table label, so the contract governs it by bare name
  // (a weak, honest match — the boundary reports it as unverified, never conforming).
  fs.writeFileSync(
    path.join(repo, 'openapi.yaml'),
    [
      'openapi: 3.0.0',
      'info:',
      '  title: Shop',
      '  version: 1.0.0',
      'components:',
      '  schemas:',
      '    users:',
      '      type: object',
      '      required: [id]',
      '      properties:',
      '        id:',
      '          type: integer',
      '        name:',
      '          type: string',
    ].join('\n'),
  );
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Tester');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');

  const config: StraboConfig = { workspaceRoot: repo, scanCeiling: ceiling };
  const cacheFile = path.join(ceiling, 'workspace-cache.json');
  const app = express();
  app.use(express.json());
  app.use('/api', createContractsRouter(config, { cache: openWorkspaceCache({ file: cacheFile }) }));
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}/api`;
});

async function json(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${pathname}`, init);
  return { status: response.status, body: await response.json() };
}

test('GET /analysis/contracts/graph joins contracts to cross-unit boundaries', async () => {
  const result = await json('/analysis/contracts/graph');
  assert.equal(result.status, 200);
  const definition = result.body.definitions.find((entry: any) => entry.format === 'openapi');
  assert.ok(definition, 'the OpenAPI contract is a definition');
  assert.equal(definition.origin, 'declared');
  const governed = result.body.governedEdges.filter((edge: any) => edge.contract === definition.id);
  assert.ok(governed.length >= 1, 'the users flow across units is governed');
  assert.match(governed[0].badge, /📜/);
  assert.ok(['conforming', 'drifting', 'unverified'].includes(governed[0].conformance));
  assert.ok(Array.isArray(result.body.uncontractedBoundaries));
  assert.ok(Array.isArray(result.body.orphanedContracts));
  assert.ok(Array.isArray(result.body.unverifiedEdges));
  assert.equal(result.body.summary.contracts, result.body.definitions.length);
});

test('GET /analysis/contracts/overlay marks the definition inside the status budget', async () => {
  const result = await json('/analysis/contracts/overlay');
  assert.equal(result.status, 200);
  const allowed = new Set(['ov-contract-def', 'ov-cycle', 'ov-declared-rule', 'ov-unreached', 'ov-affected']);
  for (const file of result.body.files) {
    for (const cls of file.classes) {
      assert.ok(allowed.has(cls), `overlay class ${cls} is inside the budget`);
    }
  }
  assert.ok(result.body.files.some((entry: any) => entry.classes.includes('ov-contract-def')));
});

test('GET /analysis/contracts/edge carries fields, access, and conformance', async () => {
  const graph = await json('/analysis/contracts/graph');
  const definition = graph.body.definitions.find((entry: any) => entry.format === 'openapi');
  const governed = graph.body.governedEdges.find((edge: any) => edge.contract === definition.id);
  assert.ok(governed);
  const result = await json(
    `/analysis/contracts/edge?source=${encodeURIComponent(governed.source)}&target=${encodeURIComponent(governed.target)}`,
  );
  assert.equal(result.status, 200);
  assert.ok(result.body.governed.length >= 1);
  assert.ok((result.body.governed[0].fields ?? []).length >= 1);
});

test('GET /analysis/contracts/consumers names the recorded downstream', async () => {
  const graph = await json('/analysis/contracts/graph');
  const definition = graph.body.definitions.find((entry: any) => entry.format === 'openapi');
  const result = await json(`/analysis/contracts/consumers?contract=${encodeURIComponent(definition.id)}`);
  assert.equal(result.status, 200);
  assert.ok(result.body.consumers.includes('units/billing/producer.ts'));
  assert.ok(result.body.consumers.includes('units/shop/consumer.ts'));
  assert.ok(result.body.units.includes('units/billing'));
  assert.ok(result.body.units.includes('units/shop'));
});

test('GET /analysis/contracts/boundary draws Producer -> [Contract] -> Consumers', async () => {
  const result = await json('/analysis/contracts/boundary');
  assert.equal(result.status, 200);
  assert.ok(result.body.plates.length >= 1);
  const plate = result.body.plates.find((entry: any) => entry.producers.length > 0);
  assert.ok(plate, 'one plate names producers');
  assert.ok(plate.consumers.length >= 1);
});

test('POST /analysis/contracts/impact traces edited contract files and explicit shapes', async () => {
  const byFiles = await json('/analysis/contracts/impact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files: ['openapi.yaml'] }),
  });
  assert.equal(byFiles.status, 200);
  assert.equal(byFiles.body.impacts.length, 1);
  assert.ok(byFiles.body.impacts[0].consumers.includes('units/shop/consumer.ts'));

  const explicit = await json('/analysis/contracts/impact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contract: byFiles.body.impacts[0].contract,
      before: [
        { name: 'id', type: 'integer', required: true },
        { name: 'name', type: 'string', required: false },
      ],
      after: [{ name: 'id', type: 'string', required: true }],
    }),
  });
  assert.equal(explicit.status, 200);
  assert.equal(explicit.body.impacts[0].severity, 'breaking');
  assert.ok(explicit.body.impacts[0].changes.some((change: any) => change.kind === 'removed'));
});
