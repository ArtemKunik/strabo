import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { readWorkspaceConfig } from '../../src/workspace/config.ts';
import { buildPreflight } from '../../src/workspace/preflight.ts';
import {
  assertReadOnlyQuery,
  compareLiveSchema,
  createPostgresDriver,
  databaseConfigured,
  introspectPostgres,
  ProbeError,
  runPreflight,
  scrub,
  type DatabaseDriver,
  type DatabaseSession,
} from '../../src/workspace/probe.ts';
import { buildSchema } from '../../src/workspace/schema.ts';
import type { DatabaseConfig, PreflightReport } from '../../src/types.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const DATABASE: DatabaseConfig = { name: 'prod', dialect: 'postgres', urlEnv: 'STRABO_DB_PROD' };
const URL = 'postgres://reader:s3cretpass@db.internal:5432/app';

function report(): PreflightReport {
  const base = buildSchema('db', [{ path: 'V1__a.sql', content: 'CREATE TABLE users (id integer, email text, name varchar(255));' }]);
  const head = buildSchema('db', [
    { path: 'V1__a.sql', content: 'CREATE TABLE users (id integer, email text NOT NULL UNIQUE, name varchar(50));' },
  ]);
  return { repository: 'db', base: 'HEAD', head: 'working tree', ...buildPreflight(base, head) };
}

/** A session that answers by matching the statement, and remembers what it was sent. */
function fakeDriver(answer: (sql: string) => unknown): { driver: DatabaseDriver; sent: string[]; closed: () => number; urls: string[] } {
  const sent: string[] = [];
  const urls: string[] = [];
  let closes = 0;
  return {
    sent,
    urls,
    closed: () => closes,
    driver: {
      async connect(url): Promise<DatabaseSession> {
        urls.push(url);
        return {
          async query(sql): Promise<Array<Record<string, unknown>>> {
            sent.push(sql);
            const result = answer(sql);
            if (result instanceof Error) {
              throw result;
            }
            return result as Array<Record<string, unknown>>;
          },
          async close(): Promise<void> {
            closes += 1;
          },
        };
      },
    },
  };
}

test('runPreflight records a result per check and never turns an error into a pass', async () => {
  const fake = fakeDriver((sql) => {
    if (sql.includes('email IS NULL')) {
      return [{ violations: '7' }]; // pg returns bigint counts as strings
    }
    if (sql.includes('HAVING COUNT(*) > 1')) {
      return [{ violations: 0 }];
    }
    return new Error(`canceling statement due to statement timeout while using ${URL}`);
  });
  const now = () => new Date('2026-09-21T10:00:00.000Z');

  const result = await runPreflight(report(), { database: DATABASE, driver: fake.driver, env: { STRABO_DB_PROD: URL }, now });

  const byOperation = Object.fromEntries(result.checks.map((check) => [check.operation, check.result]));
  assert.equal(byOperation['set-not-null']?.status, 'violations');
  assert.equal(byOperation['set-not-null']?.violations, 7);
  assert.equal(byOperation['set-not-null']?.database, 'prod');
  assert.equal(byOperation['set-not-null']?.ranAt, '2026-09-21T10:00:00.000Z');
  assert.equal(byOperation['add-unique']?.status, 'ok');
  assert.equal(byOperation['convert-type']?.status, 'error');
  assert.match(byOperation['convert-type']?.error ?? '', /statement timeout/);
  assert.doesNotMatch(byOperation['convert-type']?.error ?? '', /s3cretpass|reader|db\.internal/, 'the connection string is scrubbed');
  assert.equal(fake.closed(), 1, 'the session is closed');
  assert.deepEqual(fake.urls, [URL]);
  assert.equal(fake.sent.length, 3);
});

test('runPreflight refuses to run without a connection string or when the connection fails', async () => {
  const fake = fakeDriver(() => [{ violations: 0 }]);
  await assert.rejects(
    runPreflight(report(), { database: DATABASE, driver: fake.driver, env: {} }),
    (error: unknown) => error instanceof ProbeError && /STRABO_DB_PROD is not set/.test(error.message),
  );
  assert.equal(fake.sent.length, 0);

  const failing: DatabaseDriver = {
    async connect(url): Promise<DatabaseSession> {
      throw new Error(`password authentication failed for user "reader" at ${url}`);
    },
  };
  await assert.rejects(
    runPreflight(report(), { database: DATABASE, driver: failing, env: { STRABO_DB_PROD: URL } }),
    (error: unknown) =>
      error instanceof ProbeError && /Could not connect/.test(error.message) && !/s3cretpass|db\.internal/.test(error.message),
  );
});

