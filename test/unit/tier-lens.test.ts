import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { buildTierReport } from '../../src/analysis/tiers.ts';
import {
  tierCallSites,
  tierDirectionClasses,
  tierDirectionLabel,
  tierEndpointSites,
  tierMatrixRows,
  tierPerTierRows,
  tierTableTrace,
  tierTables,
  tierTraces,
} from '../../ui/strabo-tiers.js';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // best-effort teardown
    }
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-tier-lens-'));
  created.push(directory);
  return directory;
}

function write(root: string, file: string, content: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function report() {
  const root = tempDir();
  write(root, 'package.json', '{ "name": "web" }\n');
  write(root, 'src/handlers/orders.ts', "import { store } from '../data/store';\nexport const orders = store;\n");
  write(root, 'src/data/store.ts', "export const store = 1;\nconst sql = 'SELECT * FROM orders';\n");

  return buildTierReport(root, 'web', {
    nodes: [
      { id: 'src/handlers/orders.ts' },
      { id: 'src/data/store.ts' },
    ],
    edges: [
      {
        source: 'src/handlers/orders.ts',
        target: 'src/data/store.ts',
        evidence: { line: 1, specifier: '../data/store' },
      },
    ],
  });
}

test('buildTierReport joins a table to the files that name it', () => {
  const tiers = report();
  const entry = tiers.tableTrace.find((row) => row.table === 'orders');
  assert.equal(entry?.file, 'src/data/store.ts');
  assert.equal(entry?.tier, 'data');
  assert.equal(entry?.unit, '.');
  assert.equal(entry?.evidence, 'string-literal SQL');
});

test('the tier matrix helpers render rows, shares, and the direction caption', () => {
  const tiers = report();

  const rows = tierMatrixRows(tiers);
  const dataRow = rows.find((row) => row.tier === 'data');
  assert.equal(dataRow?.files, 1);
  assert.equal(dataRow?.cells.find((cell) => cell.unit === '.')?.files, 1);

  const shares = tierPerTierRows(tiers);
  assert.equal(shares.find((row) => row.tier === 'data')?.shareLabel, '50%');

  // the handler depends on the data file: upper tier -> lower tier, the expected direction.
  assert.equal(tierDirectionLabel(tiers), 'No upward or skip-layer edges recorded.');
});

function wrongWayReport() {
  const root = tempDir();
  write(root, 'package.json', '{ "name": "web" }\n');
  write(root, 'src/api/orders.ts', 'export const orders = 1;\n');
  write(root, 'src/data/store.ts', "import { orders } from '../api/orders';\nexport const store = orders;\n");

  return buildTierReport(root, 'web', {
    nodes: [{ id: 'src/api/orders.ts' }, { id: 'src/data/store.ts' }],
    edges: [
      {
        source: 'src/data/store.ts',
        target: 'src/api/orders.ts',
        evidence: { line: 1, specifier: '../api/orders' },
      },
    ],
  });
}

test('tierDirectionClasses marks both ends and the edge of a wrong-way dependency', () => {
  const tiers = wrongWayReport();
  assert.ok(tiers.directions.some((entry) => entry.kind === 'upward'));

  const { byNode, edges } = tierDirectionClasses(tiers);
  assert.deepEqual(byNode.get('src/data/store.ts'), ['tier-upward']);
  assert.deepEqual(byNode.get('src/api/orders.ts'), ['tier-upward']);
  assert.equal(edges[0].kind, 'upward');
  assert.equal(edges[0].source, 'src/data/store.ts');
  assert.equal(edges[0].target, 'src/api/orders.ts');

  const empty = tierDirectionClasses(null);
  assert.equal(empty.byNode.size, 0);
  assert.deepEqual(empty.edges, []);
});

function traceReport() {
  const root = tempDir();
  write(root, 'package.json', '{ "name": "web" }\n');
  write(
    root,
    'openapi.yaml',
    'openapi: 3.0.0\ninfo:\n  title: t\n  version: "1"\npaths:\n  /orders:\n    get:\n      responses:\n        "200":\n          description: ok\n',
  );
  write(root, 'src/api/orders.ts', "export async function load() {\n  return fetch('/orders');\n}\n");

  return buildTierReport(root, 'web', { nodes: [{ id: 'src/api/orders.ts' }], edges: [] });
}

test('buildTierReport joins a call site to the endpoint it reaches', () => {
  const tiers = traceReport();
  assert.equal(tiers.calls.length, 1);
  assert.equal(tiers.calls[0].method, 'GET');
  assert.equal(tiers.calls[0].path, '/orders');
  assert.equal(tiers.calls[0].tier, 'api');

  assert.deepEqual(
    tiers.endpoints.map((entry) => [entry.file, entry.method, entry.path]),
    [['openapi.yaml', 'GET', '/orders']],
  );
  assert.equal(tiers.traces[0].endpoint?.file, 'openapi.yaml');

  assert.equal(tierCallSites(tiers).length, 1);
  assert.equal(tierEndpointSites(tiers)[0].path, '/orders');
  assert.equal(tierTraces(tiers)[0].endpoint?.method, 'GET');
});

test('the tier table helpers list tables and their trace rows', () => {
  const tiers = report();
  assert.deepEqual(tierTables(tiers).map((entry) => entry.table), ['orders']);
  assert.deepEqual(
    tierTableTrace(tiers, 'orders').map((entry) => [entry.file, entry.tier]),
    [['src/data/store.ts', 'data']],
  );
  assert.deepEqual(tierTableTrace(tiers, 'missing'), []);
});
