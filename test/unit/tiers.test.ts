import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import express from 'express';

import { buildTierReport } from '../../src/analysis/tiers.ts';
import { createStraboRouter } from '../../src/index.ts';
import { createSettingsStore } from '../../src/state/settings-store.ts';
import {
  classifyTierContent,
  classifyTiers,
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

test('unitRole reads the unit from its files and entry shape', () => {
  const tierOf = (file: string) =>
    file.includes('components') ? ('frontend' as const) : file.includes('routes') ? ('api' as const) : ('unclassified' as const);

  assert.equal(unitRole({ id: 'app', name: 'app' }, ['app/ui/components/Home.kt'], tierOf).role, 'app');
  assert.equal(unitRole({ id: 'api', name: 'api' }, ['api/routes/orders.ts'], tierOf).role, 'service');
  assert.equal(unitRole({ id: '.', name: 'root' }, ['scripts/release.ts'], () => 'unclassified').role, 'tool');
  assert.equal(unitRole({ id: 'core', name: 'core' }, ['core/lib.rs'], () => 'data').role, 'library');
});
