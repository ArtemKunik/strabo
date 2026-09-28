import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { buildCandidates } from '../../src/analysis/data/candidates.ts';
import { propagateClassification } from '../../src/analysis/data/classification.ts';
import { buildConformance } from '../../src/analysis/data/conformance.ts';
import { buildEvents, eventContractId, topicDatasetId } from '../../src/analysis/data/events.ts';
import { identifyContract, identifyContracts, qualifiedIdOf, shapeFingerprint, shapeTwins } from '../../src/analysis/data/identity.ts';
import { buildModel, tableDatasetId } from '../../src/analysis/data/model.ts';
import { buildDataOverlay, buildProductLevel } from '../../src/analysis/data/product-level.ts';
import { buildDataReport } from '../../src/analysis/data/report.ts';
import { computeDataImpact } from '../../src/analysis/data/impact.ts';
import { buildSchema, viewDependenciesFrom } from '../../src/workspace/schema.ts';
import { extractDataUsesFromSource } from '../../src/workspace/data-usage.ts';
import { extractEventEndpoints } from '../../src/workspace/events.ts';
import { extractSqlLineage } from '../../src/workspace/lineage.ts';
import { extractDeclaredProducts } from '../../src/workspace/products.ts';
import { extractDbt } from '../../src/workspace/dbt.ts';
import { extractCatalogDeclarations } from '../../src/workspace/catalog.ts';
import { readCodeowners } from '../../src/analysis/data/codeowners.ts';
import type { ContractDefinition, DataEdge, DatasetNode, LineageEdge, SchemaSnapshot } from '../../src/types.ts';

const created: string[] = [];
after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(directory);
  return directory;
}

function write(root: string, file: string, content: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

// ---------------------------------------------------------------------------------------
// J2 - Data model
// ---------------------------------------------------------------------------------------

test('buildModel records views, keys, orphans, and declared ORM entities', () => {
  const sql = [
    'CREATE TABLE users (id int PRIMARY KEY, name text NOT NULL);',
    'CREATE TABLE logs (id int, user_id int, FOREIGN KEY (user_id) REFERENCES users(id));',
    'CREATE VIEW active_users AS SELECT id, name FROM users;',
  ].join('\n');
  const schema = buildSchema('api', [{ path: 'db/schema.sql', content: sql }]);
  assert.ok(schema);
  const view = schema.tables.find((table) => table.name === 'active_users');
  assert.equal(view?.kind, 'view');
  assert.deepEqual(view?.viewDependencies, ['users']);

  const uses = extractDataUsesFromSource('src/users.ts', 'const q = "SELECT id FROM users";\nconst r = "SELECT * FROM logs";');
  const { model, datasets, edges } = buildModel([schema], uses.map((use) => ({ ...use, repository: 'api' })));

  assert.deepEqual(
    datasets.map((dataset) => dataset.id).sort(),
    ['db:api/active_users', 'db:api/logs', 'db:api/users'],
  );
  // users has a primary key; logs does not.
  assert.deepEqual(
    model.findings.filter((finding) => finding.kind === 'no-primary-key').map((finding) => finding.dataset),
    ['db:api/logs'],
  );
  // The view is declared but no code reads it, so it is the one orphan.
  assert.deepEqual(
    model.findings.filter((finding) => finding.kind === 'orphan-table').map((finding) => finding.dataset),
    ['db:api/active_users'],
  );
  assert.deepEqual(
    edges.map((edge) => [edge.source, edge.kind, edge.target]),
    [
      ['src/users.ts', 'reads', 'db:api/logs'],
      ['src/users.ts', 'reads', 'db:api/users'],
    ],
  );
});

test('buildModel links an ORM entity only through its declared mapping', () => {
  const source = [
    '@Table(name = "accounts")',
    'class Account {',
    '  @Column() id: string;',
    '}',
  ].join('\n');
  const uses = extractDataUsesFromSource('Account.kt', source).map((use) => ({ ...use, repository: 'api' }));
  assert.equal(uses[0]?.entity, 'Account');
  const { model } = buildModel([], uses);
  assert.deepEqual(model.entities, [
    { repository: 'api', file: 'Account.kt', line: 1, entity: 'Account', table: 'accounts', evidence: 'ORM annotation (@Table)' },
  ]);
});

test('viewDependenciesFrom reads FROM and JOIN and ignores CTEs', () => {
  const schema = buildSchema('api', [
    { path: 'v.sql', content: 'CREATE VIEW v AS WITH x AS (SELECT 1) SELECT a.id FROM users a JOIN orders o ON o.id = a.id;' },
  ]);
  const view = schema?.tables.find((table) => table.name === 'v');
  assert.deepEqual(view?.viewDependencies, ['orders', 'users']);
});

// ---------------------------------------------------------------------------------------
// J3 - Contract identity
// ---------------------------------------------------------------------------------------

test('contract identity offers qualified and bare ids and a shape fingerprint', () => {
  const proto: ContractDefinition = {
    id: 'acme.User',
    format: 'protobuf',
    repository: 'core',
    source: 'user.proto',
    fields: [
      { name: 'id', type: 'string', required: true, number: 1 },
      { name: 'name', type: 'string', required: true, number: 2 },
    ],
  };
  const dto: ContractDefinition = {
    id: 'User',
    format: 'typescript',
    repository: 'api',
    source: 'src/models/user.ts',
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'name', type: 'string', required: true },
    ],
  };

  assert.equal(qualifiedIdOf(proto), 'acme.User');
  assert.equal(qualifiedIdOf(dto), 'src/models/User');
  assert.equal(identifyContract(dto, false).id, 'User');
  assert.equal(identifyContract(dto, true).id, 'src/models/User');
  assert.equal(identifyContract(proto, false).bareId, 'User');
  // Same fields, different ids: a shape twin, which is a recorded fact.
  assert.equal(shapeFingerprint(proto.fields), shapeFingerprint(dto.fields));
  const twins = shapeTwins(identifyContracts([proto, dto], true));
  assert.equal(twins.length, 1);
  assert.deepEqual(twins[0]?.contracts, ['acme.User', 'src/models/User']);
});

