import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { computeFileHealth } from '../../src/index.ts';
import { buildMemberMap } from '../../src/index.ts';
import { symbolExtractorFor } from '../../src/index.ts';
import { extractSqlFacts, extractSqlSymbols, resolveSql } from '../../src/index.ts';
import type { SqlFileFacts } from '../../src/scan/languages/sql.ts';
import { scanRepository } from '../../src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'sql-repo');

function facts(file: string, parts: Partial<SqlFileFacts> = {}): SqlFileFacts {
  return { file, definitions: [], references: [], includes: [], ...parts };
}

function define(name: string, kind: 'table' | 'view' = 'table') {
  return { name, kind, line: 1 };
}

function reference(name: string, line = 1) {
  return { name, line };
}

function pairs(edges: Array<{ source: string; target: string; kind: string }>): string[] {
  return edges.map((edge) => `${edge.source}->${edge.target} (${edge.kind})`).sort();
}

test('extractSqlFacts reads definitions from tables, views, and materialised views', async () => {
  const { facts: result, diagnostics } = await extractSqlFacts(
    'a.sql',
    [
      'CREATE TABLE IF NOT EXISTS public.users (id INT);',
      'CREATE VIEW v_orders AS SELECT 1;',
      'CREATE MATERIALIZED VIEW mv AS SELECT 1;',
    ].join('\n'),
  );

  assert.deepEqual(result.definitions, [
    { name: 'public.users', kind: 'table', line: 1 },
    { name: 'v_orders', kind: 'view', line: 2 },
    { name: 'mv', kind: 'materialized-view', line: 3 },
  ]);
  assert.equal(diagnostics.length, 0);
});

test('extractSqlFacts finds every way a statement uses a relation', async () => {
  const source = [
    'CREATE TABLE a (id INT, b_id INT REFERENCES b(id), FOREIGN KEY (id) REFERENCES public.c(id));',
    'SELECT * FROM d JOIN e ON e.id = d.id WHERE d.x IN (SELECT id FROM f);',
    'UPDATE g SET x = 1;',
    'DELETE FROM h WHERE id = 1;',
    'INSERT INTO i (x) SELECT x FROM j;',
    'ALTER TABLE k ADD CONSTRAINT fk FOREIGN KEY (id) REFERENCES l(id);',
    'CREATE INDEX idx ON m (id);',
    'CREATE TRIGGER trg AFTER INSERT ON n FOR EACH ROW EXECUTE FUNCTION fn();',
  ].join('\n');

  const { facts: result } = await extractSqlFacts('a.sql', source);

  assert.deepEqual(
    result.references.map((entry) => entry.name).sort(),
    ['b', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'public.c'],
  );
});

test('column qualifiers, aliases, and function names are not relation references', async () => {
  const { facts: result } = await extractSqlFacts(
    'a.sql',
    'SELECT o.id, my_func(o.total) FROM orders o JOIN users u ON u.id = o.user_id;',
  );

  assert.deepEqual(result.references.map((entry) => entry.name).sort(), ['orders', 'users']);
});

test('a CTE name is query-local, not a reference to a table of the same name', async () => {
  const { facts: result } = await extractSqlFacts(
    'a.sql',
    'WITH recent AS (SELECT * FROM orders) SELECT * FROM recent r JOIN users u ON u.id = r.id;',
  );

  assert.deepEqual(result.references.map((entry) => entry.name).sort(), ['orders', 'users']);
});

test('temporary tables define nothing', async () => {
  const { facts: result } = await extractSqlFacts(
    'a.sql',
    'CREATE TEMP TABLE scratch (id INT);\nCREATE TEMPORARY TABLE scratch2 (id INT);\nCREATE TABLE real_one (id INT);',
  );

  assert.deepEqual(result.definitions.map((entry) => entry.name), ['real_one']);
});

