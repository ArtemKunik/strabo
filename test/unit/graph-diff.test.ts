import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diffElements, diffGraph } from '../../ui/strabo-graph-diff.js';

const node = (id, overrides = {}) => ({
  group: 'nodes',
  classes: 'kind-module',
  data: { id },
  position: { x: 0, y: 0 },
  ...overrides,
});

test('diffElements adds every element when there is no previous render', () => {
  const diff = diffElements([], [node('a'), node('b')]);

  assert.deepEqual(diff.added.map((element) => element.data.id), ['a', 'b']);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.updated, []);
});

test('diffElements is empty when nothing changed', () => {
  const elements = [node('a'), node('b')];

  const diff = diffElements(elements, [node('a'), node('b')]);

  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.updated, []);
});

test('diffElements reports the ids that disappeared', () => {
  const diff = diffElements([node('a'), node('b')], [node('b')]);

  assert.deepEqual(diff.removed, ['a']);
  assert.deepEqual(diff.added, []);
});

test('diffElements pairs an update with the previous definition', () => {
  const diff = diffElements(
    [node('a', { data: { id: 'a', diameter: 10 } })],
    [node('a', { data: { id: 'a', diameter: 20 } })],
  );

  assert.equal(diff.updated.length, 1);
  assert.equal(diff.updated[0].before.data.diameter, 10);
  assert.equal(diff.updated[0].after.data.diameter, 20);
});

test('diffElements treats a moved node or a new class as a change', () => {
  const moved = diffElements([node('a')], [node('a', { position: { x: 5, y: 0 } })]);
  const reclassed = diffElements([node('a')], [node('a', { classes: 'kind-test' })]);

  assert.equal(moved.updated.length, 1);
  assert.equal(reclassed.updated.length, 1);
});

test('diffGraph splits the diff into nodes and edges', () => {
  const before = { nodes: [node('a'), node('b')], edges: [] };
  const after = { nodes: [node('a')], edges: [{ group: 'edges', data: { id: 'e0', source: 'a', target: 'b' } }] };

  const diff = diffGraph(before, after);

  assert.deepEqual(diff.nodes.removed, ['b']);
  assert.deepEqual(diff.edges.added.map((element) => element.data.id), ['e0']);
});

test('diffGraph defaults to an empty graph', () => {
  const diff = diffGraph(undefined, undefined);

  assert.deepEqual(diff, {
    nodes: { added: [], removed: [], updated: [] },
    edges: { added: [], removed: [], updated: [] },
  });
});