test('databaseConfigured reports presence without revealing the value', () => {
  assert.equal(databaseConfigured(DATABASE, { STRABO_DB_PROD: URL }), true);
  assert.equal(databaseConfigured(DATABASE, { STRABO_DB_PROD: '  ' }), false);
  assert.equal(databaseConfigured(DATABASE, {}), false);
});

test('scrub removes the URL, the password, the user, and any userinfo', () => {
  assert.equal(scrub(new Error(`bad ${URL}`), URL), 'bad ***');
  assert.equal(scrub(new Error('login failed for reader with s3cretpass'), URL), 'login failed for *** with ***');
  assert.equal(scrub(new Error('cannot reach postgres://other:pw@host/db'), URL), 'cannot reach postgres://***@host/db');
  assert.equal(scrub('plain', 'not a url'), 'plain');
});

test('only a single plain SELECT can be sent', () => {
  assertReadOnlyQuery('SELECT COUNT(*) AS violations FROM users WHERE email IS NULL');
  assertReadOnlyQuery('  select count(*) as violations from users');
  for (const bad of [
    'DELETE FROM users',
    'SELECT 1; DROP TABLE users',
    'SELECT 1 -- x',
    'SELECT 1 /* x */',
    'SELECT pg_sleep(100)',
    'SELECT nextval(\'s\')',
    'SELECT * FROM dblink(\'x\', \'y\') AS t(a int)',
    'UPDATE users SET a = 1',
    'WITH x AS (DELETE FROM users RETURNING 1) SELECT COUNT(*) FROM x',
    'SELECT set_config(\'a\', \'b\', false)',
    '',
  ]) {
    assert.throws(() => assertReadOnlyQuery(bad), ProbeError, bad);
  }
});

test('every statement Strabo generates passes its own guard', async () => {
  for (const check of report().checks) {
    assertReadOnlyQuery(check.sql);
  }
  const seen: string[] = [];
  const session: DatabaseSession = {
    async query(sql) {
      seen.push(sql);
      return [];
    },
    async close() {},
  };
  await introspectPostgres(session, 'prod');
  assert.equal(seen.length, 3);
  for (const sql of seen) {
    assertReadOnlyQuery(sql);
  }
});

interface FakePg {
  Client: new (config: Record<string, unknown>) => {
    connect(): Promise<void>;
    query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
    end(): Promise<void>;
  };
  log: string[];
  configs: Array<Record<string, unknown>>;
}

function fakePg(fail?: (sql: string) => boolean): FakePg {
  const log: string[] = [];
  const configs: Array<Record<string, unknown>> = [];
  class Client {
    constructor(config: Record<string, unknown>) {
      configs.push(config);
    }
    async connect(): Promise<void> {
      log.push('connect');
    }
    async query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }> {
      log.push(sql);
      if (fail?.(sql)) {
        throw new Error('canceling statement due to statement timeout');
      }
      return { rows: [{ violations: '3' }] };
    }
    async end(): Promise<void> {
      log.push('end');
    }
  }
  return { Client, log, configs };
}

test('the PostgreSQL driver wraps every statement in its own read-only transaction with a timeout', async () => {
  const pg = fakePg((sql) => sql.startsWith('SELECT COUNT(*) AS violations FROM t WHERE bad'));
  const driver = createPostgresDriver(async () => pg);
  const session = await driver.connect(URL, { statementTimeoutMs: 2500 });

  assert.equal(pg.configs[0]?.connectionString, URL);
  assert.equal(pg.configs[0]?.options, '-c default_transaction_read_only=on', 'the session itself is read-only');

  const rows = await session.query('SELECT COUNT(*) AS violations FROM t');
  assert.deepEqual(rows, [{ violations: '3' }]);
  await assert.rejects(session.query('SELECT COUNT(*) AS violations FROM t WHERE bad'), /statement timeout/);
  await session.close();

  assert.deepEqual(pg.log, [
    'connect',
    'BEGIN READ ONLY',
    'SET LOCAL statement_timeout = 2500',
    'SELECT COUNT(*) AS violations FROM t',
    'ROLLBACK',
    'BEGIN READ ONLY',
    'SET LOCAL statement_timeout = 2500',
    'SELECT COUNT(*) AS violations FROM t WHERE bad',
    'ROLLBACK',
    'end',
  ]);

  await assert.rejects(session.query('DROP TABLE t'), ProbeError);
  assert.ok(!pg.log.includes('DROP TABLE t'), 'a refused statement never reaches the server');
});

