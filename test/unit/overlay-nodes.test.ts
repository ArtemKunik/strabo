import assert from 'node:assert/strict';
import { test } from 'node:test';

import cytoscape from 'cytoscape';

import { overlayNodes } from '../../ui/strabo-lenses.js';

function graph() {
  return cytoscape({
    headless: true,
    elements: ['a', 'b', 'c'].map((id) => ({ group: 'nodes' as const, data: { id } })),
  });
}

test('an overlay rings the files it marks and dims the rest', () => {
  const cy = graph();
  overlayNodes(cy, new Map([['a', 'ov-changed'], ['b', 'ov-affected']]));

  assert.ok(cy.getElementById('a').hasClass('ov-changed'));
  assert.ok(cy.getElementById('b').hasClass('ov-affected'));
  assert.ok(cy.getElementById('c').hasClass('ov-quiet'));
  assert.ok(!cy.getElementById('a').hasClass('ov-quiet'));
});

test('an overlay that marks nothing on this map dims nothing', () => {
  const cy = graph();
  overlayNodes(cy, new Map([['elsewhere.ts', 'ov-changed']]));
  assert.equal(cy.nodes('.ov-quiet').length, 0);
});

test('clearing the overlay lifts both the rings and the dimming', () => {
  const cy = graph();
  overlayNodes(cy, new Map([['a', 'ov-changed']]));
  overlayNodes(cy, null);
  assert.equal(cy.nodes('.ov-changed, .ov-quiet').length, 0);
});
