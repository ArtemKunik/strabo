import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { analyzePreflight, buildPreflight, renderPreflightScript } from '../../src/workspace/preflight.ts';
import { buildSchema } from '../../src/workspace/schema.ts';
import type { CodeDataUse, PreflightCheck, SqlDialect } from '../../src/types.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function schema(sql: string) {
  return buildSchema('db', [{ path: 'V1__a.sql', content: sql }]);
}

function checksFor(base: string, head: string, dialect?: SqlDialect, uses: CodeDataUse[] = []) {
  return buildPreflight(schema(base), schema(head), { ...(dialect ? { dialect } : {}), uses });
}

function byOperation(checks: PreflightCheck[], operation: string): PreflightCheck {
  const found = checks.find((entry) => entry.operation === operation);
  assert.ok(found, `expected a ${operation} check in ${checks.map((entry) => entry.operation).join(', ')}`);
  return found;
}

const BASE = `CREATE TABLE users (id integer, email text, name varchar(255), age bigint, price numeric(10,2), legacy text);
CREATE TABLE orders (id integer PRIMARY KEY, user_id integer, total numeric(10,2));
CREATE TABLE audit (id integer);`;

test('a tightened column, key, reference and rule each become a counting query', () => {
  const head = `CREATE TABLE users (
  id integer PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name varchar(50),
  age integer,
  price numeric(6,2),
  CONSTRAINT age_ok CHECK (age >= 0)
);
CREATE TABLE orders (id integer PRIMARY KEY, user_id integer REFERENCES users (id), total numeric(10,2));
CREATE UNIQUE INDEX idx_orders_user ON orders (user_id) WHERE total > 0;`;
  const { dialect, checks, skipped } = checksFor(BASE, head);
  assert.equal(dialect, 'postgres');

  assert.equal(
    byOperation(checks, 'set-not-null').sql,
    'SELECT COUNT(*) AS violations FROM users WHERE email IS NULL',
  );
  assert.equal(
    checks.find((entry) => entry.operation === 'add-unique' && entry.table === 'users')?.sql,
    'SELECT COUNT(*) AS violations FROM (SELECT 1 FROM users WHERE email IS NOT NULL GROUP BY email HAVING COUNT(*) > 1) AS duplicates',
  );
  assert.equal(
    byOperation(checks, 'add-primary-key').sql,
    'SELECT (SELECT COUNT(*) FROM users WHERE id IS NULL) + (SELECT COUNT(*) FROM (SELECT 1 FROM users GROUP BY id HAVING COUNT(*) > 1) AS duplicates) AS violations',
  );
  assert.equal(
    byOperation(checks, 'add-foreign-key').sql,
    'SELECT COUNT(*) AS violations FROM orders AS child WHERE child.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users AS parent WHERE parent.id = child.user_id)',
  );
  assert.equal(
    byOperation(checks, 'add-check').sql,
    'SELECT COUNT(*) AS violations FROM users WHERE NOT (age >= 0)',
  );
  const partial = checks.find((entry) => entry.operation === 'add-unique' && entry.table === 'orders');
  assert.equal(
    partial?.sql,
    'SELECT COUNT(*) AS violations FROM (SELECT 1 FROM orders WHERE user_id IS NOT NULL AND (total > 0) GROUP BY user_id HAVING COUNT(*) > 1) AS duplicates',
  );

  const conversions = checks.filter((entry) => entry.operation === 'convert-type');
  assert.deepEqual(
    conversions.map((entry) => [entry.column, entry.sql]).sort(),
    [
      ['age', 'SELECT COUNT(*) AS violations FROM users WHERE age < -2147483648 OR age > 2147483647'],
      ['name', 'SELECT COUNT(*) AS violations FROM users WHERE LENGTH(name) > 50'],
      ['price', 'SELECT COUNT(*) AS violations FROM users WHERE ABS(price) >= 10000'],
    ],
  );

  assert.deepEqual(
    skipped.map((entry) => [entry.table, entry.operation]),
    [],
    'nothing needed skipping here',
  );
  assert.ok(checks.every((entry) => entry.file === 'V1__a.sql' && (entry.line ?? 0) >= 1));
  assert.ok(checks.every((entry) => /^SELECT /.test(entry.sql) && !entry.sql.includes(';')), 'every query is one read-only SELECT');
});

