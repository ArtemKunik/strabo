import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, test } from 'node:test';

import express from 'express';

import { buildTierReport } from '../../src/analysis/tiers.ts';
import { createStraboRouter, scanRepository } from '../../src/index.ts';
import { createSettingsStore } from '../../src/state/settings-store.ts';
import {
  buildStructureCellViewModel,
  buildStructureGridViewModel,
  buildStructureViewModel,
} from '../../src/view/view-model.ts';

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
  assert.deepEqual(model.structureSummary, {
    total: 6,
    intraRatio: 0,
    truncated: 0,
    mixed: 0,
    unclassified: 0,
  });

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

test('buildStructureViewModel draws bands from left to right when direction is horizontal', async () => {
  const { graph } = await scanRepository(root);
  const report = buildTierReport(root, 'structure-repo', graph);
  const model = buildStructureViewModel(
    report,
    { name: 'structure-repo', root } as never,
    { status: 'memory', fingerprint: 'x', artifactVersion: 1, generatedAt: new Date().toISOString(), stale: false },
    { direction: 'horizontal' },
  );

  assert.equal(model.structure, true);
  assert.equal(model.structureDirection, 'horizontal');

  // The bands stack left to right: frontend furthest left (smallest x), data to the right.
  const xOf = new Map(model.positions.map((position) => [position.id, position.x]));
  const yOf = new Map(model.positions.map((position) => [position.id, position.y]));
  assert.ok((xOf.get('frontend') ?? 0) < (xOf.get('data') ?? 0));
  assert.equal(yOf.get('frontend'), 0);
  assert.equal(yOf.get('data'), 0);

  // The shelf sits below the stack.
  assert.equal(yOf.get('tests'), 240);
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

test('GET /graph?structure=1&direction=horizontal serves horizontal structure view', async () => {
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

  const response = await fetch(`${base}/api/strabo/graph?structure=1&direction=horizontal`);
  assert.equal(response.status, 200);
  const model = (await response.json()) as {
    structure?: boolean;
    structureDirection?: string;
    positions: Array<{ id: string; x: number; y: number }>;
  };
  assert.equal(model.structure, true);
  assert.equal(model.structureDirection, 'horizontal');
  const xOf = new Map(model.positions.map((p) => [p.id, p.x]));
  assert.ok((xOf.get('frontend') ?? 0) < (xOf.get('data') ?? 0));
});

test('buildStructureCellViewModel draws cell files with collapsed context (Y5)', async () => {
  const { graph } = await scanRepository(root);
  const report = buildTierReport(root, 'structure-repo', graph);

  // Grid cells carry their member files
  const dataCell = report.grid.cells.find((c) => c.id === 'orders|data');
  assert.deepEqual(dataCell?.members, [
    'orders/src/data/audit.ts',
    'orders/src/data/orders.ts',
  ]);

  const model = buildStructureCellViewModel(
    report,
    graph,
    { name: 'structure-repo', root } as never,
    { status: 'memory', fingerprint: 'x', artifactVersion: 1, generatedAt: new Date().toISOString(), stale: false },
    { unit: 'orders', tier: 'data' },
  );

  assert.ok(model);
  assert.equal(model.structure, true);
  assert.equal(model.structureLevel, 'cell');
  assert.equal(model.structureUnit, 'orders');
  assert.equal(model.structureUnitName, 'orders-api');
  assert.equal(model.structureTier, 'data');
  assert.equal(model.structureCell, 'orders|data');

  // The member files of orders|data are present as non-collapsed module nodes
  const activeNodes = model.nodes.filter((n) => !n.collapsed);
  assert.deepEqual(
    activeNodes.map((n) => n.id).sort(),
    ['orders/src/data/audit.ts', 'orders/src/data/orders.ts'],
  );
  assert.equal(activeNodes[0]?.tier, 'data');
  assert.equal(activeNodes[0]?.unit, 'orders');
  assert.equal(activeNodes[0]?.unitName, 'orders-api');

  // The other unit (web) sits as a collapsed box for context
  const collapsed = model.nodes.filter((n) => n.collapsed);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0]?.id, 'web');
  assert.equal(collapsed[0]?.label, 'web');

  // Positions are generated for both member files and collapsed units
  assert.equal(model.positions.length, model.nodes.length);
});

