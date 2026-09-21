import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import express from 'express';

import { createWorkspaceRouter } from '../../src/api/routes/workspace.ts';
import { openWorkspaceCache } from '../../src/cache/workspace-cache.ts';
import type { DatabaseDriver, DatabaseSession } from '../../src/workspace/probe.ts';
import type { StraboConfig } from '../../src/types.ts';

const created: string[] = [];
const servers: Server[] = [];

after(() => {
  for (const server of servers) {
    server.close();
  }
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const URL = 'postgres://reader:s3cretpass@db.internal:5432/app';

interface Harness {
  base: string;
  sent: string[];
  env: NodeJS.ProcessEnv;
}

let harness: Harness;

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' });
}

before(async () => {
  const ceiling = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-routes-'));
  created.push(ceiling);
  const repo = path.join(ceiling, 'app');
  fs.mkdirSync(path.join(repo, 'db'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'db', 'V1__init.sql'),
    'CREATE TABLE users (id integer PRIMARY KEY, email text, name varchar(255));',
  );
  fs.writeFileSync(
    path.join(repo, 'src', 'users.ts'),
    "export const insert = 'INSERT INTO users (id, email) VALUES ($1, $2)';\nexport const bad = 'SELECT missing_col FROM users';\n",
  );
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Tester');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  // Pending, uncommitted change: tighten the schema.
  fs.writeFileSync(
    path.join(repo, 'db', 'V2__tighten.sql'),
    'ALTER TABLE users ALTER COLUMN email SET NOT NULL;\nALTER TABLE users ADD COLUMN status text NOT NULL;',
  );

  const configPath = path.join(ceiling, 'workspace.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      name: 'acme',
      repositories: ['app'],
      databases: [{ name: 'prod', dialect: 'postgres', urlEnv: 'STRABO_DB_PROD' }],
    }),
  );

  const sent: string[] = [];
  const driver: DatabaseDriver = {
    async connect(): Promise<DatabaseSession> {
      return {
        async query(sql): Promise<Array<Record<string, unknown>>> {
          sent.push(sql);
          if (sql.includes('pg_attribute')) {
            return [
              { schema_name: 'public', table_name: 'users', column_name: 'id', type: 'integer', not_null: true, default_expr: null, identity: '', generated: '' },
              { schema_name: 'public', table_name: 'users', column_name: 'email', type: 'text', not_null: false, default_expr: null, identity: '', generated: '' },
            ];
          }
          if (sql.includes('pg_constraint') || sql.includes('pg_indexes')) {
            return [];
          }
          return [{ violations: sql.includes('email IS NULL') ? '4' : 0 }];
        },
        async close(): Promise<void> {},
      };
    },
  };

  const env: NodeJS.ProcessEnv = { STRABO_DB_PROD: URL };
  const config: StraboConfig = { workspaceRoot: repo, scanCeiling: ceiling, configPath };
  const cacheFile = path.join(ceiling, 'workspace-cache.json');
  const app = express();
  app.use(express.json());
  app.use('/api', createWorkspaceRouter(config, { env, driver, cache: openWorkspaceCache({ file: cacheFile }) }));
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  harness = { base: `http://127.0.0.1:${address.port}/api`, sent, env };
});

