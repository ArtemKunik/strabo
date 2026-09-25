import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import express from 'express';

import { buildTierReport } from '../../src/analysis/tiers.ts';
import { computeMeasuredCoverage, createStraboRouter, scanRepository } from '../../src/index.ts';
import { createSettingsStore } from '../../src/state/settings-store.ts';
import {
  classifyTierContent,
  classifyTiers,
  extractTables,
  readDeclaredTiers,
  unitRole,
} from '../../src/analysis/tiers.ts';

const created: string[] = [];
const servers: Array<ReturnType<typeof express.application.listen>> = [];

after(() => {
  for (const server of servers) {
    server.close();
  }
  for (const directory of created) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // best-effort teardown
    }
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

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-tiers-'));
  created.push(directory);
  return directory;
}

function write(root: string, file: string, content: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

test('classifyTierContent reads a framework import as the strongest evidence', () => {
  assert.equal(
    classifyTierContent('src/server.ts', "import express from 'express';\n").tier,
    'api',
  );
  assert.equal(
    classifyTierContent('src/db.rs', 'use sqlx::PgPool;\n').tier,
    'data',
  );
  assert.equal(
    classifyTierContent('crates/api/src/main.rs', 'use axum::Router;\n').tier,
    'api',
  );
});

test('classifyTierContent reads annotations when no framework import names a tier', () => {
  const frontend = classifyTierContent('app/src/main/kotlin/Home.kt', '@Composable\nfun Home() {}');
  assert.equal(frontend.tier, 'frontend');
  assert.ok(frontend.evidence.some((entry) => entry.strength === 'annotation'));

  const api = classifyTierContent('src/Home.java', '@RestController\nclass Home {}');
  assert.equal(api.tier, 'api');
});

test('classifyTierContent reads file kinds', () => {
  assert.equal(classifyTierContent('db/migrations/001_init.sql', '').tier, 'data');
  assert.equal(classifyTierContent('deploy/Dockerfile', '').tier, 'infra');
  assert.equal(classifyTierContent('infra/main.tf', '').tier, 'infra');
  assert.equal(classifyTierContent('.github/workflows/ci.yml', '').tier, 'build');
  assert.equal(classifyTierContent('Cargo.toml', '').tier, 'build');
  assert.equal(classifyTierContent('package.json', '').tier, 'build');
  assert.equal(classifyTierContent('.editorconfig', '').tier, 'infra');
  assert.equal(classifyTierContent('public/index.html', '').tier, 'frontend');
  assert.equal(classifyTierContent('src/feature.test.ts', '').tier, 'tests');
});

test('classifyTierContent falls back to a path token and flags a mixed file', () => {
  assert.equal(classifyTierContent('src/handlers/orders.ts', 'export const x = 1;').tier, 'api');
  assert.equal(classifyTierContent('src/components/Button.tsx', 'export const x = 1;').tier, 'frontend');

  const mixed = classifyTierContent(
    'src/orders.ts',
    "import express from 'express';\nimport React from 'react';\n",
  );
  assert.equal(mixed.mixed, true);
  // Two frameworks at the same strength: the upper tier is the primary, not a forced guess.
  assert.equal(mixed.tier, 'frontend');
});

test('classifyTierContent leaves a file with no evidence unclassified', () => {
  const result = classifyTierContent('src/thing.ts', 'const value = 1;\n');
  assert.equal(result.tier, 'unclassified');
  assert.deepEqual(result.evidence, []);
});

test('classifyTierContent reads a CommonJS require as framework evidence', () => {
  assert.equal(
    classifyTierContent('src/app.js', "const express = require('express');\n").tier,
    'api',
  );
});

test('classifyTierContent reads a route declaration as an endpoint', () => {
  const result = classifyTierContent(
    'src/kernel/thing.ts',
    "app.get('/health', (req, res) => res.send('ok'));\n",
  );
  assert.equal(result.tier, 'api');
  assert.ok(result.evidence.some((entry) => entry.strength === 'endpoint'));
});

test('classifyTierContent reads C++ framework imports', () => {
  assert.equal(classifyTierContent('src/web/main.cpp', '#include <httplib.h>\n').tier, 'api');
  assert.equal(classifyTierContent('src/store/main.cpp', '#include <sqlite3.h>\n').tier, 'data');
});

test('classifyTierContent reads an OpenAPI document as API', () => {
  assert.equal(classifyTierContent('docs/openapi.yaml', '').tier, 'api');
  assert.equal(classifyTierContent('docs/swagger.json', '').tier, 'api');
});

test('classifyTierContent reads a file-name convention, and a test suffix still wins', () => {
  assert.equal(classifyTierContent('src/orders.controller.ts', 'export const x = 1;').tier, 'api');
  assert.equal(classifyTierContent('src/UserRepository.java', 'class UserRepository {}').tier, 'data');
  assert.equal(classifyTierContent('src/PaymentClient.cs', 'class PaymentClient {}').tier, 'integration');
  assert.equal(classifyTierContent('src/orders.controller.test.ts', '').tier, 'tests');
});

test('a declared tier overrides the derived one and says so', () => {
  const result = classifyTierContent(
    'src/handlers/orders.ts',
    "import express from 'express';\n",
    [{ tier: 'data', globs: ['src/handlers/**'] }],
  );
  assert.equal(result.tier, 'data');
  assert.equal(result.mixed, false);
  assert.equal(result.evidence[0]?.strength, 'declared');
});

test('readDeclaredTiers reads tier/globs from strabo.groups.yml', () => {
  const root = tempDir();
  write(
    root,
    'strabo.groups.yml',
    ['tiers:', '  - tier: data', '    globs: ["src/persistence/**"]', '  - tier: nonsense'].join('\n'),
  );
  assert.deepEqual(readDeclaredTiers(root), [{ tier: 'data', globs: ['src/persistence/**'] }]);
});

test('classifyTiers reads files and reports the unreadable as skipped', () => {
  const root = tempDir();
  write(root, 'src/server.ts', "import express from 'express';\n");
  write(root, 'src/plain.ts', 'const value = 1;\n');

  const { files, skipped } = classifyTiers(root, ['src/server.ts', 'src/plain.ts', 'src/missing.ts']);
  assert.deepEqual(files.map((entry) => [entry.file, entry.tier]), [
    ['src/server.ts', 'api'],
    ['src/plain.ts', 'unclassified'],
  ]);
  assert.deepEqual(skipped, ['src/missing.ts']);
});

test('buildTierReport rolls files up per unit and gives the unit a role', () => {
  const root = tempDir();
  write(root, 'package.json', '{ "name": "web" }\n');
  write(root, 'src/components/App.tsx', 'export const App = 1;\n');
  write(root, 'src/data/store.ts', 'export const store = 1;\n');

  const report = buildTierReport(root, 'web', {
    nodes: [{ id: 'src/components/App.tsx' }, { id: 'src/data/store.ts' }],
  });

  assert.equal(report.summary.frontend, 1);
  assert.equal(report.summary.data, 1);
  assert.equal(report.summary.total, 2);
  const unit = report.units.find((entry) => entry.id === '.');
  assert.equal(unit?.role, 'app');
  assert.equal(unit?.files, 2);
});

test('GET /analysis/tiers serves the tier report', async () => {
  const root = tempDir();
  write(root, 'package.json', '{ "name": "web" }\n');
  write(root, 'src/components/App.tsx', 'export const App = 1;\n');

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

  const response = await fetch(`${base}/api/strabo/analysis/tiers`);
  assert.equal(response.status, 200);
  const report = (await response.json()) as { summary: { frontend: number; total: number } };
  assert.equal(report.summary.frontend, 1);
  assert.equal(report.summary.total, 1);
});

test('extractTables reads SQL, ORM, and string-literal tables with their rule', () => {
  const sql = extractTables('db/schema.sql', 'CREATE TABLE users (id int);\nALTER TABLE orders ADD x int;');
  assert.deepEqual(
    sql.map((entry) => [entry.table, entry.evidence]),
    [
      ['orders', 'SQL keyword'],
      ['users', 'SQL keyword'],
    ],
  );

  assert.equal(extractTables('M.kt', '@Entity(tableName = "users")').at(0)?.table, 'users');
  assert.equal(extractTables('m.rs', '#[table(name = "skills")]').at(0)?.table, 'skills');
  assert.equal(
    extractTables('db.ts', 'db.query("SELECT * FROM users WHERE id = 1");').at(0)?.table,
    'users',
  );
});

test('buildTierReport builds the tier matrix and flags wrong-way edges', () => {
  const root = tempDir();
  write(root, 'package.json', '{ "name": "web" }\n');
  write(root, 'src/components/App.tsx', "import { store } from '../data/store';\nexport const App = store;\n");
  write(root, 'src/data/store.ts', "import { route } from '../handlers/orders';\nexport const store = route;\n");
  write(root, 'src/handlers/orders.ts', 'export const route = 1;\n');

  const report = buildTierReport(root, 'web', {
    nodes: [
      { id: 'src/components/App.tsx' },
      { id: 'src/data/store.ts' },
      { id: 'src/handlers/orders.ts' },
    ],
    edges: [
      {
        source: 'src/components/App.tsx',
        target: 'src/data/store.ts',
        evidence: { line: 1, specifier: '../data/store' },
      },
      {
        source: 'src/data/store.ts',
        target: 'src/handlers/orders.ts',
        evidence: { line: 1, specifier: '../handlers/orders' },
      },
    ],
  });

  const cell = report.matrix.cells.find((entry) => entry.unit === '.' && entry.tier === 'data');
  assert.equal(cell?.files, 1);
  assert.equal(report.matrix.perTier.find((entry) => entry.tier === 'data')?.fileShare, 0.333);

  const kinds = report.directions.map((entry) => entry.kind).sort();
  assert.deepEqual(kinds, ['skip-layer', 'upward']);
  assert.equal(report.directions.find((entry) => entry.kind === 'upward')?.target, 'src/handlers/orders.ts');
});

test('buildTierReport reads measured coverage for matrix cells and per-tier stats (U2)', async () => {
  const root = tempDir();
  write(root, 'package.json', '{ "name": "web" }\n');
  write(root, 'src/data/store.ts', 'export function store(): number {\n  return 1;\n}\n');
  write(root, 'src/data/store.test.ts', "import { store } from './store';\nexport const t = store();\n");
  write(root, 'coverage/lcov.info', 'SF:src/data/store.ts\nDA:1,0\nDA:2,0\nLF:2\nLH:0\nend_of_record\n');

  const { graph } = await scanRepository(root);
  const measured = await computeMeasuredCoverage(root, graph);
  const report = buildTierReport(root, 'web', graph, measured);

  // The data cell holds only the 0%-measured module, so the aggregate is that file's figure.
  const cell = report.matrix.cells.find((entry) => entry.tier === 'data');
  assert.ok(cell, 'the data tier cell holds the module a test imports');
  assert.equal(cell.coverage.basis, 'measured');
  assert.equal(cell.coverage.value, 0, 'measured 0%, not the reachable fallback');
  assert.equal(cell.coverage.filesMeasured, 1);
  assert.equal(cell.coverage.reached, 1, 'a test imports it, so reach is still counted beside it');
  assert.equal(cell.coverage.reportAgeMs !== null, true, 'the report age travels with the figure');

  const perTier = report.matrix.perTier.find((entry) => entry.tier === 'data');
  assert.equal(perTier?.coverage.basis, 'measured');
  assert.equal(perTier?.coverage.value, 0);
});

test('buildTierReport falls back to labelled reachability with no report (U2)', async () => {
  const root = tempDir();
  write(root, 'package.json', '{ "name": "web" }\n');
  write(root, 'src/data/store.ts', 'export function store(): number {\n  return 1;\n}\n');
  write(root, 'src/data/store.test.ts', "import { store } from './store';\nexport const t = store();\n");

  const { graph } = await scanRepository(root);
  const measured = await computeMeasuredCoverage(root, graph);
  assert.equal(measured.available, false);
  const report = buildTierReport(root, 'web', graph, measured);

  const cell = report.matrix.cells.find((entry) => entry.tier === 'data');
  assert.equal(cell?.coverage.basis, 'reachable');
  assert.equal(cell?.coverage.value, null, 'no report means no measured percent');
  assert.equal(cell?.coverage.reached, 1, 'the module is reached by its test: the labelled fallback');
  assert.equal(report.matrix.coverage.reportAgeMs, null);
});

test('propagateTiers gives an unclassified file its neighbours majority tier', () => {
  const root = tempDir();
  write(root, 'package.json', '{ "name": "core" }\n');
  write(root, 'src/api/server.ts', "import express from 'express';\nexport const a = 1;\n");
  write(root, 'src/api/routes.ts', "import express from 'express';\nexport const b = 1;\n");
  write(root, 'src/kernel/thing.ts', 'export const thing = 1;\n');

  const report = buildTierReport(root, 'core', {
    nodes: [
      { id: 'src/api/server.ts' },
      { id: 'src/api/routes.ts' },
      { id: 'src/kernel/thing.ts' },
    ],
    edges: [
      { source: 'src/api/server.ts', target: 'src/kernel/thing.ts' },
      { source: 'src/api/routes.ts', target: 'src/kernel/thing.ts' },
    ],
  });

  const thing = report.files.find((entry) => entry.file === 'src/kernel/thing.ts');
  assert.equal(thing?.tier, 'api');
  assert.equal(thing?.evidence.at(-1)?.strength, 'graph');
});

test('propagateTiers needs more than one classified neighbour', () => {
  const root = tempDir();
  write(root, 'package.json', '{ "name": "core" }\n');
  write(root, 'src/api/server.ts', "import express from 'express';\n");
  write(root, 'src/kernel/thing.ts', 'export const thing = 1;\n');

  const report = buildTierReport(root, 'core', {
    nodes: [{ id: 'src/api/server.ts' }, { id: 'src/kernel/thing.ts' }],
    edges: [{ source: 'src/api/server.ts', target: 'src/kernel/thing.ts' }],
  });

  assert.equal(
    report.files.find((entry) => entry.file === 'src/kernel/thing.ts')?.tier,
    'unclassified',
  );
});

test('propagateTiers does not lend a support tier', () => {
  const root = tempDir();
  write(root, 'package.json', '{ "name": "core" }\n');
  write(root, 'test/api.test.ts', 'export const a = 1;\n');
  write(root, 'test/helper.test.ts', 'export const b = 1;\n');
  write(root, 'src/kernel/thing.ts', 'export const thing = 1;\n');

  const report = buildTierReport(root, 'core', {
    nodes: [
      { id: 'test/api.test.ts' },
      { id: 'test/helper.test.ts' },
      { id: 'src/kernel/thing.ts' },
    ],
    edges: [
      { source: 'test/api.test.ts', target: 'src/kernel/thing.ts' },
      { source: 'test/helper.test.ts', target: 'src/kernel/thing.ts' },
    ],
  });

  assert.equal(
    report.files.find((entry) => entry.file === 'src/kernel/thing.ts')?.tier,
    'unclassified',
  );
});

test('unitRole reads the unit from its files and entry shape', () => {
  const tierOf = (file: string) =>
    file.includes('components') ? ('frontend' as const) : file.includes('routes') ? ('api' as const) : ('unclassified' as const);

  assert.equal(unitRole({ id: 'app', name: 'app' }, ['app/ui/components/Home.kt'], tierOf).role, 'app');
  assert.equal(unitRole({ id: 'api', name: 'api' }, ['api/routes/orders.ts'], tierOf).role, 'service');
  assert.equal(unitRole({ id: '.', name: 'root' }, ['scripts/release.ts'], () => 'unclassified').role, 'tool');
  assert.equal(unitRole({ id: 'core', name: 'core' }, ['core/lib.rs'], () => 'data').role, 'library');
});
