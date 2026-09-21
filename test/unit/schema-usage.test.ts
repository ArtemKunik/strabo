import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractDataUsesFromSource } from '../../src/workspace/data-usage.ts';
import { buildSchema } from '../../src/workspace/schema.ts';
import { computeSchemaDrift, computeSchemaUsage } from '../../src/workspace/schema-usage.ts';
import type { CodeDataUse, SchemaSnapshot } from '../../src/types.ts';

function summarize(file: string, content: string): Array<[string, string[], string, number]> {
  return extractDataUsesFromSource(file, content).map((use) => [use.table, use.columns, use.confidence, use.line]);
}

test('string-literal INSERT and UPDATE record the table and the columns they name', () => {
  const source = [
    'const a = "INSERT INTO public.Orders (id, customer_id, total) VALUES ($1, $2, $3)";',
    "const b = `UPDATE orders SET status = $1, updated_at = now() WHERE id = $2`;",
    "const c = 'DELETE FROM sessions WHERE expires < now()';",
  ].join('\n');
  assert.deepEqual(summarize('src/db.ts', source), [
    ['orders', ['id', 'customer_id', 'total'], 'strong', 1],
    ['orders', ['status', 'updated_at'], 'strong', 2],
    ['sessions', [], 'strong', 3],
  ]);
});

test('SELECT attributes columns only when one table is in play', () => {
  const single = 'q = "SELECT id, u.email, name AS n, count(*) FROM users u WHERE id = 1"';
  assert.deepEqual(summarize('a.py', single), [['users', ['id', 'email', 'name'], 'weak', 1]]);

  const joined = 'q = "SELECT u.id, o.total FROM users u JOIN orders o ON o.user_id = u.id"';
  assert.deepEqual(
    summarize('a.py', joined).map(([table, columns]) => [table, columns]),
    [
      ['orders', []],
      ['users', []],
    ],
    'a join names both tables but attributes no columns to either',
  );

  const star = 'q = "SELECT * FROM users"';
  assert.deepEqual(summarize('a.py', star), [['users', [], 'weak', 1]]);
});

test('multi-line literals report the line of the statement, and CTEs are not tables', () => {
  const source = [
    'let query = `',
    '  WITH recent AS (SELECT id FROM events)',
    '  SELECT id FROM recent',
    '`;',
  ].join('\n');
  assert.deepEqual(summarize('q.ts', source), [['events', ['id'], 'weak', 2]]);
});

test('prose, interpolation, catalogs, and system tables record nothing', () => {
  assert.deepEqual(summarize('a.ts', "const hint = 'Select an item from the list';"), []);
  assert.deepEqual(summarize('a.ts', 'const q = `SELECT id FROM ${table} WHERE 1`;'), []);
  assert.deepEqual(summarize('a.ts', "const q = 'SELECT * FROM information_schema.tables';"), []);
  assert.deepEqual(summarize('a.ts', "const q = 'SELECT version FROM schema_migrations';"), []);
  // SQL in a comment is not a literal.
  assert.deepEqual(summarize('a.ts', '// SELECT id FROM users\nconst x = 1;'), []);
});

test('JPA, TypeORM, SQLAlchemy, Diesel and SeaORM mappings name their columns', () => {
  const jpa = `@Entity
@Table(name = "accounts")
public class Account {
  @Id private Long id;
  @Column(name = "display_name") private String displayName;
  @Column(name = "email", nullable = false) private String email;
}`;
  assert.deepEqual(summarize('Account.java', jpa), [['accounts', ['display_name', 'email'], 'strong', 2]]);

  const typeorm = `@Entity('people')
export class Person {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'full_name' }) fullName: string;
  @Column() email: string;
}`;
  assert.deepEqual(summarize('person.ts', typeorm), [['people', ['id', 'full_name', 'email'], 'strong', 1]]);

  const alchemy = `class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255))
    display = Column("display_name", String)

class Other(Base):
    __tablename__ = 'others'
    name = Column(String)
`;
  assert.deepEqual(summarize('models.py', alchemy), [
    ['users', ['id', 'email', 'display_name'], 'strong', 2],
    ['others', ['name'], 'strong', 8],
  ]);

  const diesel = `diesel::table! {
    invoices (id) {
        id -> Int4,
        total -> Numeric,
    }
}`;
  assert.deepEqual(summarize('schema.rs', diesel), [['invoices', ['id', 'total'], 'strong', 1]]);

  const sea = `#[derive(DeriveEntityModel)]
#[sea_orm(table_name = "cakes")]
pub struct Model {
    pub id: i32,
    pub name: String,
}`;
  assert.deepEqual(summarize('cake.rs', sea), [['cakes', ['id', 'name'], 'strong', 2]]);
});

function snapshot(repository: string, sql: string): SchemaSnapshot {
  const result = buildSchema(repository, [{ path: 'V1__init.sql', content: sql }]);
  assert.ok(result);
  return result;
}

function use(repository: string, table: string, columns: string[], overrides: Partial<CodeDataUse> = {}): CodeDataUse {
  return {
    repository,
    file: `${repository}/src/db.ts`,
    line: 3,
    table,
    columns,
    evidence: 'string-literal SQL (INSERT)',
    confidence: 'strong',
    ...overrides,
  };
}

test('code is checked against every schema in the workspace, not only its own repository', () => {
  const schemas = [snapshot('db', 'CREATE TABLE orders (id int, total numeric(10,2));')];
  const report = computeSchemaUsage(schemas, [
    use('api', 'orders', ['id', 'total']),
    use('api', 'orders', ['id', 'discount']),
    use('api', 'invoices', ['id']),
  ]);

  assert.equal(report.checked, true);
  assert.deepEqual(
    report.findings.map((finding) => [finding.kind, finding.table, finding.column ?? null, finding.definedIn ?? null]),
    [
      ['unknown-table', 'invoices', null, null],
      ['unknown-column', 'orders', 'discount', ['db']],
    ],
  );
});

test('nothing is judged when no schema is declared', () => {
  const report = computeSchemaUsage([], [use('api', 'orders', ['id'])]);
  assert.equal(report.checked, false);
  assert.deepEqual(report.findings, []);
  assert.equal(report.uses.length, 1);
});

test('schema drift compares a table two repositories both declare', () => {
  const drift = computeSchemaDrift([
    snapshot('a', 'CREATE TABLE users (id int NOT NULL, email text, age int);'),
    snapshot('b', 'CREATE TABLE users (id bigint NOT NULL, email text NOT NULL, nick text);'),
    snapshot('c', 'CREATE TABLE only_c (id int);'),
  ]);
  assert.equal(drift.length, 1);
  const users = drift[0];
  assert.ok(users);
  assert.equal(users.table, 'users');
  assert.deepEqual(users.repositories, ['a', 'b']);
  assert.deepEqual(
    users.deviations.map((entry) => [entry.column, entry.issue]),
    [
      ['age', 'missing'],
      ['email', 'nullable'],
      ['id', 'type'],
      ['nick', 'missing'],
    ],
  );
});
