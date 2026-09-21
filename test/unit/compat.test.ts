import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { analyzeCompat, diffContracts, diffSchemas, schemaTypeWidens } from '../../src/workspace/compat.ts';
import { assertRef, materializeRevision, RevisionError } from '../../src/workspace/revision.ts';
import { buildSchema } from '../../src/workspace/schema.ts';
import type { CodeDataUse, CompatChange, ContractDefinition } from '../../src/types.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-compat-'));
  created.push(directory);
  return directory;
}

function write(root: string, file: string, content: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
}

function contract(id: string, fields: ContractDefinition['fields'], repository = 'api'): ContractDefinition {
  return { id, format: 'json-schema', repository, source: 'schemas/x.json', fields };
}

function summarize(changes: CompatChange[]): string[] {
  return changes.map((entry) => `${entry.compatibility}: ${entry.id}${entry.name ? `.${entry.name}` : ''} ${entry.change}`);
}

test('contract diff classifies removals, type changes, required-ness, and additions', () => {
  const base = [
    contract('User', [
      { name: 'id', type: 'string', required: true },
      { name: 'age', type: 'integer(int32)', required: false },
      { name: 'legacy', type: 'string', required: false },
      { name: 'nick', type: 'string', required: false },
      { name: 'score', type: 'string', required: false },
    ]),
    contract('Gone', [{ name: 'x', type: 'string', required: true }]),
  ];
  const head = [
    contract('User', [
      { name: 'id', type: 'string', required: true },
      { name: 'age', type: 'integer(int64)', required: false },
      { name: 'nick', type: 'string', required: true },
      { name: 'score', type: 'integer', required: false },
      { name: 'email', type: 'string', required: true },
      { name: 'bio', type: 'string', required: false },
    ]),
    contract('Fresh', []),
  ];
  const others = [contract('User', [], 'web')];

  const changes = diffContracts(base, head, others, 'api');
  assert.deepEqual(summarize(changes).sort(), [
    'breaking: Gone removed',
    'breaking: User.legacy removed',
    'breaking: User.score type-changed',
    'conditional: User.age type-changed',
    'conditional: User.email added',
    'conditional: User.nick required-changed',
    'safe: Fresh added',
    'safe: User.bio added',
  ]);
  const removed = changes.find((entry) => entry.name === 'legacy');
  assert.deepEqual(removed?.consumers, ['web'], 'the other repository declaring User is named as a consumer');
  assert.match(changes.find((entry) => entry.name === 'nick')?.reason ?? '', /omit it now fail/);
});

test('schemaTypeWidens recognises widenings and rejects narrowings and conversions', () => {
  assert.equal(schemaTypeWidens('integer', 'bigint'), true);
  assert.equal(schemaTypeWidens('bigint', 'integer'), false);
  assert.equal(schemaTypeWidens('smallint', 'integer'), true);
  assert.equal(schemaTypeWidens('varchar(50)', 'varchar(255)'), true);
  assert.equal(schemaTypeWidens('varchar(255)', 'varchar(50)'), false);
  assert.equal(schemaTypeWidens('varchar(50)', 'text'), true);
  assert.equal(schemaTypeWidens('text', 'varchar(50)'), false);
  assert.equal(schemaTypeWidens('numeric(10,2)', 'numeric(12,2)'), true);
  assert.equal(schemaTypeWidens('numeric(10,2)', 'numeric(10,4)'), false);
  assert.equal(schemaTypeWidens('integer', 'text'), false);
  assert.equal(schemaTypeWidens('timestamp', 'timestamptz'), false);
  assert.equal(schemaTypeWidens('real', 'double'), true);
});

function schema(...files: Array<[string, string]>) {
  return buildSchema('db', files.map(([file, content]) => ({ path: file, content })));
}

