import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { openWorkspaceCache, WORKSPACE_CACHE_VERSION, type CachedRepoFacts } from '../../src/cache/workspace-cache.ts';
import { extractDataUses, extractDataUsesFromSource, ormMethodAccess } from '../../src/workspace/data-usage.ts';
import type { CodeDataUse } from '../../src/types.ts';

function accesses(file: string, content: string): Array<[string, string]> {
  return extractDataUsesFromSource(file, content).map((use) => [use.table, use.access]);
}

test('string-literal SQL is classified by statement shape', () => {
  const source = [
    'const r = "SELECT id FROM users";',
    'const j = "SELECT u.id FROM users u JOIN orders o ON o.id = u.id";',
    'const i = "INSERT INTO orders (id) VALUES ($1)";',
    'const u = "UPDATE orders SET status = $1 WHERE id = $2";',
    'const d = "DELETE FROM sessions WHERE id = $1";',
    'const m = "MERGE INTO orders USING staging ON orders.id = staging.id";',
    'const p = "UPSERT INTO orders (id) VALUES ($1)";',
    'const c = "CREATE TABLE audit_log (id int)";',
    'const a = "ALTER TABLE orders ADD COLUMN note text";',
    'const t = "TRUNCATE TABLE sessions";',
    'const g = "GRANT SELECT ON orders TO analyst";',
  ].join('\n');

  assert.deepEqual(accesses('src/db.ts', source), [
    ['users', 'read'],
    ['orders', 'read'],
    ['users', 'read'],
    ['orders', 'write'],
    ['orders', 'write'],
    ['sessions', 'write'],
    ['orders', 'write'],
    ['orders', 'write'],
    ['audit_log', 'ddl'],
    ['orders', 'ddl'],
    ['sessions', 'ddl'],
    ['orders', 'ddl'],
  ]);
});

test('the ORM rule table is data: a named method is a write, anything else unknown', () => {
  assert.equal(ormMethodAccess('javascript', 'create'), 'write');
  assert.equal(ormMethodAccess('javascript', 'deleteMany'), 'write');
  assert.equal(ormMethodAccess('java', 'save'), 'write');
  assert.equal(ormMethodAccess('kotlin', 'upsert'), 'write');
  assert.equal(ormMethodAccess('rust', 'insert_into'), 'write');
  assert.equal(ormMethodAccess('javascript', 'findMany'), 'unknown');
  assert.equal(ormMethodAccess('java', 'findById'), 'unknown');
  assert.equal(ormMethodAccess('python', 'query'), 'unknown');
});

test('a Prisma client call names the model and its rule-table direction', () => {
  const source = [
    'await prisma.user.create({ data: {} });',
    'await prisma.user.update({ where: {}, data: {} });',
    'await prisma.user.findMany();',
  ].join('\n');

  assert.deepEqual(accesses('src/db.ts', source), [
    ['user', 'write'],
    ['user', 'write'],
    ['user', 'unknown'],
  ]);
});

test('an ORM mapping stays unknown unless a rule method is recorded in its scope', () => {
  const withSave = `@Entity('people')
export class Person {
  @Column() email: string;
  save() { return this; }
}`;
  assert.deepEqual(accesses('person.ts', withSave), [['people', 'write']]);

  const withoutSave = `@Entity('people')
export class Person {
  @Column() email: string;
}`;
  assert.deepEqual(accesses('person.ts', withoutSave), [['people', 'unknown']]);
});

test('a Room-style annotation in a Kotlin mapping records a write', () => {
  const source = `@Table(name = "accounts")
class AccountDao {
  @Insert
  fun insert(account: Account)
}`;
  assert.deepEqual(accesses('AccountDao.kt', source), [['accounts', 'write']]);
});

test('extractDataUses attributes the direction to the repository', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-data-access-scan-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'db.ts'), 'const q = "DELETE FROM sessions WHERE id = $1";\n');
    const uses = extractDataUses(root, 'api');
    assert.deepEqual(
      uses.map((use) => [use.repository, use.table, use.access]),
      [['api', 'sessions', 'write']],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

function facts(uses: CodeDataUse[]): CachedRepoFacts {
  return { publishes: null, contracts: [], endpoints: [], calls: [], schema: null, dataUses: uses };
}

test('the workspace cache round-trips access and reads an old record as unknown', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-data-access-cache-'));
  const file = path.join(directory, 'workspace.json');
  const root = path.join(directory, 'repo');
  try {
    fs.mkdirSync(root);
    const use: CodeDataUse = {
      repository: 'api',
      file: 'src/db.ts',
      line: 1,
      table: 'users',
      columns: [],
      evidence: 'string-literal SQL (SELECT)',
      confidence: 'weak',
      access: 'read',
    };

    const cache = openWorkspaceCache({ file });
    cache.set(root, 'fp', facts([use]));
    cache.save();
    assert.deepEqual(openWorkspaceCache({ file }).get(root, 'fp')?.dataUses, [use]);

    // A record persisted before `access` existed has no direction; it must not be invented.
    const legacy = {
      version: WORKSPACE_CACHE_VERSION,
      entries: {
        [path.resolve(root)]: {
          fingerprint: 'fp',
          publishes: null,
          contracts: [],
          endpoints: [],
          calls: [],
          schema: null,
          dataUses: [
            {
              repository: 'api',
              file: 'src/db.ts',
              line: 1,
              table: 'users',
              columns: [],
              evidence: 'string-literal SQL (SELECT)',
              confidence: 'weak',
            },
          ],
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(legacy));
    assert.equal(openWorkspaceCache({ file }).get(root, 'fp')?.dataUses[0]?.access, 'unknown');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
