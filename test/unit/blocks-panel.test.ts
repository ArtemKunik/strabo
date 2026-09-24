import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

/**
 * The Blocks panel is browser code, but its input is the pure brick assembly and its output
 * is a DOM tree. JSDOM exercises the render from Node, so the panel is covered without a
 * browser and the acceptance round-trip.
 */
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;

globalThis.document = window.document;
globalThis.window = window;
globalThis.HTMLElement = window.HTMLElement;

const { buildBrickAssembly } = await import('../../ui/strabo-lego.js');
const { renderBlocks } = await import('../../ui/strabo-panel-blocks.js');

const container = () => document.createElement('div');
const node = (id, extra = {}) => ({ id, kind: 'module', label: id, ...extra });
const edge = (source, target) => ({ source, target });

test('renderBlocks draws the assembly, its summary, a legend, and an all-clear', () => {
  const assembly = buildBrickAssembly(
    [node('a'), node('b'), node('c')],
    [edge('a', 'b'), edge('b', 'c')],
  );
  const panel = container();
  renderBlocks(panel, assembly);

  assert.match(panel.querySelector('[data-role="blocks-summary"]')?.textContent ?? '', /3 bricks · 2 snaps/);
  const svg = panel.querySelector('[data-role="blocks-svg"]');
  assert.ok(svg, 'the assembly svg is drawn');
  assert.equal(panel.querySelectorAll('.brick').length, 3);
  assert.equal(panel.querySelectorAll('.blocks-legend-row').length, 4);
  assert.match(panel.querySelector('.blocks-clear')?.textContent ?? '', /no cycle was recorded/);
});

test('a tangled and a detached brick are drawn with their note and status class', () => {
  const assembly = buildBrickAssembly(
    [node('a'), node('b'), node('island')],
    [edge('a', 'b'), edge('b', 'a')],
  );
  const panel = container();
  renderBlocks(panel, assembly);

  assert.ok(panel.querySelector('.brick.tangled'), 'the cycle bricks carry the tangled class');
  assert.ok(panel.querySelector('.brick.detached'), 'the standalone brick carries the detached class');
  const kinds = [...panel.querySelectorAll('.blocks-note')].map((note) => note.dataset.kind);
  assert.deepEqual(kinds, ['tangled', 'detached']);
});

test('clicking or keyboard-activating a brick calls onOpen with its id, and selection shows', () => {
  const assembly = buildBrickAssembly([node('a'), node('b')], [edge('a', 'b')]);
  const opened = [];
  const panel = container();
  renderBlocks(panel, assembly, { onOpen: (id) => opened.push(id), selected: 'b' });

  const selected = panel.querySelector('.brick.is-selected');
  assert.equal(selected?.dataset.brick, 'b');

  const first = panel.querySelector('.brick');
  first.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(opened.length, 1);

  first.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(opened.length, 2, 'Enter activates the brick too');
});

test('an unavailable assembly says so instead of drawing an empty stage', () => {
  const panel = container();
  renderBlocks(panel, buildBrickAssembly([], []));

  assert.equal(panel.querySelector('[data-role="blocks-svg"]'), null);
  assert.match(panel.querySelector('.unavailable')?.textContent ?? '', /no bricks to assemble/i);
});