// ---------------------------------------------------------------------------------------
// J4 - Events
// ---------------------------------------------------------------------------------------

test('event endpoints are read from literal producers and consumers', () => {
  const root = tempDir('strabo-events-');
  write(root, 'Producer.kt', 'kafkaTemplate.send("order-created", payload)\nproducer.send("audit")\n');
  write(root, 'Consumer.java', '@KafkaListener(topics = "order-created")\npublic void on(Order o) {}\n');
  write(root, 'worker.py', 'sqs.receiveMessage("jobs")\n');

  const endpoints = extractEventEndpoints(root, 'svc');
  assert.deepEqual(
    endpoints.map((entry) => [entry.topic, entry.direction, entry.kind]).sort(),
    [
      ['audit', 'produce', 'topic'],
      ['jobs', 'consume', 'queue'],
      ['order-created', 'consume', 'topic'],
      ['order-created', 'produce', 'topic'],
    ].sort(),
  );

  const flows = buildEvents(endpoints, []);
  assert.equal(flows.flows.length, 3);
  const order = flows.flows.find((flow) => flow.topic === 'order-created');
  assert.equal(order?.producers.length, 1);
  assert.equal(order?.consumers.length, 1);
  assert.equal(flows.datasets.some((dataset) => dataset.id === topicDatasetId('order-created', 'topic')), true);
});

// ---------------------------------------------------------------------------------------
// J5 - Declared products
// ---------------------------------------------------------------------------------------

test('extractDeclaredProducts reads ODCS, datacontract, dbt, and strabo.groups', () => {
  const root = tempDir('strabo-products-');
  write(
    root,
    'contracts/revenue.yaml',
    [
      'apiVersion: v1.0.0',
      'kind: DataContract',
      'name: revenue',
      'team:',
      '  name: data-team',
      'schema:',
      '  - name: daily_revenue',
      '    properties:',
      '      - name: day',
      '        type: date',
      '        required: true',
      '        classification: pii',
    ].join('\n'),
  );
  write(
    root,
    'models/schema.yml',
    'models:\n  - name: orders\n    meta:\n      owner: ops\n    contract:\n      enforced: true\n',
  );
  write(
    root,
    'strabo.groups.yml',
    'products:\n  - name: billing\n    owner: billing-team\n    outputs: [daily_revenue]\n',
  );

  const products = extractDeclaredProducts(root, 'warehouse');
  const revenue = products.find((product) => product.name === 'revenue');
  assert.ok(revenue);
  assert.equal(revenue.format, 'odcs');
  assert.equal(revenue.owner, 'data-team');
  assert.deepEqual(revenue.outputPorts.map((port) => port.dataset), ['daily_revenue']);
  assert.deepEqual(revenue.classification, [{ field: 'day', tag: 'pii', source: 'contracts/revenue.yaml' }]);

  const orders = products.find((product) => product.name === 'orders');
  assert.equal(orders?.format, 'dbt');
  assert.equal(orders?.owner, 'ops');

  const billing = products.find((product) => product.name === 'billing');
  assert.equal(billing?.format, 'strabo-groups');
  assert.deepEqual(billing?.outputPorts.map((port) => port.dataset), ['daily_revenue']);
});