test('drops count the data that would be lost and name the code that still uses it', () => {
  const uses: CodeDataUse[] = [
    { repository: 'api', file: 'src/a.ts', line: 3, table: 'users', columns: ['legacy'], evidence: 'string-literal SQL (SELECT)', confidence: 'weak', access: 'read' },
    { repository: 'api', file: 'src/b.ts', line: 9, table: 'audit', columns: [], evidence: 'string-literal SQL (INSERT)', confidence: 'strong', access: 'write' },
  ];
  const { checks } = checksFor(
    BASE,
    `CREATE TABLE users (id integer, email text, name varchar(255), age bigint, price numeric(10,2));
CREATE TABLE orders (id integer PRIMARY KEY, user_id integer, total numeric(10,2));`,
    undefined,
    uses,
  );

  const column = byOperation(checks, 'drop-column');
  assert.equal(column.severity, 'data-loss');
  assert.equal(column.sql, 'SELECT COUNT(legacy) AS violations FROM users');
  assert.deepEqual(column.references, [{ repository: 'api', file: 'src/a.ts', line: 3 }]);

  const table = byOperation(checks, 'drop-table');
  assert.equal(table.sql, 'SELECT COUNT(*) AS violations FROM audit');
  assert.deepEqual(table.references, [{ repository: 'api', file: 'src/b.ts', line: 9 }]);
  assert.deepEqual(
    checks.map((entry) => entry.severity),
    ['data-loss', 'data-loss'],
    'data-loss checks sort after the ones that block',
  );
});

test('a new table, a new column, and a widening need no data check', () => {
  const { checks, skipped } = checksFor(
    'CREATE TABLE t (id integer, label varchar(10));',
    `CREATE TABLE t (id bigint, label varchar(40), extra text NOT NULL DEFAULT '', code text UNIQUE, ref integer REFERENCES other (id));
CREATE TABLE other (id integer PRIMARY KEY);`,
  );
  assert.deepEqual(checks, []);
  assert.deepEqual(
    skipped.map((entry) => `${entry.table}: ${entry.operation}`).sort(),
    ['t: foreign-key', 't: unique'],
    'constraints on a column the base lacks are listed, with the reason, instead of silently dropped',
  );
  assert.ok(skipped.every((entry) => /base does not have/.test(entry.reason)));
});

test('a NOT NULL column with no default fails a non-empty table on PostgreSQL but not on MySQL', () => {
  const base = 'CREATE TABLE t (id integer);';
  const head = 'CREATE TABLE t (id integer, status text NOT NULL);';
  const postgres = buildPreflight(schema(base), schema(head), { dialect: 'postgres' });
  assert.equal(postgres.checks[0]?.operation, 'add-not-null-column');
  assert.equal(postgres.checks[0]?.sql, 'SELECT COUNT(*) AS violations FROM t');

  const mysql = buildPreflight(schema(base), schema(head), { dialect: 'mysql' });
  assert.deepEqual(mysql.checks, []);
  assert.match(mysql.skipped[0]?.reason ?? '', /MySQL fills/);
});

test('the dialect follows the SQL and changes quoting and the cast checks', () => {
  const base = 'CREATE TABLE `order` (id int, `group` varchar(20), note text) ENGINE=InnoDB;';
  const head = 'CREATE TABLE `order` (id int, `group` varchar(5), note int) ENGINE=InnoDB;';
  const result = checksFor(base, head);
  assert.equal(result.dialect, 'mysql', 'backticks and ENGINE= read as MySQL');
  assert.deepEqual(
    result.checks.map((entry) => entry.sql).sort(),
    [
      "SELECT COUNT(*) AS violations FROM `order` WHERE note IS NOT NULL AND note NOT REGEXP '^[[:space:]]*[+-]?[0-9]+[[:space:]]*$'",
      'SELECT COUNT(*) AS violations FROM `order` WHERE CHAR_LENGTH(`group`) > 5',
    ].sort(),
  );
  assert.ok(result.checks.find((entry) => entry.column === 'note')?.approximate);

  const sqlite = buildPreflight(schema('CREATE TABLE t (n text);'), schema('CREATE TABLE t (n integer);'), { dialect: 'sqlite' });
  assert.match(sqlite.checks[0]?.sql ?? '', /CAST\(CAST\(n AS INTEGER\) AS TEXT\) <> n/);
});

