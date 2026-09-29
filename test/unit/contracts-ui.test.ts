import assert from 'node:assert/strict';
import { test } from 'node:test';

const { OVERLAY_CLASSES } = await import('../../ui/strabo-graph-classes.js');
const {
  FILE_MODE_OVERLAYS,
  OVERLAY_ENDPOINTS,
  OVERLAY_TITLES,
  contractsOverlay,
  overlayFor,
} = await import('../../ui/strabo-overlays.js');
const {
  contractBoundaryRows,
  contractEdgeBadge,
  contractImpactSummary,
} = await import('../../ui/strabo-data.js');

const overlay = {
  files: [
    { file: 'api.yaml', classes: ['ov-contract-def'], reason: 'defines contract Users#User (openapi)' },
    { file: 'units/billing/producer.ts', classes: ['ov-cycle'], reason: 'drifts from Users#User naming type on name' },
    { file: 'units/shop/consumer.ts', classes: ['ov-affected'], reason: 'ungoverned boundary endpoint' },
    { file: 'weird.ts', classes: ['ov-made-up'], reason: 'unknown' },
  ],
  summary: { definitions: 1, drifting: 1, ungoverned: 1 },
};

test('the Data contracts overlay is registered within the status budget', () => {
  assert.equal(OVERLAY_TITLES.contracts, 'Data contracts');
  assert.equal(OVERLAY_ENDPOINTS.contracts, '/analysis/contracts/overlay');
  assert.ok(FILE_MODE_OVERLAYS.includes('contracts'));
  assert.ok(OVERLAY_CLASSES.includes('ov-contract-def'));
});

test('contractsOverlay annotates only budget classes and summarises', () => {
  const result = contractsOverlay(overlay);
  assert.equal(result.classes.get('api.yaml'), 'ov-contract-def');
  assert.equal(result.classes.get('units/billing/producer.ts'), 'ov-cycle');
  assert.equal(result.classes.get('units/shop/consumer.ts'), 'ov-affected');
  assert.ok(!result.classes.has('weird.ts'));
  assert.match(result.summary, /1 contract\(s\) · 1 drifting edge\(s\) · 1 ungoverned/);
  assert.match(result.items[0] ?? '', /api\.yaml · defines contract/);
});

test('overlayFor routes contracts and ignores an unknown kind', () => {
  assert.equal(overlayFor('contracts', overlay).classes.size, 3);
  assert.equal(overlayFor('unknown', overlay).classes.size, 0);
  assert.equal(contractsOverlay(null).classes.size, 0);
});

test('contractEdgeBadge names the recorded badge, never a guess', () => {
  assert.equal(contractEdgeBadge({ badge: '📜 User (openapi)' }), '📜 User (openapi)');
  assert.equal(contractEdgeBadge({ kind: 'event', contract: 'order-created' }), '⚡ order-created (event)');
  assert.equal(contractEdgeBadge({ kind: 'data', contract: 'Users#User', contractFormat: 'openapi' }), '📜 Users#User (openapi)');
  assert.equal(contractEdgeBadge({ source: 'a', target: 'b' }), '⚠️ uncontracted');
  assert.equal(contractEdgeBadge(null), null);
});

test('contractBoundaryRows lists definitions, governed, drifting, ungoverned, and orphaned', () => {
  const rows = contractBoundaryRows({
    definitions: [{ id: 'Users#User', format: 'openapi', origin: 'declared', repository: 'api', source: 'api.yaml', fields: [{ name: 'id' }] }],
    governedEdges: [{ source: 'a', target: 'b', contract: 'Users#User', contractFormat: 'openapi', kind: 'data', conformance: 'drifting', badge: '📜 User (openapi)' }],
    conformanceDeviations: [{ contract: 'Users#User', field: 'name', kind: 'type', detail: 'mismatch' }],
    uncontractedBoundaries: [{ source: 'b', target: 'c', kind: 'data', reason: 'no contract', badge: '⚠️ uncontracted' }],
    orphanedContracts: [{ id: 'Unused', format: 'openapi', source: 'unused.yaml' }],
    unverifiedEdges: [],
  });
  assert.equal(rows.definitions[0]?.origin, 'declared');
  assert.equal(rows.governed.length, 1);
  assert.equal(rows.drifting[0]?.deviations.length, 1);
  assert.equal(rows.ungoverned.length, 1);
  assert.equal(rows.orphaned[0]?.id, 'Unused');
});

test('contractImpactSummary names severity and consumers', () => {
  assert.equal(
    contractImpactSummary({ contract: 'Users#User', severity: 'breaking', changes: [{}, {}], consumers: ['a', 'b'] }),
    'Users#User · breaking · 2 field change(s) · 2 consumer(s)',
  );
});
