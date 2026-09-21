import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { buildSchema, extractSchema, normalizeType } from '../../src/workspace/schema.ts';
import type { SchemaSnapshot, SchemaTable } from '../../src/types.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function snapshot(...sources: Array<[string, string]>): SchemaSnapshot {
  const result = buildSchema(
    'repo',
    sources.map(([file, content]) => ({ path: file, content })),
  );
  assert.ok(result, 'expected a schema');
  return result;
}

function table(schema: SchemaSnapshot, name: string): SchemaTable {
  const found = schema.tables.find((entry) => entry.name === name);
  assert.ok(found, `expected table ${name}`);
  return found;
}

test('normalizeType gives one spelling per type', () => {
  assert.equal(normalizeType('INT'), 'integer');
  assert.equal(normalizeType('int(11)'), 'integer');
  assert.equal(normalizeType('BIGINT UNSIGNED'), 'bigint unsigned');
  assert.equal(normalizeType('character varying(255)'), 'varchar(255)');
  assert.equal(normalizeType('VARCHAR( 50 )'), 'varchar(50)');
  assert.equal(normalizeType('numeric(10, 2)'), 'numeric(10,2)');
  assert.equal(normalizeType('decimal(10,2)'), 'numeric(10,2)');
  assert.equal(normalizeType('timestamp with time zone'), 'timestamptz');
  assert.equal(normalizeType('timestamp without time zone'), 'timestamp');
  assert.equal(normalizeType('double precision'), 'double');
  assert.equal(normalizeType('text []'), 'text[]');
  assert.equal(normalizeType(''), 'unknown');
});

test('CREATE TABLE records columns, nullability, defaults, and inline constraints', () => {
  const schema = snapshot([
    'db/schema.sql',
    `-- users
CREATE TABLE IF NOT EXISTS public."Users" (
  id BIGSERIAL PRIMARY KEY,
  email character varying(255) NOT NULL UNIQUE,
  name text,
  role text NOT NULL DEFAULT 'member',
  age integer CHECK (age >= 0),
  org_id integer REFERENCES orgs (id) ON DELETE CASCADE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  score numeric(10, 2) DEFAULT NULL
);`,
  ]);

  const users = table(schema, 'users');
  assert.deepEqual(
    users.columns.map((column) => [column.name, column.type, column.nullable, column.default ?? null]),
    [
      ['id', 'bigint', false, 'serial'],
      ['email', 'varchar(255)', false, null],
      ['name', 'text', true, null],
      ['role', 'text', false, "'member'"],
      ['age', 'integer', true, null],
      ['org_id', 'integer', true, null],
      ['created_at', 'timestamptz', false, 'now()'],
      ['score', 'numeric(10,2)', true, 'NULL'],
    ],
  );
  assert.deepEqual(
    users.constraints.map((entry) => [entry.kind, entry.columns.join(',')]),
    [
      ['primary-key', 'id'],
      ['unique', 'email'],
      ['check', 'age'],
      ['foreign-key', 'org_id'],
    ],
  );
  const foreignKey = users.constraints.find((entry) => entry.kind === 'foreign-key');
  assert.deepEqual(foreignKey?.references, { table: 'orgs', columns: ['id'], onDelete: 'cascade' });
  assert.equal(users.constraints.find((entry) => entry.kind === 'check')?.expression, 'age >= 0');
  assert.equal(users.declared.line, 2);
  assert.equal(schema.origin, 'dump');
});

