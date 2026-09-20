import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ISLAND_PADDING,
  fitLabel,
  islandBounds,
  islandLabel,
  islandLabelFits,
  islandsApply,
  projectIsland,
} from '../../ui/strabo-islands.js';

/** A file-mode view model: two directories, positions as the layout packs them. */
function model() {
  return {
    nodes: [
      { id: 'src/a.ts', directory: 'src', transitiveDependents: 0 },
      { id: 'src/b.ts', directory: 'src', transitiveDependents: 0 },
      { id: 'ui/c.js', directory: 'ui', transitiveDependents: 0 },
    ],
    positions: [
      { id: 'src/a.ts', x: 0, y: 0 },
      { id: 'src/b.ts', x: 96, y: 0 },
      { id: 'ui/c.js', x: 0, y: 200 },
    ],
  };
}

test('islandBounds groups by directory and encloses the drawn nodes, not their centres', () => {
  const islands = islandBounds(model());
  assert.equal(islands.length, 2);

  const src = islands.find((island) => island.directory === 'src');
  assert.ok(src);
  assert.equal(src.count, 2);
  // Smallest node is MIN_DIAMETER 22, so the plate clears each centre by 11 plus padding.
  assert.equal(src.x, -11 - ISLAND_PADDING);
  assert.equal(src.width, 96 + 22 + ISLAND_PADDING * 2);
});

test('islandBounds keeps a one-member directory: a lone file is still a region', () => {
  const ui = islandBounds(model()).find((island) => island.directory === 'ui');
  assert.ok(ui);
  assert.equal(ui.count, 1);
  assert.equal(ui.width, 22 + ISLAND_PADDING * 2);
});

test('islandBounds shrinks an island to the members surviving the filter', () => {
  const islands = islandBounds(model(), { visible: new Set(['src/a.ts', 'ui/c.js']) });
  const src = islands.find((island) => island.directory === 'src');
  assert.equal(src?.count, 1);
  assert.equal(src?.width, 22 + ISLAND_PADDING * 2);
});

test('islandBounds drops a directory filtered out entirely rather than leaving an empty plate', () => {
  const islands = islandBounds(model(), { visible: new Set(['ui/c.js']) });
  assert.deepEqual(
    islands.map((island) => island.directory),
    ['ui'],
  );
});

test('islandBounds skips a node the layout gave no position', () => {
  const unplaced = model();
  unplaced.positions = unplaced.positions.filter((position) => position.id !== 'ui/c.js');
  assert.deepEqual(
    islandBounds(unplaced).map((island) => island.directory),
    ['src'],
  );
});

test('islandBounds orders largest first so a small plate is never buried', () => {
  const areas = islandBounds(model()).map((island) => island.width * island.height);
  assert.deepEqual(areas, [...areas].sort((a, b) => b - a));
});

test('islands do not apply to block mode, where a node is already a directory', () => {
  const blocks = { ...model(), prefixLength: 1 };
  assert.equal(islandsApply(blocks), false);
  assert.deepEqual(islandBounds(blocks), []);
});

test('islandLabel shows the scanner root marker as a path', () => {
  assert.equal(islandLabel('.'), '/');
  assert.equal(islandLabel('src/analysis'), 'src/analysis');
});

test('projectIsland applies the Cytoscape transform', () => {
  const box = projectIsland(
    { x: 10, y: 20, width: 100, height: 50 },
    { pan: { x: 5, y: 7 }, zoom: 2 },
  );
  assert.deepEqual(box, { x: 25, y: 47, width: 200, height: 100 });
});

test('islandLabelFits drops the name when the plate has no room for it', () => {
  assert.equal(islandLabelFits({ width: 200, height: 120 }), true);
  assert.equal(islandLabelFits({ width: 40, height: 120 }), false);
  assert.equal(islandLabelFits({ width: 200, height: 12 }), false);
});

test('fitLabel keeps the tail, where a path says where you are', () => {
  assert.equal(fitLabel('test/acceptance/steps', 400), 'test/acceptance/steps');
  // 120px less the two 10px insets holds 15 glyphs at 6.6px each; one goes to the ellipsis.
  assert.equal(fitLabel('test/fixtures/kotlin-repo/src/api', 120), '…n-repo/src/api');
});

test('fitLabel drops the label when the plate holds little more than the ellipsis', () => {
  assert.equal(fitLabel('src/analysis', 30), '');
});