test('GET /graph?structure=1&level=cell&unit=orders&tier=data serves cell drill-down (Y5)', async () => {
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

  const response = await fetch(`${base}/api/strabo/graph?structure=1&level=cell&unit=orders&tier=data`);
  assert.equal(response.status, 200);
  const model = (await response.json()) as {
    structure?: boolean;
    structureLevel?: string;
    structureUnit?: string;
    structureUnitName?: string;
    structureTier?: string;
    nodes: Array<{ id: string; collapsed?: boolean }>;
  };
  assert.equal(model.structureLevel, 'cell');
  assert.equal(model.structureUnit, 'orders');
  assert.equal(model.structureUnitName, 'orders-api');
  assert.equal(model.structureTier, 'data');
  assert.equal(
    model.nodes.some((n) => n.id === 'orders/src/data/orders.ts' && !n.collapsed),
    true,
  );
});

test('the tier report carries end-to-end spines connecting call → endpoint → handler → table (Y6)', async () => {
  const { graph } = await scanRepository(root);
  const report = buildTierReport(root, 'structure-repo', graph);

  assert.ok(report.spines.length >= 1, 'should have at least 1 spine');
  const spine = report.spines[0];
  assert.ok(spine);

  // Call site in web/src/ui/home.ts (frontend)
  assert.equal(spine.call.file, 'web/src/ui/home.ts');
  assert.equal(spine.call.tier, 'frontend');
  assert.equal(spine.call.unit, 'web');
  assert.equal(spine.call.path, '/orders');

  // Declared endpoint in orders/openapi.yaml (api)
  assert.ok(spine.endpoint);
  assert.equal(spine.endpoint.file, 'orders/openapi.yaml');
  assert.equal(spine.endpoint.tier, 'api');
  assert.equal(spine.endpoint.method, 'GET');
  assert.equal(spine.endpoint.path, '/orders');

  // API contract: the operation id and its response schema, read from the same document.
  assert.equal(spine.endpoint.operationId, 'listOrders');
  assert.equal(spine.endpoint.request, undefined);
  assert.equal(spine.endpoint.response?.schema, 'OrderList');
  assert.deepEqual(
    spine.endpoint.response?.fields.map((field) => [field.name, field.type, field.required]),
    [
      ['orders', 'array<Order>', false],
      ['total', 'integer', false],
    ],
  );

  // Domain handler in orders/src/domain/orders.ts (domain)
  assert.ok(spine.handler);
  assert.equal(spine.handler.tier, 'domain');
  assert.equal(spine.handler.file, 'orders/src/domain/orders.ts');

  // Table reference in orders/src/data/orders.ts (data)
  assert.ok(spine.table);
  assert.equal(spine.table.table, 'orders');
  assert.equal(spine.table.file, 'orders/src/data/orders.ts');
  assert.equal(spine.table.tier, 'data');

  // Lineage: the recorded tables downstream of the handler, matched table first.
  assert.ok(spine.lineage.length >= 1);
  assert.equal(spine.lineage[0]?.table, 'orders');
  assert.equal(spine.lineage[0]?.matched, true);
  assert.equal(spine.lineage[0]?.file, 'orders/src/data/orders.ts');

  // 4 hops along the spine
  assert.equal(spine.hops.length, 4);
  assert.deepEqual(
    spine.hops.map((h) => [h.role, h.tier]),
    [
      ['call', 'frontend'],
      ['endpoint', 'api'],
      ['handler', 'domain'],
      ['table', 'data'],
    ],
  );

  // View models carry structureSpines
  const bandsModel = buildStructureViewModel(
    report,
    { name: 'structure-repo', root } as never,
    { status: 'memory', fingerprint: 'x', artifactVersion: 1, generatedAt: new Date().toISOString(), stale: false },
  );
  assert.ok(bandsModel.structureSpines && bandsModel.structureSpines.length >= 1);
  assert.ok(bandsModel.structureEndpoints && bandsModel.structureEndpoints.length >= 1);
  const declared = bandsModel.structureEndpoints?.find((entry) => entry.method === 'POST');
  assert.equal(declared?.path, '/orders');
  assert.equal(declared?.request?.schema, 'OrderInput');
  assert.deepEqual(
    declared?.request?.fields.map((field) => [field.name, field.type, field.required]),
    [
      ['note', 'string', false],
      ['status', 'string', true],
    ],
  );

  const gridModel = buildStructureGridViewModel(
    report,
    { name: 'structure-repo', root } as never,
    { status: 'memory', fingerprint: 'x', artifactVersion: 1, generatedAt: new Date().toISOString(), stale: false },
  );
  assert.ok(gridModel.structureSpines && gridModel.structureSpines.length >= 1);

  const cellModel = buildStructureCellViewModel(
    report,
    graph,
    { name: 'structure-repo', root } as never,
    { status: 'memory', fingerprint: 'x', artifactVersion: 1, generatedAt: new Date().toISOString(), stale: false },
    { unit: 'orders', tier: 'data' },
  );
  assert.ok(cellModel?.structureSpines && cellModel.structureSpines.length >= 1);
});

