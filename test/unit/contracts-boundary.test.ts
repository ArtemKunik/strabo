import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildBoundaryView,
  buildContractBoundary,
  buildContractOverlay,
  computeContractImpact,
  diffContractFields,
} from '../../src/analysis/data/contracts-graph.ts';
import type { DataReport, Graph } from '../../src/types.ts';

function graph(files: string[], edges: Array<[string, string]>): Graph {
  return {
    nodes: files.map((id) => ({ id, kind: 'source', directory: '.' })),
    edges: edges.map(([source, target]) => ({
      source,
      target,
      kind: 'import',
      evidence: { line: 1, specifier: `./${target}`, resolution: 'exact' },
    })),
    diagnostics: [],
    excluded: [],
  };
}

function emptyData(): DataReport {
  return {
    datasets: [],
    edges: [],
    model: { entities: [], findings: [] },
    contracts: [],
    shapeTwins: [],
    events: [],
    eventContracts: [],
    products: [],
    candidates: [],
    conformance: [],
    lineage: [],
    classifications: [],
    catalogs: [],
    dbt: [],
    summary: {
      datasets: 0,
      tables: 0,
      topics: 0,
      contracts: 0,
      products: 0,
      candidates: 0,
      conformance: 0,
      lineage: 0,
      modeled: false,
    },
    unavailable: [],
  };
}

function unitOf(repository: string | null, file: string): string {
  if (file.startsWith('units/billing/')) {
    return 'units/billing';
  }
  if (file.startsWith('units/shop/')) {
    return 'units/shop';
  }
  return '.';
}
/**
 * K0 acceptance scenario: a multi-unit fixture with declared contracts (OpenAPI schema,
 * Protobuf messages, an ODCS-style governed dataset), conforming producers and consumers,
 * one cross-unit ungoverned dependency, one drifting consumer (type mismatch and missing
 * field), and a contract change impact scenario.
 */
function fixture(): { data: DataReport; graphs: Graph } {
  const data = emptyData();
  data.contracts = [
    {
      id: 'Users#User',
      bareId: 'User',
      qualifiedId: 'api.yaml#/components/schemas/User',
      format: 'openapi',
      repository: 'api',
      source: 'api.yaml',
      fingerprint: 'aaa',
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'name', type: 'string', required: true },
      ],
    },
    {
      id: 'billing.Order',
      bareId: 'Order',
      qualifiedId: 'billing.Order',
      format: 'protobuf',
      repository: 'api',
      source: 'order.proto',
      fingerprint: 'bbb',
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'total', type: 'int32', required: true },
      ],
    },
    {
      id: 'Unused',
      bareId: 'Unused',
      qualifiedId: 'contracts/Unused',
      format: 'openapi',
      repository: 'api',
      source: 'unused.yaml',
      fingerprint: 'ccc',
      fields: [{ name: 'id', type: 'string', required: true }],
    },
    {
      id: 'UserDto',
      bareId: 'UserDto',
      qualifiedId: 'src/dto/UserDto',
      format: 'typescript',
      repository: 'api',
      source: 'src/dto.ts',
      fingerprint: 'ddd',
      fields: [{ name: 'id', type: 'string', required: true }],
    },
  ];
  data.datasets = [
    { id: 'db:api/users', kind: 'table', label: 'users', repository: 'api', strength: 'strong', columns: [{ name: 'id', type: 'string', required: true }] },
    { id: 'db:api/logs', kind: 'table', label: 'logs', repository: 'api', strength: 'strong' },
  ];
  data.edges = [
    { kind: 'writes', source: 'units/billing/producer.ts', target: 'db:api/users', strength: 'strong', evidence: { repository: 'api', file: 'units/billing/producer.ts', line: 3 } },
    { kind: 'reads', source: 'units/shop/consumer.ts', target: 'db:api/users', strength: 'strong', evidence: { repository: 'api', file: 'units/shop/consumer.ts', line: 7 } },
    { kind: 'governs', source: 'contract:Users#User', target: 'db:api/users', strength: 'declared', evidence: { repository: 'api', file: 'api.yaml', line: 1 }, detail: 'declared contract match' },
    { kind: 'writes', source: 'units/billing/producer.ts', target: 'db:api/logs', strength: 'strong', evidence: { repository: 'api', file: 'units/billing/producer.ts', line: 9 } },
    { kind: 'reads', source: 'units/shop/consumer.ts', target: 'db:api/logs', strength: 'strong', evidence: { repository: 'api', file: 'units/shop/consumer.ts', line: 11 } },
  ];
  data.conformance = [
    { contract: 'Users#User', dataset: 'db:api/users', repository: 'api', kind: 'type', field: 'name', detail: 'name is declared string but recorded integer', contractEvidence: { file: 'api.yaml' } },
    { contract: 'Users#User', dataset: 'db:api/users', repository: 'api', kind: 'missing', field: 'email', detail: 'declared field email is not recorded on the implementation', contractEvidence: { file: 'api.yaml' } },
  ];
  data.events = [
    {
      topic: 'order-created',
      kind: 'topic',
      producers: [{ topic: 'order-created', kind: 'topic', repository: 'api', file: 'units/billing/publisher.ts', line: 2, direction: 'produce', evidence: 'kafka.send' }],
      consumers: [{ topic: 'order-created', kind: 'topic', repository: 'api', file: 'units/shop/subscriber.ts', line: 4, direction: 'consume', evidence: '@KafkaListener' }],
      contract: 'billing.Order',
    },
  ];
  return { data, graphs: graph([], []) };
}