test('table-level constraints and MySQL keys are read', () => {
  const schema = snapshot([
    'V1__init.sql',
    `CREATE TABLE line_items (
  order_id INT NOT NULL,
  sku VARCHAR(40) NOT NULL,
  qty INT UNSIGNED NOT NULL DEFAULT 1,
  note TEXT,
  CONSTRAINT pk_line PRIMARY KEY (order_id, sku),
  CONSTRAINT fk_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE SET NULL,
  UNIQUE KEY uq_note (note(20)),
  KEY idx_sku (sku),
  CONSTRAINT qty_pos CHECK (qty > 0)
) ENGINE=InnoDB;`,
  ]);
  const items = table(schema, 'line_items');
  assert.equal(items.columns.find((column) => column.name === 'qty')?.type, 'integer unsigned');
  assert.deepEqual(
    items.constraints.map((entry) => [entry.kind, entry.name ?? null, entry.columns.join(',')]),
    [
      ['primary-key', 'pk_line', 'order_id,sku'],
      ['foreign-key', 'fk_order', 'order_id'],
      ['unique', 'uq_note', 'note'],
      ['check', 'qty_pos', ''],
    ],
  );
  assert.equal(items.constraints[1]?.references?.onDelete, 'set null');
  assert.deepEqual(items.indexes.map((entry) => [entry.name, entry.columns]), [['idx_sku', ['sku']]]);
  assert.equal(schema.origin, 'migrations');
});

test('migrations replay in natural order and ALTER TABLE changes the schema', () => {
  const schema = snapshot(
    ['db/V10__later.sql', 'ALTER TABLE accounts DROP COLUMN legacy;'],
    [
      'db/V2__more.sql',
      `ALTER TABLE accounts
  ADD COLUMN email text NOT NULL DEFAULT '',
  ADD COLUMN legacy text,
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN name TYPE varchar(100),
  ADD CONSTRAINT accounts_email_key UNIQUE (email);
CREATE UNIQUE INDEX CONCURRENTLY idx_name ON accounts (lower(name)) WHERE name <> '';`,
    ],
    ['db/V1__init.sql', 'CREATE TABLE accounts (id int PRIMARY KEY, name text);'],
  );
  const accounts = table(schema, 'accounts');
  assert.deepEqual(
    schema.files,
    ['db/V1__init.sql', 'db/V2__more.sql', 'db/V10__later.sql'],
    'V2 replays before V10',
  );
  assert.deepEqual(
    accounts.columns.map((column) => [column.name, column.type, column.nullable]),
    [
      ['id', 'integer', false],
      ['name', 'varchar(100)', false],
      ['email', 'text', false],
    ],
    'legacy was added and dropped',
  );
  assert.ok(accounts.constraints.some((entry) => entry.kind === 'unique' && entry.name === 'accounts_email_key'));
  assert.deepEqual(accounts.indexes.map((entry) => [entry.name, entry.columns, entry.unique, entry.where]), [
    ['idx_name', ['lower(name)'], true, "name <> ''"],
  ]);
  assert.equal(schema.gaps.length, 0);
});

test('renames carry through constraints and referencing foreign keys', () => {
  const schema = snapshot([
    'V1__a.sql',
    `CREATE TABLE parent (id int PRIMARY KEY, label text);
CREATE TABLE child (id int PRIMARY KEY, parent_id int REFERENCES parent (id));
ALTER TABLE parent RENAME COLUMN id TO parent_key;
ALTER TABLE parent RENAME TO owner;
ALTER TABLE child MODIFY parent_id BIGINT NOT NULL;`,
  ]);
  assert.equal(schema.tables.find((entry) => entry.name === 'parent'), undefined);
  const owner = table(schema, 'owner');
  assert.deepEqual(owner.constraints[0]?.columns, ['parent_key']);
  const child = table(schema, 'child');
  assert.deepEqual(child.constraints.find((entry) => entry.kind === 'foreign-key')?.references, {
    table: 'owner',
    columns: ['parent_key'],
  });
  const parentId = child.columns.find((column) => column.name === 'parent_id');
  assert.equal(parentId?.type, 'bigint');
  assert.equal(parentId?.nullable, false);
});