test('schema diff judges each change by whether the running application keeps working', () => {
  const base = schema([
    'V1__a.sql',
    `CREATE TABLE users (
  id integer PRIMARY KEY,
  email varchar(50),
  name text,
  legacy text,
  role text NOT NULL DEFAULT 'member'
);
CREATE TABLE audit (id int);
CREATE INDEX idx_email ON users (email);`,
  ]);
  const head = schema([
    'V1__a.sql',
    `CREATE TABLE users (
  id bigint PRIMARY KEY,
  email varchar(255) NOT NULL UNIQUE,
  name text,
  role text NOT NULL,
  status text NOT NULL,
  note text
);
CREATE TABLE tenants (id int);
CREATE UNIQUE INDEX idx_name ON users (name);`,
  ]);

  const uses: CodeDataUse[] = [
    { repository: 'api', file: 'src/repo.ts', line: 10, table: 'users', columns: ['id', 'email', 'legacy'], evidence: 'string-literal SQL (INSERT)', confidence: 'strong' },
    { repository: 'api', file: 'src/repo.ts', line: 20, table: 'users', columns: ['email'], evidence: 'string-literal SQL (UPDATE)', confidence: 'strong' },
    { repository: 'api', file: 'src/audit.ts', line: 4, table: 'audit', columns: [], evidence: 'string-literal SQL (INSERT)', confidence: 'strong' },
  ];

  const changes = diffSchemas(base, head, uses);
  const lines = summarize(changes);
  for (const expected of [
    'breaking: audit removed',
    'breaking: users.legacy removed',
    'breaking: users.status added',
    'safe: users.note added',
    'safe: tenants added',
    'conditional: users.id type-changed',
    'conditional: users.email type-changed',
    'breaking: users.email nullability-changed',
    'conditional: users.role default-changed',
    'breaking: users.unique (email) added',
    'breaking: users.unique index idx_name (name) added',
    'conditional: users.index idx_email (email) removed',
  ]) {
    assert.ok(lines.includes(expected), `missing "${expected}" in\n${lines.join('\n')}`);
  }

  const table = changes.find((entry) => entry.id === 'audit');
  assert.deepEqual(table?.references, [{ repository: 'api', file: 'src/audit.ts', line: 4 }]);

  const legacy = changes.find((entry) => entry.name === 'legacy');
  assert.deepEqual(legacy?.references, [{ repository: 'api', file: 'src/repo.ts', line: 10 }]);

  const status = changes.find((entry) => entry.name === 'status');
  assert.deepEqual(
    status?.references,
    [{ repository: 'api', file: 'src/repo.ts', line: 10 }],
    'the INSERT that does not supply the new NOT NULL column is named',
  );

  const email = changes.find((entry) => entry.name === 'email' && entry.change === 'nullability-changed');
  assert.deepEqual(
    email?.references,
    [
      { repository: 'api', file: 'src/repo.ts', line: 10 },
      { repository: 'api', file: 'src/repo.ts', line: 20 },
    ],
    'writers of a column that became NOT NULL are named',
  );
  assert.ok(changes.every((entry) => entry.reason.length > 0));
});

test('a first schema is entirely additions and a deleted schema is entirely removals', () => {
  const head = schema(['V1__a.sql', 'CREATE TABLE t (id int);']);
  assert.deepEqual(summarize(diffSchemas(null, head)), ['safe: t added']);
  assert.deepEqual(summarize(diffSchemas(head, null)), ['breaking: t removed']);
  assert.deepEqual(diffSchemas(null, null), []);
});

test('assertRef refuses anything that could be read as an option or a range', () => {
  for (const good of ['HEAD', 'main', 'feature/x', 'v1.2.3', 'HEAD~2', 'abc123', 'origin/main', 'HEAD^']) {
    assert.equal(assertRef(good), good);
  }
  for (const bad of ['--output=x', '-x', 'a..b', 'a b', 'a;b', '', 'x`y']) {
    assert.throws(() => assertRef(bad), RevisionError, bad);
  }
});

