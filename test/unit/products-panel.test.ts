import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;

globalThis.document = window.document;
globalThis.window = window;
globalThis.HTMLElement = window.HTMLElement;

const { renderProducts } = await import('../../ui/strabo-panels.js');

const container = () => document.createElement('div');

function report(overrides = {}) {
  return {
    products: [
      {
        id: 'datacontract:demo:revenue',
        name: 'revenue',
        format: 'datacontract',
        owner: 'data-team',
        outputPorts: [{ dataset: 'db:demo/daily_revenue', schema: [{ name: 'day' }], contract: 'datacontract:demo:revenue' }],
        inputPorts: [],
        consumers: ['src/read.ts'],
        conformance: [{ field: 'region', kind: 'missing' }],
      },
    ],
    candidates: [
      { dataset: 'db:demo/orders', kind: 'no-single-writer', writers: [{}, {}], readers: [{}], ownership: { source: 'codeowners', owner: 'core' }, detail: 'two writers' },
    ],
    conformance: [
      { contract: 'datacontract:demo:revenue', dataset: 'db:demo/daily_revenue', field: 'region', kind: 'missing', detail: 'declared but not recorded', contractEvidence: { file: 'datacontract.yaml', line: 4 } },
    ],
    datasets: [{ id: 'db:demo/daily_revenue', label: 'daily_revenue', kind: 'table', columns: [{ name: 'day' }] }],
    model: { entities: [], findings: [{ kind: 'no-primary-key', dataset: 'db:demo/daily_revenue', detail: 'no primary key' }] },
    classifications: [{ dataset: 'db:demo/daily_revenue', field: 'total', tag: 'pii', source: 'derived', path: [{}] }],
    catalogs: [],
    contracts: [],
    shapeTwins: [],
    events: [],
    dbt: [],
    ...overrides,
  };
}

test('renderProducts shows the summary, product cards, candidates, and conformance', () => {
  const target = container();
  renderProducts(target, report());

  const summary = target.querySelector('[data-role="data-summary"]');
  assert.match(summary?.textContent ?? '', /1 product\(s\)/);

  assert.equal(target.querySelector('[data-role="product-card"]')?.getAttribute('data-product'), 'datacontract:demo:revenue');
  assert.match(target.querySelector('[data-role="product-ports"]')?.textContent ?? '', /output · db:demo\/daily_revenue/);
  assert.match(target.querySelector('[data-role="product-consumers"]')?.textContent ?? '', /1 consumer file/);
  assert.match(target.querySelector('[data-role="product-conformance"]')?.textContent ?? '', /region \(missing\)/);
  assert.ok(target.textContent?.includes('No dataset is shared') === false);
});

test('renderProducts calls onSelect with the recorded dataset id', () => {
  const target = container();
  const opened = [];
  renderProducts(target, report(), { onSelect: (id) => opened.push(id) });
  target.querySelector('[data-role="product-port-open"]').click();
  assert.deepEqual(opened, ['db:demo/daily_revenue']);
});

test('each empty section says so rather than showing an empty list', () => {
  const target = container();
  renderProducts(target, report({ products: [], candidates: [], conformance: [], datasets: [], classifications: [], catalogs: [], contracts: [], events: [], dbt: [] }));
  const text = target.textContent ?? '';
  assert.match(text, /No data product declared/);
  assert.match(text, /No dataset is shared enough/);
  assert.match(text, /No declared port disagrees/);
  assert.match(text, /No table or view was recorded/);
  assert.match(text, /No classification was declared/);
  assert.match(text, /No exported catalog snapshot/);
  assert.match(text, /No contract was recorded/);
  assert.match(text, /No topic or queue flow/);
  assert.match(text, /No dbt project was detected/);
});

test('renderProducts renders an error note instead of throwing', () => {
  const target = container();
  renderProducts(target, { error: 'workspace config not found' });
  assert.match(target.textContent ?? '', /workspace config not found/);
});
