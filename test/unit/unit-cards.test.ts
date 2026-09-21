import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;
globalThis.document = window.document;
globalThis.window = window as unknown as typeof globalThis.window;

const { unitCardElement, formatCount, layerBars } = await import('../../ui/strabo-unit-cards.js');
const { unitHoverFacts, shelfHoverText, shelfStripText, withUnitHotspots } = await import(
  '../../ui/strabo-core.js'
);

function sampleCard(overrides: Record<string, unknown> = {}) {
  return {
    id: 'crates/api',
    name: 'ledger-api',
    ecosystem: 'cargo',
    manifest: 'Cargo.toml',
    role: 'http',
    files: 12,
    loc: 1840,
    languages: { rust: 12 },
    layers: [
      { name: 'service', order: 0, files: 4 },
      { name: 'http', order: 1, files: 8 },
    ],
    shelf: { test: 3, script: 1, generated: 0, fixture: 0, total: 4 },
    hotspots: null,
    testReach: { reached: 6, total: 12 },
    dependsOn: 2,
    usedBy: 4,
    why: 'crate `ledger-api` (Cargo.toml)',
    ...overrides,
  };
}

test('formatCount compacts thousands', () => {
  assert.equal(formatCount(940), '940');
  assert.equal(formatCount(1840), '1.8k');
  assert.equal(formatCount(12000), '12k');
  assert.equal(formatCount(undefined), '0');
});

test('layerBars scales each bar to the largest layer', () => {
  const bars = layerBars([
    { name: 'service', order: 0, files: 4 },
    { name: 'http', order: 1, files: 8 },
  ]);
  assert.deepEqual(
    bars.map((bar) => bar.ratio),
    [0.5, 1],
  );
});

test('unitCardElement renders the header, stats, layer bars, and shelf footer', () => {
  const card = unitCardElement(sampleCard());
  assert.equal(card.dataset.unit, 'crates/api');
  assert.equal(card.querySelector('.unit-card-name')?.textContent, 'ledger-api');
  assert.equal(card.querySelector('.unit-card-role')?.textContent, 'http');
  assert.equal(card.querySelector('.unit-card-eco')?.textContent, 'cargo');
  assert.match(card.querySelector('.unit-card-why')?.textContent ?? '', /Cargo\.toml/);
  assert.match(card.textContent ?? '', /12 files/);
  assert.match(card.textContent ?? '', /1\.8k lines/);
  assert.equal(card.querySelectorAll('.unit-layer').length, 2);
  // Hotspots are unknown until the function analysis runs, so the card shows a dash.
  assert.match(card.querySelector('.unit-card-reach')?.textContent ?? '', /hotspots —/);
  assert.match(card.querySelector('.unit-card-reach')?.textContent ?? '', /test reach 50%/);
  const strip = card.querySelector('.unit-shelf');
  assert.match(strip?.textContent ?? '', /support: 3 tests · 1 script/);
  assert.equal(strip?.getAttribute('aria-expanded'), 'false');
  assert.equal(card.querySelector('.unit-shelf-more')?.hasAttribute('hidden'), true);
});

test('the shelf footer expands in place on click', () => {
  const card = unitCardElement(sampleCard());
  const strip = card.querySelector('.unit-shelf') as HTMLElement;
  strip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(strip.getAttribute('aria-expanded'), 'true');
  const more = card.querySelector('.unit-shelf-more') as HTMLElement;
  assert.equal(more.hasAttribute('hidden'), false);
  assert.match(more.textContent ?? '', /3 tests/);
});

test('a unit hover card speaks unit vocabulary, never blast radius', () => {
  const model = { unitCards: [sampleCard()] };
  const facts = unitHoverFacts(model, 'crates/api');
  assert.equal(facts?.title, 'cargo package `ledger-api`');
  assert.ok(facts?.rows.some((row) => row === '12 files'));
  assert.ok(facts?.rows.some((row) => row === 'depends on 2 units'));
  assert.ok(facts?.rows.some((row) => row === 'used by 4 units'));
  assert.ok(facts?.rows.every((row) => !row.includes('blast')));
  assert.equal(unitHoverFacts(model, 'nope'), null);
});

test('a shelf hover card names tests and scripts', () => {
  assert.equal(
    shelfHoverText({ test: 74, script: 6, generated: 0, fixture: 0, total: 80 }),
    '74 test files, 6 scripts: folded support',
  );
  assert.equal(shelfStripText({ test: 3, script: 1, generated: 2, fixture: 0, total: 6 }), '3 tests · 1 script · 2 generated');
});

test('withUnitHotspots joins the report to the longest unit prefix', () => {
  const cards = [sampleCard({ id: '.' }), sampleCard({ id: 'crates/api' })];
  const filled = withUnitHotspots(cards, {
    hotspots: [
      { file: 'crates/api/src/http/routes.rs' },
      { file: 'crates/api/src/service/ledger.rs' },
      { file: 'src/root.ts' },
    ],
  });
  assert.equal(filled.find((card: { id: string }) => card.id === 'crates/api')?.hotspots, 2);
  assert.equal(filled.find((card: { id: string }) => card.id === '.')?.hotspots, 1);
});