test('quoted identifiers are unquoted, lower-cased, and drop a database prefix', async () => {
  const { facts: result } = await extractSqlFacts(
    'a.sql',
    'CREATE TABLE "Sales"."Orders" (id INT);\nSELECT * FROM `shop`.`Items`;\nSELECT * FROM db.dbo.Users;',
  );

  assert.deepEqual(result.definitions.map((entry) => entry.name), ['sales.orders']);
  assert.deepEqual(result.references.map((entry) => entry.name).sort(), ['dbo.users', 'shop.items']);
});

test('include directives are read, masked from the parser, and keep line numbers', async () => {
  const source = [
    '\\i schema/one.sql',
    "\\ir 'schema/two.sql'",
    ':r three.sql',
    'source four.sql;',
    '@five.sql',
    '\\set ON_ERROR_STOP on',
    'CREATE TABLE after_directives (id INT);',
  ].join('\n');

  const { facts: result, diagnostics } = await extractSqlFacts('a.sql', source);

  assert.deepEqual(result.includes, [
    { path: 'schema/one.sql', line: 1 },
    { path: 'schema/two.sql', line: 2 },
    { path: 'three.sql', line: 3 },
    { path: 'four.sql', line: 4 },
    { path: 'five.sql', line: 5 },
  ]);
  assert.deepEqual(result.definitions, [{ name: 'after_directives', kind: 'table', line: 7 }]);
  assert.equal(diagnostics.length, 0, 'masked directives must not surface as parse errors');
});

test('lines that only look like include directives stay SQL', async () => {
  const source = [
    'SELECT',
    '  source AS origin,',
    '  id',
    'FROM events;',
    '/*',
    '\\i commented_out.sql',
    '*/',
    '-- \\i also_commented.sql',
    'GO',
  ].join('\n');

  const { facts: result } = await extractSqlFacts('a.sql', source);

  assert.deepEqual(result.includes, []);
  assert.deepEqual(result.references.map((entry) => entry.name), ['events']);
});

test('unparseable dialect syntax is a warning, and surrounding statements still yield facts', async () => {
  const { facts: result, diagnostics } = await extractSqlFacts(
    'a.sql',
    'CREATE TABLE ok (id INT);\nGRANT SELECT ON ok TO bob;\nSELECT * FROM fine;',
  );

  assert.deepEqual(result.definitions.map((entry) => entry.name), ['ok']);
  assert.ok(result.references.some((entry) => entry.name === 'fine'));
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.kind, 'parse-failure');
  assert.equal(diagnostics[0]?.severity, 'warning');
});

test('resolveSql links a using file to the file that defines the relation', () => {
  const { edges, diagnostics } = resolveSql([
    facts('users.sql', { definitions: [define('users')] }),
    facts('orders.sql', { definitions: [define('orders')], references: [reference('users', 3)] }),
    facts('report.sql', { references: [reference('orders'), reference('external_table')] }),
  ]);

  assert.deepEqual(pairs(edges), ['orders.sql->users.sql (table)', 'report.sql->orders.sql (table)']);
  assert.deepEqual(
    edges.find((edge) => edge.source === 'orders.sql')?.evidence,
    { line: 3, specifier: 'users', resolution: 'exact' },
  );
  assert.equal(diagnostics.length, 0, 'an undefined relation is external, not unresolved');
});

test('resolveSql emits one edge per file pair even when several relations connect them', () => {
  const { edges } = resolveSql([
    facts('schema.sql', { definitions: [define('a'), define('b')] }),
    facts('use.sql', { references: [reference('a', 1), reference('b', 2)] }),
  ]);

  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.evidence.specifier, 'a');
});

test('resolveSql matches schemas the way a search path would', () => {
  const { edges, diagnostics } = resolveSql([
    facts('bare.sql', { definitions: [define('users')] }),
    facts('sales.sql', { definitions: [define('sales.orders')] }),
    facts('app.sql', {
      references: [reference('public.users'), reference('orders'), reference('other.orders')],
    }),
  ]);

  assert.deepEqual(pairs(edges), ['app.sql->bare.sql (table)', 'app.sql->sales.sql (table)']);
  assert.equal(diagnostics.length, 0);
});