// ---------------------------------------------------------------------------------------
// J6 - Candidates
// ---------------------------------------------------------------------------------------

function dataset(id: string): DatasetNode {
  return { id, kind: 'table', label: id, repository: 'db', strength: 'strong' };
}

test('candidates report no-single-writer, output-port, and shared-without-contract', () => {
  const edges: DataEdge[] = [
    { kind: 'writes', source: 'a/w.ts', target: 'db:db/orders', strength: 'strong', evidence: { repository: 'a', file: 'a/w.ts', line: 1 } },
    { kind: 'writes', source: 'b/w.ts', target: 'db:db/orders', strength: 'strong', evidence: { repository: 'b', file: 'b/w.ts', line: 2 } },
    { kind: 'reads', source: 'c/r.ts', target: 'db:db/orders', strength: 'strong', evidence: { repository: 'c', file: 'c/r.ts', line: 3 } },
  ];
  const candidates = buildCandidates({
    datasets: [dataset('db:db/orders')],
    edges,
    unitOf: (repository) => repository,
    codeownerOf: (repository) => (repository === 'a' ? 'team-a' : null),
    productOwnerOf: () => null,
    governedBy: new Map(),
  });
  const kinds = candidates.map((candidate) => candidate.kind).sort();
  assert.deepEqual(kinds, ['no-single-writer', 'output-port', 'shared-without-contract']);
  const noWriter = candidates.find((candidate) => candidate.kind === 'no-single-writer');
  assert.equal(noWriter?.ownership.source, 'codeowners');
  assert.equal(noWriter?.ownership.owner, 'team-a');
});

// ---------------------------------------------------------------------------------------
// J7 - Conformance
// ---------------------------------------------------------------------------------------

test('conformance compares a declared port schema with a recorded implementation', () => {
  const findings = buildConformance({
    products: [
      {
        id: 'datacontract:warehouse:revenue',
        name: 'revenue',
        format: 'datacontract',
        repository: 'warehouse',
        source: 'datacontract.yaml',
        owner: null,
        outputPorts: [
          {
            dataset: 'daily_revenue',
            schema: [
              { name: 'day', type: 'date', required: true },
              { name: 'total', type: 'numeric', required: true },
            ],
          },
        ],
        inputPorts: [],
        contracts: [],
        classification: [],
      },
    ],
    contracts: [],
    resolveDataset: () => dataset('db:warehouse/daily_revenue'),
    implementationColumns: () => [{ name: 'day', type: 'unknown', required: false }],
  });
  assert.deepEqual(findings.map((finding) => [finding.kind, finding.field]), [['missing', 'total']]);
});

// ---------------------------------------------------------------------------------------
// J8/J14 - Lineage and classification
// ---------------------------------------------------------------------------------------

test('extractSqlLineage reads INSERT ... SELECT and a plain projection', () => {
  const root = tempDir('strabo-lineage-');
  write(root, 'src/job.ts', 'const q = "INSERT INTO daily_revenue (day, total) SELECT o.day AS day, SUM(o.amount) AS total FROM orders o";\n');
  const lineage = extractSqlLineage(root, 'warehouse');
  assert.equal(lineage.length, 1);
  assert.equal(lineage[0]?.sourceTable, 'orders');
  assert.equal(lineage[0]?.targetTable, 'daily_revenue');
  assert.deepEqual(lineage[0]?.columns, [
    { target: 'day', source: 'day', transformation: false },
    { target: 'total', source: null, transformation: true },
  ]);
});