test('a missing pg package says what to install', async () => {
  const driver = createPostgresDriver(async () => {
    throw new Error('Cannot find package pg');
  });
  await assert.rejects(driver.connect(URL, { statementTimeoutMs: 1000 }), /npm install pg/);
});

const LIVE_MIGRATIONS = `CREATE TABLE users (
  id serial PRIMARY KEY,
  email varchar(255) NOT NULL,
  age integer,
  role text NOT NULL DEFAULT 'member',
  org_id integer
);
CREATE TABLE orgs (id integer PRIMARY KEY);
ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);
ALTER TABLE users ADD CONSTRAINT age_ok CHECK (age >= 0);
ALTER TABLE users ADD CONSTRAINT users_org_fk FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE;
CREATE INDEX idx_users_role ON users (role);
CREATE TABLE billing.invoices (id integer PRIMARY KEY, total numeric(10,2));`;

/** What a catalog query returns for that schema, as PostgreSQL would print it. */
function catalogSession(overrides: { dropColumn?: boolean; extraTable?: boolean; type?: string } = {}): DatabaseSession {
  const columns: Array<Record<string, unknown>> = [
    { schema_name: 'public', table_name: 'users', column_name: 'id', type: 'integer', not_null: true, default_expr: "nextval('users_id_seq'::regclass)", identity: '', generated: '' },
    { schema_name: 'public', table_name: 'users', column_name: 'email', type: overrides.type ?? 'character varying(255)', not_null: true, default_expr: null, identity: '', generated: '' },
    { schema_name: 'public', table_name: 'users', column_name: 'age', type: 'integer', not_null: false, default_expr: null, identity: '', generated: '' },
    { schema_name: 'public', table_name: 'users', column_name: 'role', type: 'text', not_null: true, default_expr: "'member'::text", identity: '', generated: '' },
    { schema_name: 'public', table_name: 'users', column_name: 'org_id', type: 'integer', not_null: false, default_expr: null, identity: '', generated: '' },
    { schema_name: 'public', table_name: 'orgs', column_name: 'id', type: 'integer', not_null: true, default_expr: null, identity: '', generated: '' },
    { schema_name: 'billing', table_name: 'invoices', column_name: 'id', type: 'integer', not_null: true, default_expr: null, identity: '', generated: '' },
    { schema_name: 'billing', table_name: 'invoices', column_name: 'total', type: 'numeric(10,2)', not_null: false, default_expr: null, identity: '', generated: '' },
    { schema_name: 'public', table_name: 'flyway_schema_history', column_name: 'version', type: 'text', not_null: false, default_expr: null, identity: '', generated: '' },
  ];
  if (overrides.dropColumn) {
    columns.splice(2, 1);
  }
  if (overrides.extraTable) {
    columns.push({ schema_name: 'public', table_name: 'hand_made', column_name: 'x', type: 'integer', not_null: false, default_expr: null, identity: '', generated: '' });
  }
  const constraints = [
    { schema_name: 'public', table_name: 'users', name: 'users_pkey', definition: 'PRIMARY KEY (id)' },
    { schema_name: 'public', table_name: 'users', name: 'users_email_key', definition: 'UNIQUE (email)' },
    { schema_name: 'public', table_name: 'users', name: 'age_ok', definition: 'CHECK ((age >= 0))' },
    { schema_name: 'public', table_name: 'users', name: 'users_org_fk', definition: 'FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE' },
    { schema_name: 'public', table_name: 'orgs', name: 'orgs_pkey', definition: 'PRIMARY KEY (id)' },
    { schema_name: 'billing', table_name: 'invoices', name: 'invoices_pkey', definition: 'PRIMARY KEY (id)' },
  ];
  const indexes = [
    { schema_name: 'public', table_name: 'users', name: 'users_pkey', definition: 'CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)' },
    { schema_name: 'public', table_name: 'users', name: 'users_email_key', definition: 'CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email)' },
    { schema_name: 'public', table_name: 'users', name: 'idx_users_role', definition: 'CREATE INDEX idx_users_role ON public.users USING btree (role)' },
  ];
  return {
    async query(sql) {
      assertReadOnlyQuery(sql);
      if (sql.includes('pg_attribute')) {
        return columns;
      }
      if (sql.includes('pg_constraint')) {
        return constraints;
      }
      return indexes;
    },
    async close() {},
  };
}