test('an exact schema match beats a schema-less definition', () => {
  const { edges, diagnostics } = resolveSql([
    facts('loose.sql', { definitions: [define('orders')] }),
    facts('sales.sql', { definitions: [define('sales.orders')] }),
    facts('app.sql', { references: [reference('sales.orders')] }),
  ]);

  assert.deepEqual(pairs(edges), ['app.sql->sales.sql (table)']);
  assert.equal(diagnostics.length, 0);
});

test('a relation defined by several files is ambiguous and gets no edge', () => {
  const { edges, diagnostics } = resolveSql([
    facts('a.sql', { definitions: [define('audit_log')] }),
    facts('b.sql', { definitions: [define('audit_log')] }),
    facts('use.sql', { references: [reference('audit_log', 4)] }),
  ]);

  assert.deepEqual(edges, []);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.kind, 'ambiguous');
  assert.equal(diagnostics[0]?.specifier, 'audit_log');
  assert.equal(diagnostics[0]?.line, 4);
});

test('a file that defines a relation itself never links away for it', () => {
  const { edges, diagnostics } = resolveSql([
    facts('a.sql', { definitions: [define('t')], references: [reference('t')] }),
    facts('b.sql', { definitions: [define('t')] }),
  ]);

  assert.deepEqual(edges, []);
  assert.equal(diagnostics.length, 0);
});

test('includes resolve beside the including file, then from the repository root', () => {
  const { edges, diagnostics } = resolveSql([
    facts('db/seed.sql', {
      includes: [
        { path: 'schema/one.sql', line: 1 },
        { path: 'db/schema/two.sql', line: 2 },
        { path: 'missing.sql', line: 4 },
        { path: '/etc/absolute.sql', line: 5 },
        { path: '../../outside.sql', line: 6 },
      ],
    }),
    facts('db/schema/one.sql'),
    facts('db/schema/two.sql'),
  ]);

  assert.deepEqual(pairs(edges), [
    'db/seed.sql->db/schema/one.sql (import)',
    'db/seed.sql->db/schema/two.sql (import)',
  ]);
  assert.deepEqual(edges.map((edge) => edge.evidence.resolution), ['exact', 'root']);
  assert.deepEqual(
    diagnostics.map((entry) => [entry.kind, entry.specifier]),
    [
      ['unresolved', 'missing.sql'],
      ['unresolved', '/etc/absolute.sql'],
      ['unresolved', '../../outside.sql'],
    ],
  );
});

test('scanning a repository derives table and include edges from SQL files', async () => {
  const report = await scanRepository(fixture);

  assert.deepEqual(pairs(report.graph.edges), [
    'db/order_totals.sql->db/schema/001_users.sql (table)',
    'db/order_totals.sql->db/schema/002_orders.sql (table)',
    'db/schema/002_orders.sql->db/schema/001_users.sql (table)',
    'db/schema/003_indexes.sql->db/schema/002_orders.sql (table)',
    'db/seed.sql->db/schema/001_users.sql (import)',
    // seed.sql also runs INSERT INTO users, a separate fact from including the file.
    'db/seed.sql->db/schema/001_users.sql (table)',
    'db/seed.sql->db/schema/002_orders.sql (import)',
  ]);
  assert.ok(
    !report.graph.edges.some((edge) => edge.target.endsWith('004_recent.sql')),
    'a CTE named like a table must not link to it',
  );
  assert.ok(
    !report.graph.diagnostics.some((entry) => entry.kind === 'unsupported' && entry.file.endsWith('.sql')),
    'SQL is a supported language',
  );
  assert.equal(report.parseFailures, 0);
});

