import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import express from 'express';

import { createDataRouter } from '../../src/api/routes/data.ts';
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
  const ceiling = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-data-routes-'));
  created.push(ceiling);
  const repo = path.join(ceiling, 'app');
  fs.mkdirSync(path.join(repo, 'db'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'models'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'db', 'V1__init.sql'),
    'CREATE TABLE orders (id integer PRIMARY KEY, amount numeric NOT NULL);',
  );
  fs.writeFileSync(
    path.join(repo, 'src', 'write.ts'),
    'export const q = "INSERT INTO orders (id, amount) SELECT id, amount FROM staging";\n',
  );
  fs.writeFileSync(path.join(repo, 'dbt_project.yml'), 'name: warehouse\n');
  fs.writeFileSync(
    path.join(repo, 'models', 'daily_revenue.sql'),
    'select o.day as day, sum(o.amount) as total\nfrom {{ ref("orders") }}\n',
  );
  fs.writeFileSync(
    path.join(repo, 'datacontract.yaml'),
    [
      'dataContractSpecification: 1.0.0',
      'info:',
      '  title: revenue',
      'schema:',
      '  - name: daily_revenue',
      '    properties:',
      '      - name: day',
      '        type: date',
      '        required: true',
      '      - name: region',
      '        type: text',
      '        required: true',
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
  app.use('/api', createDataRouter(config, { cache: openWorkspaceCache({ file: cacheFile }) }));
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

test('GET /analysis/data/products serves declared products and conformance', async () => {
  const result = await json('/analysis/data/products');
  assert.equal(result.status, 200);
  const product = result.body.products.find((entry: any) => entry.name === 'revenue');
  assert.ok(product);
  assert.equal(product.format, 'datacontract');
  assert.deepEqual(product.outputPorts.map((entry: any) => entry.dataset), ['db:app/daily_revenue']);
  // The model produces day and total; the contract also declares region, which is missing.
  assert.deepEqual(
    result.body.conformance.map((entry: any) => [entry.contract, entry.dataset, entry.field, entry.kind]),
    [['datacontract:app:revenue', 'db:app/daily_revenue', 'region', 'missing']],
  );
  assert.equal(result.body.dbt.length, 1);
  assert.equal(result.body.dbt[0].name, 'warehouse');
});

test('GET /analysis/data/model serves the ER view and read/write edges', async () => {
  const result = await json('/analysis/data/model');
  assert.equal(result.status, 200);
  assert.ok(result.body.datasets.some((dataset: any) => dataset.id === 'db:app/orders'));
  // The INSERT ... SELECT names orders as a writer; the staging source is lineage.
  assert.ok(result.body.edges.some((edge: any) => edge.kind === 'writes' && edge.target === 'db:app/orders'));
  const lineage = result.body.lineage.map((edge: any) => [edge.source, edge.target]);
  assert.ok(lineage.some(([source, target]: [string, string]) => source === 'db:app/orders' && target === 'db:app/daily_revenue'));
});

test('GET /analysis/data/lineage answers who reads a dataset', async () => {
  const result = await json('/analysis/data/lineage?dataset=daily_revenue');
  assert.equal(result.status, 200);
  const up = result.body.upstream;
  assert.ok(up.includes('db:app/orders'));
  assert.ok(result.body.products.some((entry: any) => entry.name === 'revenue'));

  const missing = await json('/analysis/data/lineage?dataset=does_not_exist');
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.body.lineage, []);
});

test('GET /analysis/data/overlay names each file data footprint and the products', async () => {
  const result = await json('/analysis/data/overlay');
  assert.equal(result.status, 200);
  const writer = result.body.files.find((entry: any) => entry.file === 'src/write.ts');
  assert.ok(writer);
  assert.ok(writer.writes.includes('db:app/orders'));
  assert.ok(result.body.products.some((product: any) => product.name === 'revenue'));
});

test('GET /analysis/data/openlineage emits static datasets and jobs', async () => {
  const result = await json('/analysis/data/openlineage');
  assert.equal(result.status, 200);
  assert.equal(result.body.schemaURL, 'strabo-openlineage-1');
  assert.ok(result.body.datasets.some((dataset: any) => dataset.name === 'orders'));
  const job = result.body.jobs.find((entry: any) => entry.name === 'revenue');
  assert.ok(job);
  assert.deepEqual(job.outputs, [{ namespace: 'app', name: 'daily_revenue' }]);
});

test('POST /analysis/data/impact is refused from another origin', async () => {
  const crossOrigin = await json('/analysis/data/impact', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example', host: 'localhost' },
    body: JSON.stringify({ files: ['src/write.ts'] }),
  });
  assert.equal(crossOrigin.status, 403);

  const sameOrigin = await json('/analysis/data/impact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files: ['src/write.ts'] }),
  });
  assert.equal(sameOrigin.status, 200);
  assert.ok(sameOrigin.body.findings.some((finding: any) => finding.dataset === 'db:app/orders'));
});
