import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import {
  assignUnits,
  buildDirectoryLabels,
  buildSystemReport,
  buildSystemUnitViewModel,
  buildSystemViewModel,
  classifyPeriphery,
  createStraboRouter,
  detectUnits,
  readDeclaredGroups,
  scanRepository,
} from '../../src/index.ts';
import type { Graph } from '../../src/index.ts';
import { createSettingsStore } from '../../src/state/settings-store.ts';

const fixtureRepo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'system-repo',
);

const created: string[] = [];
const servers: Array<ReturnType<typeof express.application.listen>> = [];

after(() => {
  for (const server of servers) {
    server.close();
  }
  // Teardown is best-effort: Windows can hold a handle on a just-closed listener's temp
  // root, and a cleanup failure must not be reported as a failing test.
  for (const directory of created) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // The OS will reclaim the temp directory.
    }
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-system-'));
  created.push(directory);
  return directory;
}

function write(root: string, file: string, content: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function graphOf(files: string[], edges: Array<[string, string]>): Graph {
  return {
    nodes: files.map((id) => ({ id, kind: 'module' as const, directory: path.posix.dirname(id) })),
    edges: edges.map(([source, target]) => ({
      source,
      target,
      kind: 'import' as const,
      evidence: { line: 1, specifier: `${source}->${target}`, resolution: 'exact' as const },
    })),
    diagnostics: [],
    excluded: [],
  };
}

test('detectUnits names units from manifests and nests a member under its parent', () => {
  const root = tempDir();
  write(root, 'Cargo.toml', '[workspace]\nmembers = ["crates/*"]\n');
  write(root, 'crates/api/Cargo.toml', '[package]\nname = "ledger-api"\nversion = "0.1.0"\n');
  write(root, 'crates/core/Cargo.toml', '[package]\nname = "ledger-core"\nversion = "0.1.0"\n');
  write(root, 'web/package.json', '{ "name": "@acme/web" }\n');
  write(root, 'web/src/index.ts', 'export {};\n');

  const files = ['crates/api/src/main.rs', 'crates/core/src/lib.rs', 'web/src/index.ts', 'docs/readme.ts'];
  const units = detectUnits(root, files, 'ledger');
  const byId = new Map(units.map((unit) => [unit.id, unit]));

  assert.equal(byId.get('crates/api')?.name, 'ledger-api');
  assert.equal(byId.get('crates/api')?.ecosystem, 'cargo');
  assert.equal(byId.get('web')?.name, '@acme/web');
  assert.equal(byId.get('web')?.ecosystem, 'npm');
  // A workspace-only Cargo.toml names no crate, so the root stays a fallback unit, and the
  // member crates nest under it.
  assert.equal(byId.get('crates/api')?.parent, '.');
  assert.equal(byId.get('crates/core')?.parent, '.');
  assert.equal(byId.get('.')?.ecosystem, 'root');
  assert.equal(byId.get('.')?.name, 'ledger');
});

test('detectUnits nests a manifest directory inside an enclosing unit', () => {
  const root = tempDir();
  write(root, 'Cargo.toml', '[package]\nname = "monorepo"\n');
  write(root, 'crates/inner/Cargo.toml', '[package]\nname = "inner"\n');
  write(root, 'crates/inner/src/lib.rs', 'pub fn x() {}\n');

  const units = detectUnits(root, ['crates/inner/src/lib.rs'], 'monorepo');
  const inner = units.find((unit) => unit.id === 'crates/inner');
  assert.equal(inner?.parent, '.');
});

test('assignUnits gives a file to its longest enclosing unit', () => {
  const root = tempDir();
  write(root, 'Cargo.toml', '[package]\nname = "outer"\n');
  write(root, 'crates/inner/Cargo.toml', '[package]\nname = "inner"\n');
  const units = detectUnits(
    root,
    ['crates/inner/src/lib.rs', 'src/main.rs'],
    'outer',
  );
  const assignment = assignUnits(['crates/inner/src/lib.rs', 'src/main.rs'], units);
  assert.equal(assignment.get('crates/inner/src/lib.rs'), 'crates/inner');
  assert.equal(assignment.get('src/main.rs'), '.');
});

test('classifyPeriphery names the rule that folded a file into the shelf', () => {
  assert.equal(classifyPeriphery('src/app.ts', 'module'), null);
  assert.equal(classifyPeriphery('src/app.test.ts', 'module')?.category, 'test');
  assert.equal(classifyPeriphery('src/app.ts', 'test')?.category, 'test');
  assert.equal(classifyPeriphery('test/fixtures/data.json', 'module')?.category, 'fixture');
  assert.equal(classifyPeriphery('src/generated/api.ts', 'module')?.category, 'generated');
  assert.equal(classifyPeriphery('proto/user_pb2.py', 'module')?.category, 'generated');
  assert.equal(classifyPeriphery('scripts/build.ps1', 'module')?.category, 'script');
  assert.equal(classifyPeriphery('scripts/deploy.sh', 'module')?.category, 'script');
});

test('buildSystemReport aggregates unit edges, orders layers, and folds support files', () => {
  const root = tempDir();
  write(root, 'crates/api/Cargo.toml', '[package]\nname = "ledger-api"\n');
  write(root, 'crates/core/Cargo.toml', '[package]\nname = "ledger-core"\n');

  const files = [
    'crates/api/src/http/routes.rs',
    'crates/api/src/http/middleware.rs',
    'crates/api/src/service/ledger.rs',
    'crates/api/src/db/store.rs',
    'crates/api/src/util.test.rs',
    'crates/core/src/lib.rs',
  ];
  const graph = graphOf(files, [
    ['crates/api/src/http/routes.rs', 'crates/api/src/service/ledger.rs'],
    ['crates/api/src/http/middleware.rs', 'crates/api/src/http/routes.rs'],
    ['crates/api/src/service/ledger.rs', 'crates/api/src/db/store.rs'],
    ['crates/api/src/db/store.rs', 'crates/core/src/lib.rs'],
  ]);

  const report = buildSystemReport(root, 'ledger', graph);
  const byId = new Map(report.units.map((unit) => [unit.id, unit]));

  assert.equal(byId.get('crates/api')?.name, 'ledger-api');
  assert.equal(byId.get('crates/api')?.files, 4);
  assert.equal(byId.get('crates/api')?.periphery, 1);

  assert.deepEqual(
    report.edges.map((edge) => `${edge.source}->${edge.target}:${edge.weight}`),
    ['crates/api->crates/core:1'],
  );

  const apiLayers = report.layers
    .filter((layer) => layer.unit === 'crates/api')
    .map((layer) => layer.name);
  assert.deepEqual(apiLayers, ['data', 'service', 'http']);

  const apiCommunities = report.communities.filter((community) => community.unit === 'crates/api');
  assert.equal(apiCommunities.length, 1);
  assert.equal(apiCommunities[0]?.layer, 'http');
});

test('buildSystemReport gives a community its internal-edge ratio', () => {
  const root = tempDir();
  write(root, 'pkg/package.json', '{ "name": "widgets" }\n');
  const files = [
    'pkg/src/components/a.ts',
    'pkg/src/components/b.ts',
    'pkg/src/components/c.ts',
  ];
  const graph = graphOf(files, [
    ['pkg/src/components/a.ts', 'pkg/src/components/b.ts'],
    ['pkg/src/components/b.ts', 'pkg/src/components/a.ts'],
  ]);
  const report = buildSystemReport(root, 'widgets', graph);
  const community = report.communities[0];
  assert.equal(community?.internalRatio, 1);
  assert.deepEqual(community?.members.sort(), [
    'pkg/src/components/a.ts',
    'pkg/src/components/b.ts',
  ]);
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

test('GET /analysis/system serves units and their edges', async () => {
  const root = tempDir();
  write(root, 'pkg/package.json', '{ "name": "widgets" }\n');
  write(root, 'pkg/src/components/list.ts', "import { Row } from './row.ts';\nexport const List = Row;\n");
  write(root, 'pkg/src/components/row.ts', 'export const Row = 1;\n');

  const host = express();
  host.use(express.json());
  // A settings store with no persisted overrides, so an operator's saved ceiling on the
  // machine running the tests cannot narrow the temp root out from under the request.
  host.use(
    '/api/strabo',
    createStraboRouter(
      { workspaceRoot: root, scanCeiling: root },
      undefined,
      createSettingsStore({ file: path.join(root, 'settings.json') }),
    ),
  );
  const base = await listen(host);

  const response = await fetch(`${base}/api/strabo/analysis/system`);
  assert.equal(response.status, 200);
  const report = (await response.json()) as {
    units: Array<{ id: string; name: string }>;
    summary: { units: number };
  };
  assert.equal(report.units.find((unit) => unit.id === 'pkg')?.name, 'widgets');
  assert.equal(report.summary.units, report.units.length);
});

test('buildSystemViewModel rolls units into the graph model the map draws', () => {
  const root = tempDir();
  write(root, 'pkg/package.json', '{ "name": "widgets" }\n');
  const graph = graphOf(
    ['pkg/src/components/list.ts', 'pkg/src/components/row.ts'],
    [['pkg/src/components/list.ts', 'pkg/src/components/row.ts']],
  );
  const report = buildSystemReport(root, 'widgets', graph);
  const model = buildSystemViewModel(
    report,
    { name: 'widgets', root, head: null, dirty: false, gitUrl: null },
    { status: 'memory', fingerprint: null, artifactVersion: 'test', generatedAt: 'now' },
  );

  assert.equal(model.system, true);
  assert.equal(model.systemUnit, undefined);
  const pkg = model.nodes.find((node) => node.id === 'pkg');
  assert.equal(pkg?.label, 'widgets');
  assert.equal(pkg?.files, 2);
  assert.match(pkg?.why ?? '', /widgets/);
  assert.deepEqual(
    model.edges.map((edge) => `${edge.source}->${edge.target}`),
    [],
  );
  assert.equal(model.positions.length, model.nodes.length);
  // L14/L18: L0 draws units only — every node is a build unit, never a file or a shelf peer.
  assert.ok(
    model.nodes.every((node) => node.id === 'pkg' || !node.id.includes('/')),
    `unexpected file node at L0: ${model.nodes.map((node) => node.id).join(', ')}`,
  );
  assert.ok(model.nodes.every((node) => node.kind === 'unit'));
});

test('buildSystemViewModel folds support files into the unit card shelf', () => {
  const root = tempDir();
  write(root, 'pkg/package.json', '{ "name": "widgets" }\n');
  const graph = graphOf(
    ['pkg/src/components/list.ts', 'pkg/src/components/list.test.ts'],
    [['pkg/src/components/list.test.ts', 'pkg/src/components/list.ts']],
  );
  const report = buildSystemReport(root, 'widgets', graph);
  const model = buildSystemViewModel(
    report,
    { name: 'widgets', root, head: null, dirty: false, gitUrl: null },
    { status: 'memory', fingerprint: null, artifactVersion: 'test', generatedAt: 'now' },
    graph,
  );

  // L21: the shelf is a footer on the unit card, not a peer node with its own edge.
  assert.equal(model.nodes.some((node) => node.id === 'pkg#support'), false);
  assert.equal(model.edges.length, 0);
  const card = model.unitCards?.find((entry) => entry.id === 'pkg');
  assert.equal(card?.shelf.total, 1);
  assert.equal(card?.shelf.test, 1);
  assert.equal(card?.files, 1);
  // L18: a unit is its own kind, sized by file count, never a file node.
  assert.equal(model.nodes.find((node) => node.id === 'pkg')?.kind, 'unit');
});

test('buildSystemViewModel marks a single unit and fills its card facts (L19, L22)', () => {
  const root = tempDir();
  write(root, 'package.json', '{ "name": "solo" }\n');
  const graph: Graph = {
    nodes: [
      { id: 'src/a.ts', kind: 'module', directory: 'src', language: 'typescript', lines: 120 },
      { id: 'src/b.ts', kind: 'module', directory: 'src', language: 'typescript', lines: 30 },
      { id: 'src/a.test.ts', kind: 'test', directory: 'src', language: 'typescript', lines: 10 },
    ],
    edges: [
      { source: 'src/a.test.ts', target: 'src/a.ts', kind: 'import', evidence: { line: 1, specifier: 'a', resolution: 'exact' } },
      { source: 'src/b.ts', target: 'src/a.ts', kind: 'import', evidence: { line: 1, specifier: 'a', resolution: 'exact' } },
    ],
    diagnostics: [],
    excluded: [],
  };
  const report = buildSystemReport(root, 'solo', graph);
  const model = buildSystemViewModel(
    report,
    { name: 'solo', root, head: null, dirty: false, gitUrl: null },
    { status: 'memory', fingerprint: null, artifactVersion: 'test', generatedAt: 'now' },
    graph,
  );

  // L19: one unit lets the browser open it straight at L1.
  assert.equal(model.systemSingleUnit, '.');
  assert.ok(model.nodes.every((node) => node.kind === 'unit'));
  assert.deepEqual(model.hubs, []);
  const card = model.unitCards?.find((entry) => entry.id === '.');
  assert.equal(card?.files, 2);
  assert.equal(card?.loc, 150);
  assert.deepEqual(card?.languages, { typescript: 2 });
  assert.equal(card?.testReach.reached, 1);
  assert.equal(card?.testReach.total, 2);
  assert.equal(card?.shelf.test, 1);
  // Hotspots need the function analysis, so the server leaves them for the browser.
  assert.equal(card?.hotspots, null);
  assert.ok((card?.layers.length ?? 0) >= 1);
});

test('buildSystemViewModel keeps the L0 map for an unmanifested single unit', () => {
  const root = tempDir();
  const graph = graphOf(['src/a.ts', 'src/b.ts'], [['src/b.ts', 'src/a.ts']]);
  const report = buildSystemReport(root, 'plain', graph);
  const model = buildSystemViewModel(
    report,
    { name: 'plain', root, head: null, dirty: false, gitUrl: null },
    { status: 'memory', fingerprint: null, artifactVersion: 'test', generatedAt: 'now' },
    graph,
  );
  // A fallback root unit is not a build unit an operator recognises, so no auto-open.
  assert.equal(report.units.length, 1);
  assert.equal(model.systemSingleUnit, undefined);
});

test('buildSystemViewModel leaves a multi-unit repository at L0', () => {
  const root = tempDir();
  const graph = twoCrateFixture(root);
  const report = buildSystemReport(root, 'ledger', graph);
  const model = buildSystemViewModel(report, unitDescriptor(root), unitCache, graph);
  assert.equal(model.systemSingleUnit, undefined);
  assert.equal(model.unitCards?.length, report.units.length);
  // The rolled-up import count travels as the edge weight, for the stroke.
  assert.equal(model.edges.length, 1);
  assert.equal(model.edges[0].weight, 1);
  // L20: the dependency sits left of the unit that imports it.
  const coreX = model.positions.find((position) => position.id === 'crates/core')?.x ?? Number.NaN;
  const apiX = model.positions.find((position) => position.id === 'crates/api')?.x ?? Number.NaN;
  assert.ok(coreX < apiX, `expected core left of api, got core=${coreX} api=${apiX}`);
});

/** Two crates: api imports a file in core, which is the one cross-unit edge. */
function twoCrateFixture(root: string): Graph {
  write(root, 'crates/api/Cargo.toml', '[package]\nname = "ledger-api"\n');
  write(root, 'crates/core/Cargo.toml', '[package]\nname = "ledger-core"\n');
  return graphOf(
    [
      'crates/api/src/http/routes.rs',
      'crates/api/src/service/ledger.rs',
      'crates/core/src/lib.rs',
    ],
    [
      ['crates/api/src/http/routes.rs', 'crates/api/src/service/ledger.rs'],
      ['crates/api/src/service/ledger.rs', 'crates/core/src/lib.rs'],
    ],
  );
}

const unitDescriptor = (root: string) => ({
  name: 'ledger',
  root,
  head: null,
  dirty: false,
  gitUrl: null,
});
const unitCache = {
  status: 'memory' as const,
  fingerprint: null,
  artifactVersion: 'test',
  generatedAt: 'now',
};

test('buildSystemUnitViewModel opens a unit with its files and collapses the rest', () => {
  const root = tempDir();
  const graph = twoCrateFixture(root);
  const report = buildSystemReport(root, 'ledger', graph);
  const model = buildSystemUnitViewModel(report, graph, 'crates/api', unitDescriptor(root), unitCache);

  assert.ok(model);
  assert.equal(model.systemUnit, 'crates/api');
  assert.equal(model.systemUnitName, 'ledger-api');
  // The open unit's files are drawn...
  assert.ok(model.nodes.some((node) => node.id === 'crates/api/src/http/routes.rs'));
  assert.ok(model.nodes.some((node) => node.id === 'crates/api/src/service/ledger.rs'));
  // ...the other units are collapsed boxes, still their own kind (L18)...
  const core = model.nodes.find((node) => node.id === 'crates/core');
  assert.equal(core?.collapsed, true);
  assert.equal(core?.kind, 'unit');
  assert.equal(core?.label, 'ledger-core');
  // ...and the layers travel with the model.
  assert.deepEqual(
    model.systemLayers?.map((layer) => layer.name),
    ['service', 'http'],
  );
  // L16: in-unit edges stay inside the unit; nothing crosses its frame.
  assert.ok(model.edges.every((edge) => edge.scope === 'unit'));
  assert.ok(
    model.edges.every(
      (edge) =>
        !edge.target.startsWith('crates/core') || edge.target === 'crates/core',
    ),
  );
  assert.equal(model.outsideLinks?.length, 0);
});

test('buildSystemUnitViewModel carries each file line count from the scan', () => {
  const root = tempDir();
  const graph = twoCrateFixture(root);
  const scanned = {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === 'crates/api/src/http/routes.rs' ? { ...node, lines: 27 } : node,
    ),
  };
  const report = buildSystemReport(root, 'ledger', scanned);
  const model = buildSystemUnitViewModel(report, scanned, 'crates/api', unitDescriptor(root), unitCache);

  assert.equal(model?.nodes.find((node) => node.id === 'crates/api/src/http/routes.rs')?.lines, 27);
  assert.equal(
    model?.nodes.find((node) => node.id === 'crates/api/src/service/ledger.rs')?.lines,
    undefined,
  );
});

test('buildSystemUnitViewModel draws cross-unit links only when asked (L17)', () => {
  const root = tempDir();
  const graph = twoCrateFixture(root);
  const report = buildSystemReport(root, 'ledger', graph);
  const descriptor = unitDescriptor(root);

  const plain = buildSystemUnitViewModel(report, graph, 'crates/api', descriptor, unitCache, {
    selectedFile: 'crates/api/src/service/ledger.rs',
  });
  assert.equal(plain?.outsideLinks?.length, 0);
  assert.equal(plain?.edges.some((edge) => edge.scope === 'outside'), false);

  const outside = buildSystemUnitViewModel(report, graph, 'crates/api', descriptor, unitCache, {
    showOutside: true,
    selectedFile: 'crates/api/src/service/ledger.rs',
  });
  assert.ok(outside);
  assert.equal(outside.outsideLinks?.length, 1);
  const link = outside.outsideLinks?.[0];
  assert.equal(link?.targetUnit, 'crates/core');
  assert.equal(link?.targetName, 'ledger-core');
  assert.equal(link?.count, 1);
  assert.deepEqual(link?.files.map((entry) => entry.file), ['crates/core/src/lib.rs']);
  const crossing = outside.edges.filter((edge) => edge.scope === 'outside');
  assert.deepEqual(
    crossing.map((edge) => `${edge.source}->${edge.target}`),
    ['crates/api/src/service/ledger.rs->crates/core'],
  );

  const expanded = buildSystemUnitViewModel(report, graph, 'crates/api', descriptor, unitCache, {
    showOutside: true,
    selectedFile: 'crates/api/src/service/ledger.rs',
    expandedUnits: ['crates/core'],
  });
  assert.ok(expanded?.nodes.some((node) => node.id === 'crates/core/src/lib.rs'));
  assert.ok(
    expanded?.edges.some(
      (edge) => edge.scope === 'outside' && edge.target === 'crates/core/src/lib.rs',
    ),
  );
});

test('buildSystemUnitViewModel splits blast radius into in-unit and outside counts', () => {
  const root = tempDir();
  write(root, 'crates/api/Cargo.toml', '[package]\nname = "ledger-api"\n');
  write(root, 'crates/core/Cargo.toml', '[package]\nname = "ledger-core"\n');
  const graph = graphOf(
    [
      'crates/api/src/http/routes.rs',
      'crates/api/src/service/other.rs',
      'crates/core/src/consumer.rs',
    ],
    [
      ['crates/api/src/service/other.rs', 'crates/api/src/http/routes.rs'],
      ['crates/core/src/consumer.rs', 'crates/api/src/http/routes.rs'],
    ],
  );
  const report = buildSystemReport(root, 'ledger', graph);
  const model = buildSystemUnitViewModel(report, graph, 'crates/api', unitDescriptor(root), unitCache);

  const routes = model?.nodes.find((node) => node.id === 'crates/api/src/http/routes.rs');
  // Imported by one file in the unit and one in core.
  assert.equal(routes?.inUnitDependents, 1);
  assert.equal(routes?.outsideDependents, 1);
});

test('buildSystemUnitViewModel returns null for an unknown unit', () => {
  const root = tempDir();
  const graph = twoCrateFixture(root);
  const report = buildSystemReport(root, 'ledger', graph);
  const model = buildSystemUnitViewModel(report, graph, 'crates/nope', unitDescriptor(root), unitCache);
  assert.equal(model, null);
});

test('GET /graph?systemUnit= opens a unit and gates cross-unit edges behind outside=1', async () => {
  const root = tempDir();
  write(root, 'crates/api/Cargo.toml', '[package]\nname = "ledger-api"\n');
  write(root, 'crates/core/Cargo.toml', '[package]\nname = "ledger-core"\n');
  write(
    root,
    'crates/api/src/http/routes.rs',
    "pub fn r() {}\n",
  );
  write(
    root,
    'crates/api/src/service/ledger.rs',
    "use crate::core;\npub fn s() { core::run(); }\n",
  );
  write(root, 'crates/core/src/lib.rs', 'pub fn run() {}\n');

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

  const response = await fetch(`${base}/api/strabo/graph?system=1&systemUnit=crates/api`);
  assert.equal(response.status, 200);
  const model = (await response.json()) as {
    systemUnit?: string;
    edges: Array<{ scope?: string }>;
  };
  assert.equal(model.systemUnit, 'crates/api');
  assert.ok(model.edges.every((edge) => edge.scope === 'unit'));
});

test('GET /graph?system=1 serves the unit roll-up', async () => {
  const root = tempDir();
  write(root, 'pkg/package.json', '{ "name": "widgets" }\n');
  write(root, 'pkg/src/components/list.ts', "import { Row } from './row.ts';\nexport const List = Row;\n");
  write(root, 'pkg/src/components/row.ts', 'export const Row = 1;\n');

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

  const response = await fetch(`${base}/api/strabo/graph?system=1`);
  assert.equal(response.status, 200);
  const model = (await response.json()) as {
    system?: boolean;
    nodes: Array<{ id: string; name?: string; files?: number; label?: string }>;
  };
  assert.equal(model.system, true);
  assert.equal(model.nodes.find((node) => node.id === 'pkg')?.label, 'widgets');
});

test('readDeclaredGroups reads name/globs and ignores a malformed entry', () => {
  const root = tempDir();
  write(
    root,
    'strabo.groups.yml',
    ['groups:', '  - name: Billing', '    globs:', '      - src/billing/**', '  - name: Bad', ''].join('\n'),
  );

  assert.deepEqual(readDeclaredGroups(root), [{ name: 'Billing', globs: ['src/billing/**'] }]);
});

test('buildSystemReport lets a declared group override the derived units', () => {
  const root = tempDir();
  write(root, 'Cargo.toml', '[package]\nname = "monorepo"\n');
  write(
    root,
    'strabo.groups.yml',
    ['groups:', '  - name: Billing', '    globs: ["src/**"]'].join('\n'),
  );

  const graph = graphOf(['src/billing/invoice.ts', 'auth/login.ts'], []);
  const report = buildSystemReport(root, 'monorepo', graph);

  const billing = report.units.find((unit) => unit.id === 'Billing');
  assert.equal(billing?.declared, true);
  assert.equal(billing?.files, 1);
  assert.match(billing?.why ?? '', /declared group/);
  // The file the root unit would have owned is reported as taken over.
  assert.deepEqual(billing?.overrides, ['.']);
  // The root unit keeps the file the declared glob did not claim.
  assert.equal(report.units.find((unit) => unit.id === '.')?.files, 1);
});

test('the polyglot fixture detects a Gradle app, two Cargo crates, and a script shelf', async () => {
  const graph = (await scanRepository(fixtureRepo)).graph;
  const report = buildSystemReport(fixtureRepo, 'system-repo', graph);

  const names = report.units.map((unit) => unit.name);
  assert.ok(names.includes('mobile-app'), `expected mobile-app in ${names.join(', ')}`);
  assert.ok(names.includes('alpha'), `expected alpha in ${names.join(', ')}`);
  assert.ok(names.includes('beta'), `expected beta in ${names.join(', ')}`);
  // The root Gradle unit owns the scripts/ folder, so its shelf holds the script.
  assert.ok(
    report.periphery.some((entry) => entry.category === 'script' && entry.unit === '.'),
    'the script should fold into the root unit shelf',
  );
});

test('buildDirectoryLabels anchors a directory label at its unit', () => {
  const root = tempDir();
  write(root, 'service-rust/Cargo.toml', '[package]\nname = "service"\n');
  write(root, 'service-rust/src/handlers/a.rs', 'pub fn a() {}\n');

  const labels = buildDirectoryLabels(
    root,
    ['service-rust/src/handlers/a.rs'],
    'repo',
  );
  assert.equal(labels['service-rust/src/handlers'], 'service \u203a handlers');
});