test('scan diagnostics name unresolved includes and ambiguous relations, not external tables', async () => {
  const report = await scanRepository(fixture);
  const found = report.graph.diagnostics.map((entry) => [entry.file, entry.kind, entry.specifier]);

  assert.deepEqual(found.sort(), [
    ['db/audit_report.sql', 'ambiguous', 'audit_log'],
    ['db/seed.sql', 'unresolved', 'missing/nope.sql'],
  ]);
});

test('SQL edges are deterministic across scans', async () => {
  const first = await scanRepository(fixture);
  const second = await scanRepository(fixture);
  assert.deepEqual(pairs(first.graph.edges), pairs(second.graph.edges));
});

test('extractSqlSymbols records a table as a type and each column as a field it owns', async () => {
  const source = [
    'CREATE TABLE public.orders (',
    '  id INT PRIMARY KEY,',
    '  total DECIMAL(10, 2) NOT NULL DEFAULT 0,',
    '  code VARCHAR(20) UNIQUE,',
    '  ratio DOUBLE PRECISION,',
    '  paid_at TIMESTAMP WITH TIME ZONE DEFAULT now(),',
    '  tags INT[],',
    '  note TEXT,',
    '  active BOOLEAN NOT NULL,',
    '  mood citext,',
    '  CONSTRAINT pk PRIMARY KEY (id)',
    ');',
  ].join('\n');

  const { symbols, diagnostics } = await extractSqlSymbols('orders.sql', source);

  assert.deepEqual(symbols[0], { name: 'public.orders', kind: 'type', visibility: 'n/a', owner: '', line: 1 });
  assert.deepEqual(
    symbols.slice(1).map((symbol) => [symbol.name, symbol.type, symbol.line]),
    [
      ['id', 'INT', 2],
      ['total', 'DECIMAL(10, 2)', 3],
      ['code', 'VARCHAR(20)', 4],
      ['ratio', 'DOUBLE PRECISION', 5],
      ['paid_at', 'TIMESTAMP WITH TIME ZONE', 6],
      ['tags', 'INT[]', 7],
      ['note', 'TEXT', 8],
      ['active', 'BOOLEAN', 9],
      ['mood', 'citext', 10],
    ],
  );
  assert.ok(symbols.slice(1).every((symbol) => symbol.kind === 'field' && symbol.owner === 'public.orders'));
  assert.ok(symbols.slice(1).every((symbol) => symbol.mutable === true));
  assert.equal(diagnostics.length, 0);
});

test('a column without a type records none rather than a constraint keyword', async () => {
  const { symbols } = await extractSqlSymbols('a.sql', 'CREATE TABLE t (id PRIMARY KEY, name NOT NULL);');
  const byColumn = new Map(symbols.map((symbol) => [symbol.name, symbol]));

  assert.equal(byColumn.get('id')?.type, undefined);
  assert.equal(byColumn.get('name')?.type, undefined);
});

test('views are types with no columns, and temporary tables still show as members', async () => {
  const { symbols } = await extractSqlSymbols(
    'a.sql',
    'CREATE VIEW v AS SELECT id FROM t;\nCREATE MATERIALIZED VIEW mv AS SELECT 1;\nCREATE TEMP TABLE scratch (id INT);',
  );

  assert.deepEqual(
    symbols.map((symbol) => `${symbol.kind}:${symbol.owner ? `${symbol.owner}.` : ''}${symbol.name}`).sort(),
    ['field:scratch.id', 'type:mv', 'type:scratch', 'type:v'],
  );
});

