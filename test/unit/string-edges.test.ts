import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { computeStringEdges } from '../../src/analysis/string-edges.ts';
import { scanRepository } from '../../src/index.ts';
import type { Graph } from '../../src/index.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(prefix = 'strabo-string-edges-'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(directory);
  return directory;
}

function write(root: string, file: string, content: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

test('computeStringEdges joins env and flag reads to their declarations', async () => {
  const root = tempDir();
  write(
    root,
    'src/app.ts',
    [
      'const url = process.env.DATABASE_URL;',
      "const key = process.env['API_KEY'];",
      'const dynamic = process.env[dynamicName];',
      "if (isEnabled('new-checkout')) { start(); }",
    ].join('\n') + '\n',
  );
  write(root, '.env', 'DATABASE_URL=postgres://localhost/db\nAPI_KEY=secret\n');
  write(root, 'config/flags.json', JSON.stringify({ 'new-checkout': true }, null, 2));

  const { graph } = await scanRepository(root);
  const report = await computeStringEdges(root, graph);

  assert.equal(report.available, true);

  const database = report.env.find((edge) => edge.key === 'DATABASE_URL');
  assert.ok(database);
  assert.equal(database.declared, true);
  assert.deepEqual(database.readers, [{ file: 'src/app.ts', line: 1 }]);
  assert.deepEqual(database.declarations, [{ file: '.env', line: 1 }]);

  const apiKey = report.env.find((edge) => edge.key === 'API_KEY');
  assert.ok(apiKey);
  assert.equal(apiKey.declared, true);
  assert.deepEqual(apiKey.readers, [{ file: 'src/app.ts', line: 2 }]);
  assert.deepEqual(apiKey.declarations, [{ file: '.env', line: 2 }]);

  assert.equal(report.env.some((edge) => edge.key === 'dynamicName'), false);
  assert.ok(
    report.diagnostics.some(
      (entry) =>
        entry.file === 'src/app.ts' &&
        entry.line === 3 &&
        entry.message === 'not resolved: environment key is dynamic',
    ),
  );

  const flag = report.flags.find((edge) => edge.key === 'new-checkout');
  assert.ok(flag);
  assert.equal(flag.declared, true);
  assert.deepEqual(flag.readers, [{ file: 'src/app.ts', line: 4 }]);
  assert.deepEqual(flag.declarations, [{ file: 'config/flags.json', line: 2 }]);
});

test('computeStringEdges joins a literal route call to its OpenAPI declaration', async () => {
  const root = tempDir();
  write(root, 'src/client.ts', "const res = await fetch('https://api.acme.test/v1/users');\n");
  write(
    root,
    'openapi.json',
    JSON.stringify(
      {
        openapi: '3.0.0',
        info: { title: 'Users', version: '1' },
        servers: [{ url: 'https://api.acme.test' }],
        paths: { '/v1/users': { get: {} } },
      },
      null,
      2,
    ),
  );

  const { graph } = await scanRepository(root);
  const report = await computeStringEdges(root, graph);

  const route = report.routes.find((edge) => edge.key === 'GET /v1/users');
  assert.ok(route);
  assert.equal(route.declared, true);
  assert.deepEqual(route.readers, [{ file: 'src/client.ts', line: 1 }]);
  assert.equal(route.declarations[0]?.file, 'openapi.json');
});

test('computeStringEdges sorts and dedupes sites deterministically', async () => {
  const root = tempDir();
  write(root, 'src/b.ts', 'const x = process.env.SHARED;\nconst y = process.env.SHARED;\n');
  write(root, 'src/a.ts', 'const z = process.env.SHARED;\n');
  write(root, '.env', 'SHARED=1\n');

  const { graph } = await scanRepository(root);
  const first = await computeStringEdges(root, graph);
  const second = await computeStringEdges(root, graph);

  const edge = first.env.find((entry) => entry.key === 'SHARED');
  assert.ok(edge);
  assert.deepEqual(edge.readers, [
    { file: 'src/a.ts', line: 1 },
    { file: 'src/b.ts', line: 1 },
    { file: 'src/b.ts', line: 2 },
  ]);
  assert.deepEqual(first, second);
});

test('computeStringEdges reports unavailable when the graph has no nodes', async () => {
  const root = tempDir();
  const graph: Graph = { nodes: [], edges: [], diagnostics: [], excluded: [] };

  const report = await computeStringEdges(root, graph);
  assert.equal(report.available, false);
  assert.ok(report.reason);
  assert.deepEqual(report.env, []);
  assert.deepEqual(report.totals, { env: 0, routes: 0, flags: 0, unresolved: 0 });
});