function initRepo(): string {
  const root = tempDir();
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Tester');
  return root;
}

test('analyzeCompat compares a git revision with the working tree', async () => {
  const root = initRepo();
  write(root, 'db/V1__init.sql', 'CREATE TABLE orders (id int PRIMARY KEY, total numeric(10,2), note text);');
  write(
    root,
    'openapi.json',
    JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Orders', version: '1' },
      components: { schemas: { Order: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, total: { type: 'number' } } } } },
    }),
  );
  write(root, 'node_modules/pkg/ignored.sql', 'CREATE TABLE ignored (id int);');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');

  // Pending, uncommitted work: a dropped column, a required new column, a narrowed contract.
  write(root, 'db/V2__change.sql', 'ALTER TABLE orders DROP COLUMN note;\nALTER TABLE orders ADD COLUMN status text NOT NULL;');
  write(
    root,
    'openapi.json',
    JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Orders', version: '2' },
      components: { schemas: { Order: { type: 'object', required: ['id', 'total'], properties: { id: { type: 'string' } } } } },
    }),
  );

  const result = await analyzeCompat({ repository: 'orders', root, base: 'HEAD' });
  assert.equal(result.unavailable, undefined);
  assert.equal(result.head, 'working tree');
  assert.deepEqual(summarize(result.changes).sort(), [
    'breaking: Orders#Order.total removed',
    'breaking: orders.note removed',
    'breaking: orders.status added',
  ]);
  assert.deepEqual(result.summary, { breaking: 3, conditional: 0, safe: 0 });

  // Once committed, the same change is found between two revisions.
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'change');
  const between = await analyzeCompat({ repository: 'orders', root, base: 'HEAD~1', head: 'HEAD' });
  assert.deepEqual(summarize(between.changes).sort(), summarize(result.changes).sort());
  assert.equal(between.head, 'HEAD');

  // No change between a revision and itself.
  const same = await analyzeCompat({ repository: 'orders', root, base: 'HEAD', head: 'HEAD' });
  assert.deepEqual(same.changes, []);
  assert.equal(same.unavailable, undefined);
});

test('an unreadable revision is reported as unavailable, never as no changes', async () => {
  const root = initRepo();
  write(root, 'db/V1__init.sql', 'CREATE TABLE t (id int);');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');

  const missing = await analyzeCompat({ repository: 'r', root, base: 'no-such-branch' });
  assert.match(missing.unavailable ?? '', /does not exist/);
  assert.deepEqual(missing.changes, []);

  const invalid = await analyzeCompat({ repository: 'r', root, base: '--output=/tmp/x' });
  assert.match(invalid.unavailable ?? '', /not a usable revision/);

  const plain = tempDir();
  const notGit = await analyzeCompat({ repository: 'r', root: plain, base: 'HEAD' });
  assert.ok(notGit.unavailable);
});

test('materializeRevision writes only the readable files of a revision', async () => {
  const root = initRepo();
  write(root, 'db/V1__init.sql', 'CREATE TABLE t (id int);');
  write(root, 'src/app.ts', 'export interface A { id: string }\n');
  write(root, 'README.md', '# not needed');
  write(root, 'node_modules/x/y.ts', 'export {}');
  git(root, 'add', '-f', '.');
  git(root, 'commit', '-q', '-m', 'base');

  const revision = await materializeRevision(root, 'HEAD');
  try {
    assert.equal(revision.files, 2);
    assert.ok(fs.existsSync(path.join(revision.root, 'db', 'V1__init.sql')));
    assert.ok(fs.existsSync(path.join(revision.root, 'src', 'app.ts')));
    assert.ok(!fs.existsSync(path.join(revision.root, 'README.md')));
    assert.ok(!fs.existsSync(path.join(revision.root, 'node_modules')));
  } finally {
    revision.cleanup();
  }
  assert.ok(!fs.existsSync(revision.root));
});
