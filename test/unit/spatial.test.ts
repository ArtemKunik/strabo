import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildNodeGrid, gridHit } from '../../ui/strabo-spatial.js';

const nodes = [
  { id: 'a', kind: 'module', size: 0 },
  { id: 'b', kind: 'module', size: 0 },
  { id: 'c', kind: 'module', size: 0 },
];
const positions = [
  { id: 'a', x: 0, y: 0 },
  { id: 'b', x: 400, y: 0 },
  { id: 'c', x: 800, y: 0 },
];

test('gridHit finds a point inside a node box and misses one outside every box', () => {
  const grid = buildNodeGrid(nodes, positions);
  assert.equal(gridHit(grid, 0, 0), true);
  assert.equal(gridHit(grid, 8, 0), true);
  // 11 model units is the smallest node radius (MIN_DIAMETER 22).
  assert.equal(gridHit(grid, 20, 0), false);
  assert.equal(gridHit(grid, 1200, 1200), false);
});

test('a node whose centre is in a neighbouring cell is still found by its own reach', () => {
  const big = [{ id: 'unit', kind: 'unit', files: 1000 }];
  const grid = buildNodeGrid(big, [{ id: 'unit', x: 300, y: 0 }]);
  // Radius 65 reaches back past the cell boundary at x=256, into the cell the point is in.
  assert.equal(gridHit(grid, 240, 0), true);
  assert.equal(gridHit(grid, 100, 0), false);
});

test('gridHit honours the filter and skips nodes the layout did not place', () => {
  const filtered = buildNodeGrid(nodes, positions, { visible: new Set(['b']) });
  assert.equal(gridHit(filtered, 0, 0), false);
  assert.equal(gridHit(filtered, 400, 0), true);

  const unplaced = buildNodeGrid(nodes, positions.filter((position) => position.id !== 'a'));
  assert.equal(gridHit(unplaced, 0, 0), false);
  assert.equal(gridHit(unplaced, 400, 0), true);
});

test('an empty grid never reports a hit', () => {
  assert.equal(gridHit(buildNodeGrid([], []), 0, 0), false);
  assert.equal(gridHit(null, 0, 0), false);
});