test('ALTER TABLE ADD COLUMN gives the altered table its columns, in the spelling CREATE used', async () => {
  const source = [
    'CREATE TABLE Users (id INT);',
    'ALTER TABLE users ADD COLUMN email TEXT NOT NULL;',
    'ALTER TABLE USERS ADD COLUMN IF NOT EXISTS paid BOOLEAN, ADD COLUMN qty INT;',
    'ALTER TABLE users DROP COLUMN old;',
    'ALTER TABLE audit ADD COLUMN note TEXT;',
  ].join('\n');

  const { symbols } = await extractSqlSymbols('a.sql', source);

  assert.deepEqual(
    symbols.filter((symbol) => symbol.kind === 'field').map((symbol) => `${symbol.owner}.${symbol.name}:${symbol.type}`),
    ['Users.id:INT', 'Users.email:TEXT', 'Users.paid:BOOLEAN', 'Users.qty:INT', 'audit.note:TEXT'],
  );
  assert.deepEqual(
    symbols.filter((symbol) => symbol.kind === 'type').map((symbol) => symbol.name),
    ['Users'],
    'a table only altered here is an owner, not a declared type',
  );
});

test('a relation or column declared twice in one file is recorded once', async () => {
  const { symbols } = await extractSqlSymbols(
    'a.sql',
    'CREATE TABLE IF NOT EXISTS t (id INT);\nCREATE TABLE IF NOT EXISTS T (id INT, other TEXT);\nALTER TABLE t ADD COLUMN id INT;',
  );

  assert.deepEqual(symbols.map((symbol) => `${symbol.kind}:${symbol.name}`).sort(), ['field:id', 'type:t']);
});

test('extractSqlSymbols keeps authored case, unquotes names, and masks client directives', async () => {
  const source = '\\set ON_ERROR_STOP on\n\\i schema/base.sql\nCREATE TABLE "Sales"."Orders" ("Order Id" INT);\nGO\n';

  const { symbols, diagnostics } = await extractSqlSymbols('a.sql', source);

  assert.deepEqual(
    symbols.map((symbol) => [symbol.name, symbol.owner, symbol.line]).sort(),
    [
      ['Order Id', 'Sales.Orders', 3],
      ['Sales.Orders', '', 3],
    ],
  );
  assert.equal(diagnostics.length, 0);
});

test('SQL is registered for members but declares that it records no member access', () => {
  const sql = symbolExtractorFor('db/schema/001_users.sql');

  assert.equal(sql?.language, 'sql');
  assert.equal(sql?.tracksAccess, false);
  assert.equal(symbolExtractorFor('Main.java')?.tracksAccess, undefined);
  assert.equal(symbolExtractorFor('Main.kt')?.tracksAccess, undefined);
});

test('the member map shows tables with their columns and reports data flow as unavailable', async () => {
  const { symbols } = await extractSqlSymbols(
    'orders.sql',
    'CREATE TABLE orders (id INT, total DECIMAL(10, 2));\nCREATE VIEW v AS SELECT id FROM orders;',
  );

  const map = buildMemberMap('orders.sql', symbols, []);

  assert.deepEqual(
    map.types.map((type) => [type.name, type.fields.map((field) => `${field.name}: ${field.type}`), type.methods.length]),
    [
      ['orders', ['id: INT', 'total: DECIMAL(10, 2)'], 0],
      ['v', [], 0],
    ],
  );
  assert.equal(map.dataFlow.available, false);
  assert.equal(map.dataFlow.reason, 'no-field-access');
});

test('file health reports cohesion unavailable, with the reason, instead of scoring columns as zero', async () => {
  const { symbols } = await extractSqlSymbols('orders.sql', 'CREATE TABLE orders (id INT, total INT, note TEXT);');
  const graph = { nodes: [], edges: [], diagnostics: [], excluded: [] };

  const scored = computeFileHealth(graph, 'orders.sql', symbols, []);
  assert.equal(scored.axes.find((axis) => axis.key === 'cohesion')?.value, 0, 'the unguarded score is misleading');

  const guarded = computeFileHealth(graph, 'orders.sql', symbols, [], 'not measured: sql members have no methods');
  const cohesion = guarded.axes.find((axis) => axis.key === 'cohesion');
  assert.equal(cohesion?.value, null);
  assert.match(cohesion?.detail ?? '', /not measured/);
});
