import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;
globalThis.document = window.document;
globalThis.window = window;

const { renderTierPanel } = await import('../../ui/strabo-tier-panel.js');

function sampleReport() {
  const call = {
    file: 'src/api/orders.ts',
    tier: 'api',
    unit: '.',
    line: 3,
    method: 'GET',
    target: '/orders',
    host: null,
    path: '/orders',
  };
  const endpoint = { file: 'openapi.yaml', tier: 'api', unit: '.', method: 'GET', path: '/orders' };
  return {
    files: [],
    units: [{ id: '.', name: 'web', role: 'app', roleEvidence: '', files: 2, tiers: {} }],
    matrix: {
      tiers: [
        'frontend',
        'api',
        'domain',
        'data',
        'integration',
        'infra',
        'build',
        'tests',
        'unclassified',
      ],
      units: ['.'],
      cells: [
        { unit: '.', tier: 'api', files: 1, lines: 5 },
        { unit: '.', tier: 'data', files: 1, lines: 7 },
      ],
      perTier: [
        { tier: 'api', files: 1, lines: 5, fileShare: 0.5 },
        { tier: 'data', files: 1, lines: 7, fileShare: 0.5 },
      ],
    },
    directions: [
      {
        unit: '.',
        source: 'src/data/store.ts',
        target: 'src/handlers/orders.ts',
        sourceTier: 'data',
        targetTier: 'api',
        kind: 'upward',
        line: 1,
        specifier: '../handlers/orders',
      },
    ],
    tables: [{ table: 'orders', file: 'src/data/store.ts', line: 2, evidence: 'string-literal SQL' }],
    tableTrace: [
      { table: 'orders', file: 'src/data/store.ts', tier: 'data', unit: '.', line: 2, evidence: 'string-literal SQL' },
    ],
    calls: [call],
    endpoints: [endpoint],
    traces: [{ call, endpoint }],
    summary: {
      frontend: 0,
      api: 1,
      domain: 0,
      data: 1,
      integration: 0,
      infra: 0,
      build: 0,
      tests: 0,
      unclassified: 0,
      total: 2,
      mixed: 0,
    },
    skipped: [],
    truncated: 0,
  };
}

test('renderTierPanel draws the matrix, direction check, and table trace', () => {
  const container = document.createElement('div');
  renderTierPanel(container, sampleReport(), 'data');

  const rows = [...container.querySelectorAll('[data-role="tier-row"]')];
  assert.deepEqual(rows.map((row) => row.dataset.tier), ['api', 'data']);

  const selected = container.querySelector('[data-role="tier-row"].is-selected');
  assert.equal(selected?.dataset.tier, 'data');

  const shares = container.querySelector('[data-role="tier-shares"]')?.textContent ?? '';
  assert.match(shares, /API surface 50%/);

  const directions = container.querySelector('[data-role="tier-directions"]')?.textContent ?? '';
  assert.match(directions, /1 upward/);
  const direction = container.querySelector('[data-role="tier-direction"]')?.textContent ?? '';
  assert.match(direction, /upward/);
  assert.match(direction, /src\/data\/store\.ts → src\/handlers\/orders\.ts \(L1\)/);

  const trace = container.querySelector('[data-role="tier-table-trace"]')?.textContent ?? '';
  assert.match(trace, /src\/data\/store\.ts \(data\)/);

  const callRow = container.querySelector('[data-role="tier-call"]')?.textContent ?? '';
  assert.match(callRow, /GET \/orders · src\/api\/orders\.ts:3/);
  const endpointRow = container.querySelector('[data-role="tier-endpoint"]')?.textContent ?? '';
  assert.match(endpointRow, /GET \/orders · openapi\.yaml/);
  const joined = container.querySelector('[data-role="tier-trace"]')?.textContent ?? '';
  assert.match(joined, /src\/api\/orders\.ts:3 → GET \/orders \(openapi\.yaml\)/);
});

test('renderTierPanel says so when nothing was classified', () => {
  const container = document.createElement('div');
  renderTierPanel(container, { files: [], matrix: { tiers: [], units: [], cells: [], perTier: [] }, summary: { total: 0 } });
  assert.match(container.textContent, /No file was classified into a tier/);
});
