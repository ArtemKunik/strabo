import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { endpointPassport, guardStatus, listEndpoints, scanRepository } from '../../src/index.ts';
import { endpointsOverlay, overlayFor } from '../../ui/strabo-overlays.js';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-endpoints-'));
  created.push(directory);
  return directory;
}

function write(root: string, file: string, content: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

/**
 * src/server.ts registers three routes; the users handlers live in src/users.ts, which reaches
 * src/db.ts (SQL on `users`). A test calls GET /users/{id}; the client calls both users routes.
 */
async function fixture() {
  const root = tempDir();
  write(
    root,
    'openapi.json',
    JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Users', version: '1' },
      paths: {
        '/users/{id}': {
          get: {
            parameters: [{ name: 'fields', in: 'query', schema: { type: 'string' } }],
            responses: { '200': { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } },
          },
        },
        '/legacy': { get: {} },
      },
    }),
  );
  write(
    root,
    'src/server.ts',
    [
      "import { showUser, deleteUser } from './users';",
      "app.get('/users/:id', requireAuth, showUser);",
      "app.delete('/users/:id', deleteUser);",
      "app.get('/health', (req, res) => res.send('ok'));",
    ].join('\n'),
  );
  write(
    root,
    'src/users.ts',
    "import { query } from './db';\nexport const showUser = () => query('SELECT id FROM users WHERE id = $1');\nexport const deleteUser = () => query('DELETE FROM users WHERE id = $1');\n",
  );
  write(root, 'src/db.ts', 'export const query = (sql: string) => sql;\n');
  write(root, 'src/client.ts', "export const load = () => fetch('/users/42');\nexport const drop = () => fetch('/users/42', { method: 'DELETE' });\n");
  write(root, 'test/users.test.ts', "import { showUser } from '../src/users';\nawait fetch('/users/1');\n");
  const { graph } = await scanRepository(root);
  return { root, graph };
}

test('guardStatus reads an explicit opt-out before a guard', () => {
  assert.deepEqual(guardStatus(['requireAuth']), { status: 'guarded', evidence: ['requireAuth'] });
  assert.deepEqual(guardStatus(['Authorize', 'AllowAnonymous']), { status: 'anonymous', evidence: ['AllowAnonymous'] });
  assert.deepEqual(guardStatus(['cors', 'rateLimit']), { status: 'none-recorded', evidence: [] });
});

test('listEndpoints joins documents and code, resolves handlers, and reads tests and callers', async () => {
  const { root, graph } = await fixture();
  const report = listEndpoints(root, graph);
  assert.equal(report.available, true);
  const byKey = new Map(report.endpoints.map((entry) => [`${entry.method} ${entry.path}`, entry]));
  assert.deepEqual([...byKey.keys()], ['GET /health', 'GET /legacy', 'DELETE /users/{id}', 'GET /users/{id}']);

  const show = byKey.get('GET /users/{id}');
  assert.ok(show);
  assert.deepEqual(
    show.declarations.map((declaration) => [declaration.origin, declaration.file, declaration.line]),
    [
      ['openapi', 'openapi.json', null],
      ['code', 'src/server.ts', 2],
    ],
  );
  assert.deepEqual(show.handler, { name: 'showUser', file: 'src/users.ts', basis: 'import' });
  assert.deepEqual(show.guard, { status: 'guarded', evidence: ['requireAuth'] });
  assert.deepEqual(show.tests.calls, [{ file: 'test/users.test.ts', line: 2 }]);
  assert.deepEqual(show.tests.reaching, ['test/users.test.ts']);
  assert.equal(show.tested, true);
  assert.deepEqual(show.callers, [{ file: 'src/client.ts', line: 1 }]);

  const drop = byKey.get('DELETE /users/{id}');
  assert.equal(drop?.guard.status, 'none-recorded');
  // The test imports src/users.ts, which holds deleteUser, so it can reach the handler.
  assert.equal(drop?.tested, true);
  assert.deepEqual(drop?.callers, [{ file: 'src/client.ts', line: 2 }]);

  const health = byKey.get('GET /health');
  assert.deepEqual(health?.handler, { name: null, file: 'src/server.ts', basis: 'declaring-file' });
  assert.equal(health?.tested, false);

  assert.deepEqual(report.totals, {
    endpoints: 4,
    byProtocol: { http: 4, grpc: 0, graphql: 0 },
    documentedOnly: 1,
    untested: 1,
    guarded: 1,
    anonymous: 0,
    noGuardRecorded: 2,
  });
});

test('endpointPassport adds the declared shapes and the tables near the handler', async () => {
  const { root, graph } = await fixture();
  const passport = endpointPassport(root, graph, 'get', '/users/{userId}');
  assert.ok(passport);
  assert.deepEqual(passport.parameters, [{ name: 'fields', in: 'query', required: false, type: 'string' }]);
  assert.deepEqual(passport.response?.fields.map((field) => field.name), ['id']);
  assert.deepEqual(passport.middleware, ['requireAuth']);
  assert.deepEqual(passport.downstream.files, ['src/users.ts', 'src/db.ts']);
  assert.deepEqual(
    passport.downstream.tables.map((use) => [use.table, use.access, use.file]),
    [
      ['users', 'read', 'src/users.ts'],
      ['users', 'write', 'src/users.ts'],
    ],
  );
  assert.equal(endpointPassport(root, graph, 'GET', '/nowhere'), null);
});

test('the HTTP endpoints overlay rings files with an untested or unguarded route', async () => {
  const { root, graph } = await fixture();
  const overlay = overlayFor('endpoints', listEndpoints(root, graph));
  assert.equal(overlay.classes.get('src/server.ts'), 'ov-endpoint-gap');
  assert.equal(overlay.summary, '4 endpoint(s) · 1 untested · 2 with no guard recorded');
  assert.deepEqual(
    overlay.items.map((item: { label: string; detail: string }) => [item.label, item.detail]),
    [
      ['GET /health', 'src/server.ts:4 · no test reaches it · no guard recorded'],
      ['DELETE /users/{id}', 'src/server.ts:3 · no guard recorded'],
      ['GET /users/{id}', 'src/server.ts:2'],
    ],
  );
  const empty = endpointsOverlay({ available: false, reason: 'no HTTP endpoint is declared' });
  assert.equal(empty.emptyNote, 'no HTTP endpoint is declared');
});
