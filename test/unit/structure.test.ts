import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, test } from 'node:test';

import express from 'express';

import { buildTierReport } from '../../src/analysis/tiers.ts';
import { createStraboRouter, scanRepository } from '../../src/index.ts';
import { createSettingsStore } from '../../src/state/settings-store.ts';
import { buildStructureGridViewModel, buildStructureViewModel } from '../../src/view/view-model.ts';

const root = path.resolve('test/fixtures/structure-repo');
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

test('buildStructureViewModel draws bands in rank order and shelves the support tiers (Y3)', async () => {
  const { graph } = await scanRepository(root);
  const report = buildTierReport(root, 'structure-repo', graph);
  const model = buildStructureViewModel(
    report,
    { name: 'structure-repo', root } as never,
    { status: 'memory', fingerprint: 'x', artifactVersion: 1, generatedAt: new Date().toISOString(), stale: false },
  );

  assert.equal(model.structure, true);
  assert.deepEqual(model.hubs, []);
  assert.deepEqual(model.structureSummary, { total: 6, intraRatio: 0 });

  // Ranked tiers are bands; the tests tier has no rank, so it is a shelf node, not a band.
  const kindOf = new Map(model.nodes.map((node) => [node.id, node.kind]));
  assert.deepEqual(
    model.nodes.filter((node) => node.kind === 'tier').map((node) => node.id),
    ['frontend', 'api', 'domain', 'integration', 'data'],
  );
  assert.equal(kindOf.get('tests'), 'shelf');

  const frontend = model.nodes.find((node) => node.id === 'frontend');
  assert.equal(frontend?.label, 'Frontend');
  assert.equal(frontend?.tier, 'frontend');
  assert.equal(frontend?.files, 1);

  // The bands stack in dependency order: frontend highest (smallest y), data below it.
  const yOf = new Map(model.positions.map((position) => [position.id, position.y]));
  assert.ok((yOf.get('frontend') ?? 0) < (yOf.get('data') ?? 0));

  // Every node has a recorded edge or none; the wrong-way reads keep their kind.
  const kindOfEdge = (source: string, target: string) =>
    model.edges.find((edge) => edge.source === source && edge.target === target);
  assert.equal(kindOfEdge('frontend', 'api')?.tierKind, 'down');
  assert.equal(kindOfEdge('api', 'data')?.tierKind, 'skip-layer');
  assert.equal(kindOfEdge('data', 'domain')?.tierKind, 'upward');
  assert.equal(kindOfEdge('frontend', 'api')?.crossUnit, 1);
});

test('the tier report carries the unit × tier grid with adjacency (Y4)', async () => {
  const { graph } = await scanRepository(root);
  const report = buildTierReport(root, 'structure-repo', graph);
  const grid = report.grid;

  // Columns are build units (by display name), rows are ranked tiers in dependency order.
  assert.deepEqual(grid.units.map((unit) => [unit.id, unit.name]), [
    ['orders', 'orders-api'],
    ['web', 'web'],
  ]);
  assert.deepEqual(grid.tiers, ['frontend', 'api', 'domain', 'integration', 'data']);
  assert.deepEqual(grid.shelf.map((entry) => entry.tier), ['tests']);

  // Every cell names its unit and tier and counts the files that filled it.
  assert.deepEqual(
    grid.cells.map((cell) => [cell.id, cell.tier, cell.files]),
    [
      ['orders|api', 'api', 1],
      ['orders|domain', 'domain', 1],
      ['orders|integration', 'integration', 1],
      ['orders|data', 'data', 2],
      ['web|frontend', 'frontend', 1],
    ],
  );

  // Edges keep the same kind rule as the bands, including the one crossing a unit boundary.
  const crossUnit = grid.edges.filter((edge) => edge.crossUnit);
  assert.equal(crossUnit.length, 1);
  assert.deepEqual(
    [crossUnit[0]?.source, crossUnit[0]?.target, crossUnit[0]?.kind],
    ['web|frontend', 'orders|api', 'down'],
  );
  const skip = grid.edges.find((edge) => edge.kind === 'skip-layer');
  assert.deepEqual([skip?.source, skip?.target], ['orders|api', 'orders|data']);
  const upward = grid.edges.find((edge) => edge.kind === 'upward');
  assert.deepEqual([upward?.source, upward?.target], ['orders|data', 'orders|domain']);

  assert.deepEqual(grid.summary, { units: 2, tiers: 5, cells: 5, edges: 6, crossUnitEdges: 1 });
});