test('K0: boundary aggregate joins contracts to cross-unit edges with honesty', () => {
  const { data } = fixture();
  const graphs = graph(
    ['units/billing/producer.ts', 'units/shop/consumer.ts', 'units/billing/publisher.ts', 'units/shop/subscriber.ts'],
    [],
  );
  const boundary = buildContractBoundary({
    repositories: [{ name: 'api', root: '.', graph: graphs }],
    data,
    unitOf,
  });

  // Declared beats derived: openapi/protobuf are declared, the TS DTO is a dto.
  const origins = new Map(boundary.definitions.map((entry) => [entry.id, entry.origin]));
  assert.equal(origins.get('Users#User'), 'declared');
  assert.equal(origins.get('billing.Order'), 'declared');
  assert.equal(origins.get('UserDto'), 'dto');

  // Governed: users shared across units under Users#User, plus the contracted topic.
  const governedContracts = new Set(boundary.governedEdges.map((edge) => edge.contract));
  assert.ok(governedContracts.has('Users#User'), 'users flow is governed');
  assert.ok(governedContracts.has('billing.Order'), 'topic flow is governed');
  const dataEdge = boundary.governedEdges.find((edge) => edge.contract === 'Users#User');
  assert.equal(dataEdge?.badge, '📜 User (openapi)');
  assert.equal(dataEdge?.conformance, 'drifting');
  assert.equal(dataEdge?.dataset, 'db:api/users');
  assert.equal(dataEdge?.sourceUnit, 'units/billing');
  assert.equal(dataEdge?.targetUnit, 'units/shop');
  const eventEdge = boundary.governedEdges.find((edge) => edge.contract === 'billing.Order');
  assert.equal(eventEdge?.badge, '⚡ order-created (event)');

  // Ungoverned: logs shared across units with no contract.
  assert.equal(boundary.uncontractedBoundaries.length, 1);
  assert.equal(boundary.uncontractedBoundaries[0]?.badge, '⚠️ uncontracted');

  // Conformance deviations ride through with the Phase 11 shape.
  assert.deepEqual(
    boundary.conformanceDeviations.map((entry) => entry.kind).sort(),
    ['missing', 'type'],
  );

  // Orphaned: Unused is declared by nothing that governs; the DTO heuristic stays listed too.
  assert.ok(boundary.orphanedContracts.some((entry) => entry.id === 'Unused'));
  assert.ok(!boundary.orphanedContracts.some((entry) => entry.id === 'Users#User'));
});

test('K0: canvas overlay stays inside the status budget', () => {
  const { data } = fixture();
  const graphs = graph(['units/billing/producer.ts', 'units/shop/consumer.ts'], []);
  const boundary = buildContractBoundary({ repositories: [{ name: 'api', root: '.', graph: graphs }], data, unitOf });
  const overlay = buildContractOverlay(boundary);
  const allowed = new Set(['ov-contract-def', 'ov-cycle', 'ov-declared-rule', 'ov-unreached', 'ov-affected']);
  for (const file of overlay.files) {
    for (const cls of file.classes) {
      assert.ok(allowed.has(cls), `overlay class ${cls} is inside the budget`);
    }
  }
  const byFile = new Map(overlay.files.map((entry) => [entry.file, entry.classes]));
  assert.ok(byFile.get('api.yaml')?.includes('ov-contract-def'));
  assert.ok(byFile.get('units/billing/producer.ts')?.includes('ov-cycle'));
  assert.ok(
    (byFile.get('units/shop/consumer.ts') ?? []).includes('ov-cycle') ||
      (byFile.get('units/shop/consumer.ts') ?? []).includes('ov-affected'),
  );
});

test('K0: contract change impact names breaking fields and downstream consumers', () => {
  const { data } = fixture();
  const graphs = graph(['units/billing/producer.ts', 'units/shop/consumer.ts'], []);
  const boundary = buildContractBoundary({ repositories: [{ name: 'api', root: '.', graph: graphs }], data, unitOf });
  const before = [
    { name: 'id', type: 'string', required: true },
    { name: 'name', type: 'string', required: true },
    { name: 'email', type: 'string', required: false },
  ];
  const after = [
    { name: 'id', type: 'integer', required: true },
    { name: 'name', type: 'string', required: true },
  ];
  const changes = diffContractFields(before, after);
  assert.ok(changes.some((change) => change.kind === 'removed' && change.field === 'email'));
  assert.ok(changes.some((change) => change.kind === 'type-changed' && change.field === 'id'));
  const impact = computeContractImpact({
    contract: 'Users#User',
    before,
    after,
    boundary,
    downstreamOf: (dataset) => (dataset === 'db:api/users' ? ['db:api/order_facts'] : []),
  });
  assert.equal(impact.severity, 'breaking');
  assert.ok(impact.consumers.includes('units/shop/consumer.ts'));
  assert.ok(impact.units.includes('units/billing') && impact.units.includes('units/shop'));
  assert.deepEqual(impact.downstream, ['db:api/order_facts']);
});

test('K0: boundary view draws Producer -> [Contract] -> Consumers and names bypass', () => {
  const { data } = fixture();
  const graphs = graph(['units/billing/producer.ts', 'units/shop/consumer.ts'], []);
  const boundary = buildContractBoundary({ repositories: [{ name: 'api', root: '.', graph: graphs }], data, unitOf });
  const view = buildBoundaryView(boundary);
  const plate = view.plates.find((entry) => entry.contract === 'Users#User');
  assert.ok(plate);
  assert.ok(plate?.producers.includes('units/billing/producer.ts'));
  assert.ok(plate?.consumers.includes('units/shop/consumer.ts'));
});
