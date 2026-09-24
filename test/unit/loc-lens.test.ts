import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyLocLens } from '../../ui/strabo-lenses.js';

/** A stand-in for a Cytoscape node: tracks classes and answers `data(key)`. */
function fakeNode(id, data) {
  const classes = new Set();
  return {
    id: () => id,
    data: (key) => (key === undefined ? data : data[key]),
    addClass: (name) => {
      for (const token of String(name).split(' ')) classes.add(token);
    },
    removeClass: (name) => {
      for (const token of String(name).split(' ')) classes.delete(token);
    },
    toggleClass: (name, on) => {
      if (on) classes.add(name);
      else classes.delete(name);
    },
    has: (name) => classes.has(name),
  };
}

/** A stand-in for a Cytoscape instance: a synchronous `batch` over a fixed node list. */
function fakeCy(nodes) {
  return {
    batch: (work) => work(),
    nodes: () => nodes,
  };
}

function fileNode(id, lines) {
  return fakeNode(id, { kind: 'module', lines });
}

test('applyLocLens hides files under the threshold and marks the rest', () => {
  const big = fileNode('src/big.ts', 900);
  const small = fileNode('src/small.ts', 40);
  const cy = fakeCy([big, small]);

  applyLocLens(cy, 300, true);

  assert.equal(small.has('loc-hidden'), true);
  assert.equal(big.has('loc-hidden'), false);
  assert.equal(big.has('large-file'), true);
  assert.equal(small.has('large-file'), false);
  assert.equal(big.has('loc-sized'), true);
  assert.equal(small.has('loc-sized'), true);
});

test('a file exactly at the threshold counts as large', () => {
  const edge = fileNode('src/edge.ts', 300);
  applyLocLens(fakeCy([edge]), 300, true);
  assert.equal(edge.has('large-file'), true);
  assert.equal(edge.has('loc-hidden'), false);
});

test('applyLocLens clears every class when the lens is off', () => {
  const big = fileNode('src/big.ts', 900);
  const cy = fakeCy([big]);
  applyLocLens(cy, 300, true);
  applyLocLens(cy, 300, false);

  assert.equal(big.has('loc-hidden'), false);
  assert.equal(big.has('large-file'), false);
  assert.equal(big.has('loc-sized'), false);
});

test('aggregate nodes and files with no line count are never hidden or resized', () => {
  const unit = fakeNode('crates/api', { kind: 'unit', files: 12 });
  const unknown = fakeNode('src/unknown.ts', { kind: 'module', lines: null });
  applyLocLens(fakeCy([unit, unknown]), 300, true);

  for (const node of [unit, unknown]) {
    assert.equal(node.has('loc-hidden'), false);
    assert.equal(node.has('large-file'), false);
    assert.equal(node.has('loc-sized'), false);
  }
});

test('a non-positive threshold treats every measured file as large', () => {
  const small = fileNode('src/small.ts', 1);
  applyLocLens(fakeCy([small]), 0, true);
  assert.equal(small.has('loc-hidden'), false);
  assert.equal(small.has('large-file'), true);
});