test('classification propagates only across a plain column mapping', () => {
  const lineage: LineageEdge[] = [
    {
      source: 'db:a/users',
      target: 'db:a/user_facts',
      strength: 'strong',
      evidence: { repository: 'a', file: 'a.sql', line: 1 },
      detail: 'insert select',
      columns: [{ target: 'email', source: 'email', transformation: false }],
    },
    {
      source: 'db:a/user_facts',
      target: 'db:a/user_report',
      strength: 'strong',
      evidence: { repository: 'a', file: 'b.sql', line: 1 },
      detail: 'aggregate',
    },
  ];
  const derived = propagateClassification({
    declared: [
      {
        dataset: 'db:a/users',
        field: 'email',
        tag: 'pii',
        source: 'declared',
        path: [{ dataset: 'db:a/users', file: 'contract.yaml', detail: 'declared pii on email' }],
      },
    ],
    lineage,
  });
  assert.deepEqual(derived.map((tag) => [tag.dataset, tag.field, tag.tag, tag.source]), [
    ['db:a/user_facts', 'email', 'pii', 'derived'],
  ]);
});

// ---------------------------------------------------------------------------------------
// J9 - Data impact
// ---------------------------------------------------------------------------------------

test('data impact raises severity for a breaking change on a product port', () => {
  const edges: DataEdge[] = [
    { kind: 'writes', source: 'src/w.ts', target: 'db:db/daily_revenue', strength: 'strong', evidence: { repository: 'db', file: 'src/w.ts', line: 1 } },
    { kind: 'reads', source: 'src/r.ts', target: 'db:db/daily_revenue', strength: 'strong', evidence: { repository: 'db', file: 'src/r.ts', line: 1 } },
  ];
  const findings = computeDataImpact({
    changedFiles: ['src/w.ts'],
    edges,
    products: [
      {
        id: 'p', name: 'revenue', format: 'datacontract', repository: 'db', source: 'x.yaml', owner: null,
        outputPorts: [{ dataset: 'db:db/daily_revenue' }], inputPorts: [], contracts: [], classification: [],
      },
    ],
    candidates: [],
    governedBy: new Map(),
    lineage: [],
    unitOf: (repository) => repository,
    schemaChanges: [{ dataset: 'db:db/daily_revenue', severity: 'breaking', detail: 'column dropped' }],
  });
  assert.equal(findings[0]?.severity, 'critical');
  assert.equal(findings[0]?.consumers.length, 1);
});

// ---------------------------------------------------------------------------------------
// J12/J13 - dbt and catalogs
// ---------------------------------------------------------------------------------------

test('extractDbt detects a project, its models, refs, and columns', () => {
  const root = tempDir('strabo-dbt-');
  write(root, 'dbt_project.yml', 'name: analytics\n');
  write(root, 'models/daily_revenue.sql', 'select o.day as day, sum(o.amount) as total\nfrom {{ ref("order_facts") }}\n');
  const extraction = extractDbt(root, 'warehouse');
  assert.equal(extraction.projects.length, 1);
  assert.equal(extraction.projects[0]?.name, 'analytics');
  assert.equal(extraction.projects[0]?.modelCount, 1);
  assert.deepEqual(extraction.references.map((reference) => reference.target), ['order_facts']);
  assert.deepEqual(extraction.columns.map((column) => column.name).sort(), ['day', 'total']);
});

test('extractCatalogDeclarations reads a DataHub export', () => {
  const root = tempDir('strabo-catalog-');
  write(
    root,
    'datahub-export.json',
    JSON.stringify({
      exportedAt: '2026-01-01',
      entities: [{ urn: 'urn:li:dataset:(bigquery,warehouse.daily_revenue,PROD)', ownership: { owners: [{ owner: 'data-team' }] }, tags: ['pii'] }],
    }),
  );
  const declarations = extractCatalogDeclarations(root, 'warehouse');
  assert.equal(declarations.length, 1);
  assert.equal(declarations[0]?.catalog, 'datahub');
  assert.equal(declarations[0]?.dataset, 'warehouse.daily_revenue');
  assert.equal(declarations[0]?.owner, 'data-team');
  assert.deepEqual(declarations[0]?.classification, [{ field: null, tag: 'pii' }]);
});

test('readCodeowners applies the last matching rule', () => {
  const root = tempDir('strabo-codeowners-');
  write(root, 'CODEOWNERS', '* @default\n/data/** @data-team\n');
  const owners = readCodeowners(root);
  assert.equal(owners.ownerOf('src/app.ts'), 'default');
  assert.equal(owners.ownerOf('data/job.sql'), 'data-team');
});

// ---------------------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------------------