test('the tier report and view models carry intended vs observed architecture (Y7)', async () => {
  const { graph } = await scanRepository(root);
  const report = buildTierReport(root, 'structure-repo', graph);

  assert.ok(report.intent);
  assert.equal(report.intent.available, true);
  assert.equal(report.intent.rules.length, 2);

  // Ghost edge: declared api -> integration with 0 observed imports
  const ghostEdge = report.intent.ghostEdges.find(
    (e) => e.source === 'api' && e.target === 'integration',
  );
  assert.ok(ghostEdge);
  assert.equal(ghostEdge.ruleId, 'api-to-integration');
  assert.equal(ghostEdge.kind, 'down');

  // Violations: upward (data -> domain) and declared never rule (no-data-to-domain)
  assert.ok(report.intent.violations.length >= 2);
  const ruleViolation = report.intent.violations.find((v) => v.ruleId === 'no-data-to-domain');
  assert.ok(ruleViolation);
  assert.equal(ruleViolation.source, 'data');
  assert.equal(ruleViolation.target, 'domain');
  assert.equal(ruleViolation.kind, 'rule');

  // Structure view model carries ghost edge and marked violations
  const model = buildStructureViewModel(
    report,
    { name: 'structure-repo', root } as never,
    { status: 'memory', fingerprint: 'x', artifactVersion: 1, generatedAt: new Date().toISOString(), stale: false },
  );

  assert.ok(model.structureIntent);
  assert.equal(model.structureIntent.available, true);

  // Model edges contain ghost edge
  const modelGhost = model.edges.find((e) => e.ghost && e.source === 'api' && e.target === 'integration');
  assert.ok(modelGhost);
  assert.equal(modelGhost.intended, true);
  assert.equal(modelGhost.weight, 0);
  assert.equal(modelGhost.ruleId, 'api-to-integration');

  // Model edges contain violation
  const modelViolation = model.edges.find((e) => e.source === 'data' && e.target === 'domain');
  assert.ok(modelViolation);
  assert.equal(modelViolation.violation, true);
  assert.equal(modelViolation.ruleId, 'no-data-to-domain');

  // Ghost band support
  const syntheticReport = {
    ...report,
    intent: {
      ...report.intent,
      ghostBands: [{ tier: 'infra' as const, label: 'Infra', ruleId: 'domain-to-infra' }],
    },
  };
  const ghostBandModel = buildStructureViewModel(
    syntheticReport,
    { name: 'structure-repo', root } as never,
    { status: 'memory', fingerprint: 'x', artifactVersion: 1, generatedAt: new Date().toISOString(), stale: false },
  );
  const ghostBand = ghostBandModel.nodes.find((n) => n.id === 'infra');
  assert.ok(ghostBand);
  assert.equal(ghostBand.ghost, true);
  assert.equal(ghostBand.files, 0);
});