test('DROP TABLE, undo scripts, comments, strings, and dollar quoting', () => {
  const schema = snapshot(
    [
      'V1__a.sql',
      `/* header; with a semicolon */
CREATE TABLE gone (id int);
CREATE TABLE kept (id int, note text DEFAULT 'a;b'); -- trailing; comment
CREATE FUNCTION f() RETURNS void AS $$ BEGIN DROP TABLE kept; END; $$ LANGUAGE plpgsql;
DROP TABLE IF EXISTS gone;
INSERT INTO kept VALUES (1, 'x');`,
    ],
    ['V1__a.down.sql', 'DROP TABLE kept;'],
    ['U2__undo.sql', 'DROP TABLE kept;'],
    ['db/down/0002.sql', 'DROP TABLE kept;'],
  );
  assert.deepEqual(schema.tables.map((entry) => entry.name), ['kept']);
  assert.equal(table(schema, 'kept').columns[1]?.default, "'a;b'");
  assert.deepEqual(schema.files, ['V1__a.sql']);
});

test('temporary tables are ignored and unreadable statements are named as gaps', () => {
  const schema = snapshot([
    'V1__a.sql',
    `CREATE TEMP TABLE scratch (x int);
CREATE TABLE real_one (id int);
CREATE TABLE snap AS SELECT * FROM real_one;
ALTER TABLE missing ADD COLUMN y int;
ALTER TABLE real_one ADD EXCLUDE USING gist (id WITH =);
CREATE INDEX i ON nowhere (a);`,
  ]);
  assert.deepEqual(schema.tables.map((entry) => entry.name), ['real_one', 'snap']);
  const reasons = schema.gaps.map((entry) => entry.reason).join(' | ');
  assert.match(reasons, /query/);
  assert.match(reasons, /missing is not created/);
  assert.match(reasons, /nowhere/);
  assert.equal(schema.gaps.length >= 4, true);
  assert.ok(schema.gaps.every((entry) => entry.file === 'V1__a.sql' && entry.line >= 1));
});

test('IDENTITY, generated and SQL Server forms', () => {
  const schema = snapshot([
    'V1__a.sql',
    `CREATE TABLE dbo.[Order Lines] (
  id INT IDENTITY(1,1) PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  total AS (id * 2),
  label nvarchar(40) NOT NULL
)
GO
CREATE TABLE b (x int GENERATED BY DEFAULT AS IDENTITY, y int GENERATED ALWAYS AS (x + 1) STORED);`,
  ]);
  const lines = table(schema, 'order lines');
  assert.deepEqual(
    lines.columns.map((column) => [column.name, column.type, column.nullable, column.default ?? null]),
    [
      ['id', 'integer', false, 'auto-increment'],
      ['seq', 'bigint', false, 'identity'],
      ['total', 'unknown', true, 'generated'],
      ['label', 'varchar(40)', false, null],
    ],
  );
  const b = table(schema, 'b');
  assert.deepEqual(b.columns.map((column) => [column.name, column.nullable, column.default]), [
    ['x', false, 'identity'],
    ['y', true, 'generated'],
  ]);
});

test('a repository with no CREATE TABLE has no schema', () => {
  assert.equal(buildSchema('repo', [{ path: 'seed.sql', content: "INSERT INTO t VALUES (1);" }]), null);
  assert.equal(buildSchema('repo', []), null);
});

test('extractSchema reads .sql files from disk and prunes generated directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-schema-'));
  created.push(root);
  const write = (file: string, content: string): void => {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  };
  write('migrations/001_init.sql', 'CREATE TABLE users (id int PRIMARY KEY);');
  write('migrations/002_email.sql', 'ALTER TABLE users ADD COLUMN email text;');
  write('node_modules/pkg/vendored.sql', 'CREATE TABLE vendored (id int);');

  const schema = extractSchema(root, 'app');
  assert.ok(schema);
  assert.equal(schema.repository, 'app');
  assert.deepEqual(schema.files, ['migrations/001_init.sql', 'migrations/002_email.sql']);
  assert.deepEqual(schema.tables.map((entry) => entry.name), ['users']);
  assert.equal(extractSchema(fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-empty-')), 'none'), null);
});