test('a live catalog reads back in the same shape as the migrations that built it', async () => {
  const live = await introspectPostgres(catalogSession(), 'prod', () => new Date('2026-09-21T10:00:00.000Z'));
  assert.ok(live);
  assert.equal(live.origin, 'live');
  assert.equal(live.dialect, 'postgres');
  assert.equal(live.capturedAt, '2026-09-21T10:00:00.000Z');
  assert.equal(live.repository, 'prod');

  const repo = buildSchema('app', [{ path: 'V1__init.sql', content: LIVE_MIGRATIONS }]);
  assert.ok(repo);

  const users = live.tables.find((entry) => entry.name === 'users');
  assert.deepEqual(
    users?.columns.map((column) => [column.name, column.type, column.nullable, column.default ?? null]),
    [
      ['id', 'integer', false, 'serial'],
      ['email', 'varchar(255)', false, null],
      ['age', 'integer', true, null],
      ['role', 'text', false, "'member'::text"],
      ['org_id', 'integer', true, null],
    ],
  );
  assert.deepEqual(
    users?.constraints.map((entry) => [entry.kind, entry.name, entry.columns.join(',')]),
    [
      ['primary-key', 'users_pkey', 'id'],
      ['unique', 'users_email_key', 'email'],
      ['check', 'age_ok', ''],
      ['foreign-key', 'users_org_fk', 'org_id'],
    ],
  );
  assert.deepEqual(
    users?.indexes.map((entry) => entry.name),
    ['idx_users_role'],
    'the indexes behind constraints are the constraints, not separate indexes',
  );
  assert.ok(live.tables.some((entry) => entry.name === 'billing.invoices'), 'a non-default schema keeps its prefix');

  assert.deepEqual(compareLiveSchema(live, repo), [], 'live and migrations agree, so there is no drift');
});

test('drift is reported in both directions, ignoring the migration tool\'s own tables', async () => {
  const repo = buildSchema('app', [{ path: 'V1__init.sql', content: LIVE_MIGRATIONS }]);
  assert.ok(repo);

  const live = await introspectPostgres(catalogSession({ dropColumn: true, extraTable: true, type: 'text' }), 'prod');
  assert.ok(live);
  const drift = compareLiveSchema(live, repo).map((entry) => [entry.table, entry.column ?? null, entry.kind, entry.live ?? null, entry.declared ?? null]);
  assert.deepEqual(drift, [
    ['hand_made', null, 'table-not-in-repository', null, null],
    ['users', 'age', 'column-not-in-live', null, 'integer'],
    ['users', 'email', 'type', 'text', 'varchar(255)'],
  ]);
});

test('a database with no tables has no snapshot', async () => {
  const empty: DatabaseSession = { async query() { return []; }, async close() {} };
  assert.equal(await introspectPostgres(empty, 'prod'), null);
});

test('the workspace config declares databases by environment variable and refuses a connection string', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-dbconfig-'));
  created.push(root);
  const write = (databases: unknown): string => {
    const file = path.join(root, 'workspace.json');
    fs.writeFileSync(file, JSON.stringify({ name: 'acme', repositories: ['a'], ...(databases === undefined ? {} : { databases }) }));
    return file;
  };

  assert.deepEqual(readWorkspaceConfig(write(undefined))?.databases, []);
  assert.deepEqual(
    readWorkspaceConfig(write([{ name: 'prod', dialect: 'postgres', urlEnv: 'STRABO_DB_PROD' }]))?.databases,
    [{ name: 'prod', dialect: 'postgres', urlEnv: 'STRABO_DB_PROD' }],
  );

  const refused: Array<[unknown, RegExp]> = [
    [[{ name: 'prod', dialect: 'postgres', url: 'postgres://u:p@h/db' }], /connection string/],
    [[{ name: 'prod', dialect: 'postgres', connectionString: 'x' }], /connection string/],
    [[{ name: 'prod', dialect: 'mysql', urlEnv: 'X' }], /only the dialect "postgres"/],
    [[{ name: 'prod', dialect: 'postgres', urlEnv: 'not a name' }], /urlEnv/],
    [[{ name: 'prod', dialect: 'postgres' }], /urlEnv/],
    [[{ name: '../x', dialect: 'postgres', urlEnv: 'X' }], /simple name/],
    [
      [
        { name: 'prod', dialect: 'postgres', urlEnv: 'A' },
        { name: 'prod', dialect: 'postgres', urlEnv: 'B' },
      ],
      /twice/,
    ],
    [{ name: 'prod' }, /array/],
  ];
  for (const [databases, message] of refused) {
    assert.throws(() => readWorkspaceConfig(write(databases)), message);
  }
});