test('a conversion no query can stand in for is listed as skipped with its reason', () => {
  const result = checksFor(
    "CREATE TABLE t (a text, b integer, c integer);\nCREATE TABLE u (x integer);",
    "CREATE TABLE t (a uuid, b integer, c integer);\nCREATE TABLE u (x integer);",
  );
  const reasons = result.skipped.map((entry) => `${entry.operation}: ${entry.reason}`).join(' | ');
  assert.match(reasons, /convert type: converting text to uuid needs a trial cast/);
});

test('an expression that could end or comment out a statement is never embedded', () => {
  const base = schema('CREATE TABLE t (b integer);');
  const head = schema('CREATE TABLE t (b integer, CONSTRAINT c CHECK (b /* x */ > 0));');
  const result = buildPreflight(base, head);
  assert.deepEqual(result.checks, []);
  assert.match(result.skipped[0]?.reason ?? '', /will not embed/);
});

test('a name that is not a plain identifier is skipped rather than embedded', () => {
  const result = buildPreflight(
    schema('CREATE TABLE "weird name" (a integer);'),
    schema('CREATE TABLE "weird name" (a integer NOT NULL);'),
  );
  assert.deepEqual(result.checks, []);
  assert.match(result.skipped[0]?.reason ?? '', /not a plain identifier/);
});

test('the script renders every query with its meaning, and lists what was not checked', () => {
  const result = checksFor(BASE, 'CREATE TABLE users (id integer NOT NULL, email text, name varchar(255), age bigint, price numeric(10,2), legacy text);\nCREATE TABLE orders (id integer PRIMARY KEY, user_id integer, total numeric(10,2));\nCREATE TABLE audit (id integer);');
  const script = renderPreflightScript([
    { repository: 'app', base: 'HEAD', head: 'working tree', ...result },
    { repository: 'gone', base: 'nope', head: 'working tree', dialect: 'postgres', checks: [], skipped: [], unavailable: 'no such revision' },
  ]);
  assert.match(script, /-- ==== app: HEAD -> working tree \(postgres\) ====/);
  assert.match(script, /-- \[blocks\] Make users\.id NOT NULL\./);
  assert.match(script, /SELECT COUNT\(\*\) AS violations FROM users WHERE id IS NULL;/);
  assert.match(script, /-- unavailable: no such revision/);
});

test('analyzePreflight reads the base revision and the working tree', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-preflight-'));
  created.push(root);
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  };
  fs.mkdirSync(path.join(root, 'db'));
  fs.writeFileSync(path.join(root, 'db', 'V1__init.sql'), 'CREATE TABLE accounts (id integer PRIMARY KEY, email text);');
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Tester');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  fs.writeFileSync(
    path.join(root, 'db', 'V2__tighten.sql'),
    'ALTER TABLE accounts ALTER COLUMN email SET NOT NULL;\nALTER TABLE accounts ADD CONSTRAINT accounts_email_key UNIQUE (email);',
  );

  const report = await analyzePreflight({ repository: 'accounts', root, base: 'HEAD' });
  assert.equal(report.unavailable, undefined);
  assert.deepEqual(
    report.checks.map((entry) => entry.operation).sort(),
    ['add-unique', 'set-not-null'],
  );
  assert.equal(report.checks[0]?.file, 'db/V2__tighten.sql');

  const missing = await analyzePreflight({ repository: 'accounts', root, base: 'no-such-ref' });
  assert.match(missing.unavailable ?? '', /does not exist/);
  assert.deepEqual(missing.checks, []);
});
