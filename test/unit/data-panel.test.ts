import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  candidateRows,
  catalogRows,
  classificationRows,
  conformanceRows,
  contractRows,
  dataProductsSummary,
  dbtRows,
  entityRows,
  erRows,
  eventRows,
  productCardLabel,
  productPortRows,
} = await import('../../ui/strabo-data.js');
const { OVERLAY_ENDPOINTS, OVERLAY_TITLES, dataOverlay, overlayFor } = await import('../../ui/strabo-overlays.js');

function report() {
  return {
    products: [
      {
        id: 'datacontract:demo:revenue',
        name: 'revenue',
        format: 'datacontract',
        owner: 'data-team',
        outputPorts: [{ dataset: 'db:demo/daily_revenue', schema: [{ name: 'day' }, { name: 'total' }], contract: 'datacontract:demo:revenue' }],
        inputPorts: [],
        consumers: ['src/read.ts'],
        conformance: [{ field: 'region', kind: 'missing' }],
      },
    ],
    candidates: [
      {
        dataset: 'db:demo/orders',
        kind: 'no-single-writer',
        writers: [{ file: 'a.ts' }, { file: 'b.ts' }],
        readers: [{ file: 'c.ts' }],
        ownership: { source: 'codeowners', owner: 'core' },
        detail: 'two writers',
      },
    ],
    conformance: [
      {
        contract: 'datacontract:demo:revenue',
        dataset: 'db:demo/daily_revenue',
        field: 'region',
        kind: 'missing',
        detail: 'declared but not recorded',
        contractEvidence: { file: 'datacontract.yaml', line: 4 },
      },
    ],
    datasets: [
      { id: 'db:demo/daily_revenue', label: 'daily_revenue', kind: 'table', columns: [{ name: 'day' }, { name: 'total' }] },
      { id: 'topic:order-created', label: 'order-created', kind: 'topic', columns: [] },
    ],
    model: {
      entities: [{ entity: 'DailyRevenue', table: 'daily_revenue', file: 'src/model.ts', line: 3, evidence: 'JPA @Table' }],
      findings: [{ kind: 'no-primary-key', dataset: 'db:demo/daily_revenue', detail: 'no primary key recorded' }],
    },
    classifications: [
      { dataset: 'db:demo/daily_revenue', field: 'total', tag: 'pii', source: 'derived', path: [{}, {}] },
    ],
    catalogs: [
      { catalog: 'datahub', dataset: 'warehouse.daily_revenue', owner: 'data-team', domain: 'finance', observed: true, exportedAt: '2026-01-01', detail: 'listed' },
      { catalog: 'datahub', dataset: 'warehouse.ghost', owner: null, domain: null, observed: false, exportedAt: null, detail: 'not seen in code' },
    ],
    contracts: [
      { id: 'datacontract:demo:revenue', bareId: 'revenue', qualifiedId: 'app.revenue', format: 'datacontract', fields: [{ name: 'day' }] },
    ],
    shapeTwins: [{ fingerprint: 'abc', contracts: ['datacontract:demo:revenue', 'odcs:demo:rev2'] }],
    events: [
      { topic: 'order-created', kind: 'topic', producers: [{}, {}], consumers: [{}], contract: 'avro:order-created' },
    ],
    dbt: [{ name: 'warehouse', root: '.', modelCount: 3, seedCount: 1, snapshotCount: 0, unresolved: [{ file: 'models/x.sql', line: 1, text: 'ref(x)' }] }],
  };
}

test('dataProductsSummary and productCardLabel read the recorded counts', () => {
  const summary = dataProductsSummary(report());
  assert.match(summary, /1 product\(s\)/);
  assert.match(summary, /1 candidate\(s\)/);
  assert.match(summary, /1 conformance finding\(s\)/);
  assert.match(summary, /2 catalog declaration\(s\)/);
  assert.match(summary, /1 dbt project\(s\)/);

  assert.equal(
    productCardLabel(report().products[0]),
    'revenue · datacontract · owned by data-team · 1 output port(s), 0 input port(s)',
  );
});

test('productPortRows and erRows join ports, columns, entities, and findings', () => {
  const ports = productPortRows(report().products[0]);
  assert.deepEqual(ports.map((port) => [port.direction, port.dataset, port.fields]), [
    ['output', 'db:demo/daily_revenue', 2],
  ]);

  const er = erRows(report());
  assert.deepEqual(er.map((row) => row.label), ['daily_revenue']);
  assert.deepEqual(er[0]?.columns, ['day', 'total']);
  assert.deepEqual(er[0]?.findings, [{ kind: 'no-primary-key', detail: 'no primary key recorded' }]);

  assert.deepEqual(entityRows(report()).map((row) => [row.entity, row.table]), [['DailyRevenue', 'daily_revenue']]);
});

test('candidates, conformance, classifications, catalogs, dbt, and events become rows', () => {
  const candidates = candidateRows(report());
  assert.deepEqual(candidates.map((row) => [row.dataset, row.writers, row.readers, row.owner]), [
    ['db:demo/orders', 2, 1, 'core'],
  ]);

  const conformance = conformanceRows(report());
  assert.deepEqual(conformance.map((row) => [row.kind, row.field, row.file, row.line]), [
    ['missing', 'region', 'datacontract.yaml', 4],
  ]);

  const classifications = classificationRows(report());
  assert.deepEqual(classifications.map((row) => [row.dataset, row.field, row.tag, row.source, row.pathLength]), [
    ['db:demo/daily_revenue', 'total', 'pii', 'derived', 2],
  ]);

  const catalogs = catalogRows(report());
  assert.equal(catalogs.rows.length, 2);
  assert.equal(catalogs.observed, 1);
  assert.equal(catalogs.unobserved, 1);

  assert.deepEqual(dbtRows(report()).map((row) => [row.name, row.models, row.unresolved]), [['warehouse', 3, 1]]);
  assert.deepEqual(eventRows(report()).map((row) => [row.topic, row.producers, row.consumers]), [
    ['order-created', 2, 1],
  ]);

  const contracts = contractRows(report());
  assert.deepEqual(contracts[0]?.twins, ['odcs:demo:rev2']);
});

test('dataOverlay marks product producers apart from plain data touch', () => {
  const overlay = dataOverlay({
    files: [
      { file: 'src/write.ts', writes: ['db:demo/daily_revenue'], reads: [], products: ['datacontract:demo:revenue'] },
      { file: 'src/read.ts', writes: [], reads: ['db:demo/daily_revenue'], products: ['datacontract:demo:revenue'] },
    ],
    products: [{ id: 'datacontract:demo:revenue' }],
  });
  assert.equal(overlay.classes.get('src/write.ts'), 'ov-product');
  assert.equal(overlay.classes.get('src/read.ts'), 'ov-data');
  assert.match(overlay.summary, /2 file\(s\) touch data/);
  assert.equal(overlay.meta.products, 1);
});

test('overlayFor routes data and the endpoint is registered', () => {
  const overlay = overlayFor('data', { files: [], products: [] });
  assert.equal(overlay.classes.size, 0);
  assert.equal(OVERLAY_ENDPOINTS.data, '/analysis/data/overlay');
  assert.equal(OVERLAY_TITLES.data, 'Data');
});