async function json(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${harness.base}${pathname}`, init);
  return { status: response.status, body: await response.json() };
}

function post(pathname: string, body: unknown, headers: Record<string, string> = {}) {
  return json(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('GET /workspace/schema serves the snapshot and GET /workspace/schema/usage checks code against it', async () => {
  const schema = await json('/workspace/schema');
  assert.equal(schema.status, 200);
  assert.deepEqual(
    schema.body.schemas.map((entry: any) => [entry.repository, entry.origin, entry.files, entry.tables.map((table: any) => table.name)]),
    [['app', 'migrations', ['db/V1__init.sql', 'db/V2__tighten.sql'], ['users']]],
  );

  const usage = await json('/workspace/schema/usage');
  assert.equal(usage.status, 200);
  assert.equal(usage.body.usage.checked, true);
  assert.deepEqual(
    usage.body.usage.findings.map((entry: any) => [entry.kind, entry.table, entry.column, entry.file, entry.line]),
    [['unknown-column', 'users', 'missing_col', 'src/users.ts', 2]],
  );
});

test('GET /workspace/compat and /workspace/preflight compare the working tree with a revision', async () => {
  const compat = await json('/workspace/compat?base=HEAD');
  assert.equal(compat.status, 200);
  const report = compat.body.reports[0];
  assert.equal(report.repository, 'app');
  assert.deepEqual(
    report.changes.map((entry: any) => `${entry.compatibility}: ${entry.id}.${entry.name} ${entry.change}`),
    ['breaking: users.email nullability-changed', 'breaking: users.status added'],
  );
  assert.deepEqual(
    report.changes[0].references.map((entry: any) => entry.file),
    ['src/users.ts'],
    'the code that writes the now-required column is named',
  );

  const missing = await json('/workspace/compat?base=no-such-branch');
  assert.match(missing.body.reports[0].unavailable, /does not exist/);

  const preflight = await json('/workspace/preflight?base=HEAD');
  assert.deepEqual(
    preflight.body.reports[0].checks.map((entry: any) => entry.operation).sort(),
    ['add-not-null-column', 'set-not-null'],
  );

  const script = await fetch(`${harness.base}/workspace/preflight?base=HEAD&format=sql`);
  assert.match(script.headers.get('content-type') ?? '', /text\/plain/);
  assert.match(await script.text(), /SELECT COUNT\(\*\) AS violations FROM users WHERE email IS NULL;/);
});

test('GET /workspace/databases lists declared databases without their connection strings', async () => {
  const result = await json('/workspace/databases');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.databases, [{ name: 'prod', dialect: 'postgres', urlEnv: 'STRABO_DB_PROD', configured: true }]);
  assert.doesNotMatch(JSON.stringify(result.body), /s3cretpass|db\.internal/);
});

test('POST /workspace/preflight/run runs the generated checks and records the run', async () => {
  harness.sent.length = 0;
  // A caller cannot supply SQL: the body's extra fields are not read.
  const run = await post('/workspace/preflight/run', { database: 'prod', base: 'HEAD', sql: 'DROP TABLE users' });
  assert.equal(run.status, 200);
  assert.equal(run.body.database, 'prod');
  const checks = run.body.reports[0].checks;
  const notNull = checks.find((entry: any) => entry.operation === 'set-not-null');
  assert.equal(notNull.result.status, 'violations');
  assert.equal(notNull.result.violations, 4);
  const added = checks.find((entry: any) => entry.operation === 'add-not-null-column');
  assert.equal(added.result.status, 'ok');
  assert.ok(harness.sent.length === 2 && harness.sent.every((sql) => /^SELECT COUNT/.test(sql)));
  assert.ok(!harness.sent.some((sql) => /DROP/.test(sql)));
  assert.doesNotMatch(JSON.stringify(run.body), /s3cretpass|db\.internal/);

  const listed = await json('/workspace/databases');
  assert.deepEqual(
    listed.body.runs.filter((entry: any) => entry.kind === 'preflight').map((entry: any) => [entry.database, entry.repository, entry.checks, entry.violations, entry.errors]),
    [['prod', 'app', 2, 1, 0]],
  );
});

test('a probe is refused from another origin, for an undeclared database, and without a connection string', async () => {
  harness.sent.length = 0;
  const crossOrigin = await post('/workspace/preflight/run', { database: 'prod' }, { origin: 'https://evil.example', host: 'localhost' });
  assert.equal(crossOrigin.status, 403);

  const undeclared = await post('/workspace/preflight/run', { database: 'other' });
  assert.equal(undeclared.status, 404);
  const none = await post('/workspace/live/schema', {});
  assert.equal(none.status, 404);
  assert.equal(harness.sent.length, 0, 'nothing reached the database');

  delete harness.env.STRABO_DB_PROD;
  const unset = await post('/workspace/preflight/run', { database: 'prod' });
  assert.equal(unset.status, 400);
  assert.match(unset.body.error, /STRABO_DB_PROD is not set/);
  const listed = await json('/workspace/databases');
  assert.equal(listed.body.databases[0].configured, false);
  harness.env.STRABO_DB_PROD = URL;
});

test('POST /workspace/live/schema reads the catalog and reports drift against the migrations', async () => {
  const live = await post('/workspace/live/schema', { database: 'prod' });
  assert.equal(live.status, 200);
  assert.equal(live.body.database, 'prod');
  assert.equal(live.body.tables, 1);
  assert.equal(live.body.snapshot.origin, 'live');
  assert.deepEqual(
    live.body.drift.map((entry: any) => [entry.table, entry.column, entry.kind]),
    [
      ['users', 'email', 'nullability'],
      ['users', 'name', 'column-not-in-live'],
      ['users', 'status', 'column-not-in-live'],
    ],
    'the pending migration would tighten email, and the live catalog here lacks two columns',
  );
  assert.doesNotMatch(JSON.stringify(live.body), /s3cretpass|db\.internal/);
});