test('buildDataReport composes the data layer from workspace facts', () => {
  const root = tempDir('strabo-data-report-');
  write(root, 'db/schema.sql', 'CREATE TABLE orders (id int PRIMARY KEY, amount numeric NOT NULL);\nCREATE TABLE daily_revenue (day date NOT NULL, total numeric NOT NULL);\n');
  write(root, 'src/write.ts', 'const q = "INSERT INTO daily_revenue (day, total) SELECT o.day AS day, SUM(o.amount) AS total FROM orders o";\n');

  const schema = buildSchema('db', [
    { path: 'db/schema.sql', content: 'CREATE TABLE orders (id int PRIMARY KEY, amount numeric NOT NULL);\nCREATE TABLE daily_revenue (day date NOT NULL, total numeric NOT NULL);\n' },
  ]);
  assert.ok(schema);
  const uses = extractDataUsesFromSource('src/write.ts', 'const q = "SELECT id FROM orders";').map((use) => ({ ...use, repository: 'db' }));
  const lineage = extractSqlLineage(root, 'db');

  const report = buildDataReport({
    repositories: [{ name: 'db', root, graph: { nodes: [{ id: 'src/write.ts', kind: 'module' }], edges: [], diagnostics: [], excluded: [] } }],
    schemas: [schema as SchemaSnapshot],
    usage: uses,
    contracts: [],
    eventEndpoints: [],
    eventContracts: [],
    products: [],
    rawLineage: lineage,
    dbt: { projects: [], references: [], columns: [] },
    pathIo: [],
    catalogs: [],
  });

  assert.equal(report.summary.modeled, true);
  assert.equal(report.summary.datasets, 2);
  assert.equal(report.lineage.length, 1);
  assert.equal(report.lineage[0]?.source, 'db:db/orders');
  assert.equal(report.lineage[0]?.target, 'db:db/daily_revenue');
  assert.ok(report.datasets.some((d) => d.id === tableDatasetId('db', 'orders')));
  assert.ok(eventContractId('x').startsWith('contract:'));
});

test('buildProductLevel sits a product above the units that write its ports', () => {
  const root = tempDir('strabo-product-level-');
  write(root, 'datacontract.yaml', [
    'dataContractSpecification: 1.0.0',
    'info:',
    '  title: revenue',
    'schema:',
    '  - name: daily_revenue',
    '    properties:',
    '      - name: day',
    '        type: date',
    '        required: true',
  ].join('\n'));

  const schema = buildSchema('db', [
    { path: 'db/schema.sql', content: 'CREATE TABLE orders (id int PRIMARY KEY);\nCREATE TABLE daily_revenue (day date NOT NULL);\n' },
  ]);
  assert.ok(schema);
  const products = extractDeclaredProducts(root, 'db');

  const report = buildDataReport({
    repositories: [{ name: 'db', root, graph: { nodes: [{ id: 'src/write.ts', kind: 'module' }], edges: [], diagnostics: [], excluded: [] } }],
    schemas: [schema],
    usage: [],
    contracts: [],
    eventEndpoints: [],
    eventContracts: [],
    products,
    rawLineage: [{ repository: 'db', file: 'src/write.ts', line: 1, sourceTable: 'orders', targetTable: 'daily_revenue', evidence: 'INSERT ... SELECT', columns: [] }],
    dbt: { projects: [], references: [], columns: [] },
    pathIo: [],
    catalogs: [],
  });

  const level = buildProductLevel(report, [
    { id: 'db:src', name: 'src', repository: 'db', files: ['src/write.ts', 'src/read.ts'] },
    { id: 'db:jobs', name: 'jobs', repository: 'db', files: [] },
  ]);
  const product = level.products.find((entry) => entry.name === 'revenue');
  assert.ok(product);
  assert.equal(product.outputPorts[0]?.dataset, 'db:db/daily_revenue');
  assert.equal(product.owner, null);
  assert.equal(product.spansUnits, false);
  assert.deepEqual(product.units, []);

  // A recorded lineage edge between two product ports becomes a `derives` edge.
  const span = buildProductLevel(report, [
    { id: 'db:src', name: 'src', repository: 'db', files: ['src/write.ts', 'src/read.ts'] },
  ]);
  assert.ok(span.products.length >= 1);
  assert.ok(level.edges.every((edge) => edge.kind === 'derives' || edge.kind === 'produces'));

  // The overlay names each file's recorded writes and reads, and the products it feeds.
  const overlay = buildDataOverlay(report);
  assert.ok(overlay.files.every((entry) => entry.writes.length + entry.reads.length > 0));
  assert.equal(overlay.products.length, level.products.length);
});