test('buildStructureGridViewModel lays cells out by unit and tier (Y4)', async () => {
  const { graph } = await scanRepository(root);
  const report = buildTierReport(root, 'structure-repo', graph);
  const model = buildStructureGridViewModel(
    report,
    { name: 'structure-repo', root } as never,
    { status: 'memory', fingerprint: 'x', artifactVersion: 1, generatedAt: new Date().toISOString(), stale: false },
  );

  assert.equal(model.structure, true);
  assert.equal(model.structureLevel, 'grid');
  assert.deepEqual(model.structureGrid?.units.map((unit) => unit.name), ['orders-api', 'web']);
  assert.equal(model.structureGrid?.crossUnitEdges, 1);

  // Columns are units (x) and rows are tiers (y): web|frontend is left of orders|api.
  const posOf = new Map(model.positions.map((position) => [position.id, position]));
  assert.ok((posOf.get('web|frontend')?.y ?? 9) < (posOf.get('orders|api')?.y ?? 0));
  assert.ok((posOf.get('web|frontend')?.x ?? 9) > (posOf.get('orders|api')?.x ?? 0));

  // A cell carries its unit, unit name, and tier; the shelf sits beside the grid.
  const api = model.nodes.find((node) => node.id === 'orders|api');
  assert.equal(api?.kind, 'tier');
  assert.equal(api?.tier, 'api');
  assert.equal(api?.unit, 'orders');
  assert.equal(api?.unitName, 'orders-api');
  assert.equal(model.nodes.find((node) => node.id === 'shelf:tests')?.kind, 'shelf');

  const cross = model.edges.find((edge) => edge.source === 'web|frontend' && edge.target === 'orders|api');
  assert.equal(cross?.crossUnit, 1);
  assert.equal(cross?.tierKind, 'down');
});

test('GET /graph?structure=1&level=grid serves the unit × tier grid', async () => {
  const host = express();
  host.use(express.json());
  host.use(
    '/api/strabo',
    createStraboRouter(
      { workspaceRoot: root, scanCeiling: root },
      undefined,
      createSettingsStore({ file: path.join(root, 'settings.json') }),
    ),
  );
  const base = await listen(host);

  const response = await fetch(`${base}/api/strabo/graph?structure=1&level=grid`);
  assert.equal(response.status, 200);
  const model = (await response.json()) as {
    structure?: boolean;
    structureLevel?: string;
    structureGrid?: { units: Array<{ name: string }> };
    nodes: Array<{ id: string; kind: string; unit?: string }>;
  };
  assert.equal(model.structureLevel, 'grid');
  assert.deepEqual(model.structureGrid?.units.map((unit) => unit.name), ['orders-api', 'web']);
  assert.equal(model.nodes.some((node) => node.unit === 'web'), true);
});

test('GET /graph?structure=1 serves the role-tier structure', async () => {
  const host = express();
  host.use(express.json());
  host.use(
    '/api/strabo',
    createStraboRouter(
      { workspaceRoot: root, scanCeiling: root },
      undefined,
      createSettingsStore({ file: path.join(root, 'settings.json') }),
    ),
  );
  const base = await listen(host);

  const response = await fetch(`${base}/api/strabo/graph?structure=1`);
  assert.equal(response.status, 200);
  const model = (await response.json()) as {
    structure?: boolean;
    nodes: Array<{ id: string; kind: string; tier?: string }>;
  };
  assert.equal(model.structure, true);
  assert.equal(model.nodes.some((node) => node.id === 'frontend' && node.kind === 'tier'), true);
  assert.equal(model.nodes.some((node) => node.tier === 'tests' && node.kind === 'shelf'), true);
});
