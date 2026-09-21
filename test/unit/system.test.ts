import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import express from 'express';

import {
  assignUnits,
  buildSystemReport,
  classifyPeriphery,
  createStraboRouter,
  detectUnits,
} from '../../src/index.ts';
import type { Graph } from '../../src/index.ts';
import { createSettingsStore } from '../../src/state/settings-store.ts';

const created: string[] = [];
const servers: Array<ReturnType<typeof express.application.listen>> = [];

after(() => {
  for (const server of servers) {
    server.close();
  }
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
