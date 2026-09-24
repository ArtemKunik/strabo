import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assemblySummary,
  buildBrickAssembly,
  layoutAssembly,
  MAX_FOOTPRINT,
  MAX_STUDS,
} from '../../ui/strabo-lego.js';

const node = (id, extra = {}) => ({ id, kind: 'module', label: id, ...extra });
const edge = (source, target, weight) => ({ source, target, ...(weight ? { weight } : {}) });

test('bricks stack by dependency depth with the foundation at layer 0', () => {
  // c is the foundation; b rests on c; a rests on b. a -> b -> c.
  const assembly = buildBrickAssembly(
    [node('a'), node('b'), node('c')],
    [edge('a', 'b'), edge('b', 'c')],
  );

  const layerOf = new Map(assembly.bricks.map((brick) => [brick.id, brick.layer]));
  assert.equal(layerOf.get('c'), 0);
  assert.equal(layerOf.get('b'), 1);
  assert.equal(layerOf.get('a'), 2);
  assert.deepEqual(assembly.layers, [['c'], ['b'], ['a']]);

  const studs = new Map(assembly.bricks.map((brick) => [brick.id, brick.studs]));
  assert.equal(studs.get('c'), 1, 'b rests on c');
  assert.equal(studs.get('b'), 1, 'a rests on b');
  assert.equal(studs.get('a'), 0, 'nothing rests on a');
  assert.equal(assembly.stats.maxLayer, 2);
});

test('a brick with no recorded edge either way is detached, and named so', () => {
  const assembly = buildBrickAssembly([node('a'), node('island')], []);
  const island = assembly.bricks.find((brick) => brick.id === 'island');

  assert.equal(island?.detached, true);
  assert.equal(island?.status, 'detached');
  assert.equal(assembly.stats.detached, 2, 'two bricks, no edges at all');
  const suggestion = assembly.suggestions.find((entry) => entry.kind === 'detached');
  assert.match(suggestion?.detail ?? '', /no recorded import in either direction/);
});

test('a two-way import is a tangled cycle that cannot lift the stack', () => {
  const assembly = buildBrickAssembly(
    [node('a'), node('b')],
    [edge('a', 'b'), edge('b', 'a')],
  );

  assert.deepEqual(assembly.bricks.map((brick) => brick.status), ['tangled', 'tangled']);
  assert.equal(assembly.layers.length, 1, 'a cycle sits on one row, not lifted forever');
  assert.equal(assembly.stats.cycles, 1);
  const suggestion = assembly.suggestions.find((entry) => entry.kind === 'tangled');
  assert.match(suggestion?.title ?? '', /Untangle 2 bricks/);
  assert.match(suggestion?.detail ?? '', /2 recorded edges/);
});

test('the most load-bearing brick is a keystone, and the suggestion keeps the count', () => {
  const dependents = ['a', 'b', 'c', 'd'];
  const assembly = buildBrickAssembly(
    [node('base'), ...dependents.map((id) => node(id))],
    dependents.map((id) => edge(id, 'base')),
  );

  const base = assembly.bricks.find((brick) => brick.id === 'base');
  assert.equal(base?.status, 'keystone');
  assert.equal(base?.topples, 4);
  for (const id of dependents) {
    assert.equal(assembly.bricks.find((brick) => brick.id === id)?.status, 'plain');
  }
  const suggestion = assembly.suggestions.find((entry) => entry.kind === 'keystone');
  assert.match(suggestion?.detail ?? '', /removing base topples 4 bricks/);
});

test('self-edges, missing targets, and duplicate edges never reach the assembly', () => {
  const assembly = buildBrickAssembly(
    [node('a'), node('b')],
    [edge('a', 'a'), edge('a', 'ghost'), edge('a', 'b'), edge('a', 'b', 5)],
  );

  assert.equal(assembly.snaps.length, 1, 'self-edge, ghost target, and duplicate are dropped');
  assert.deepEqual(assembly.snaps[0], { from: 'a', to: 'b', weight: 5 });
});

test('footprint grows with mass and is capped, and studs are capped', () => {
  const many = Array.from({ length: 20 }, (_, index) => node(`d${index}`));
  const assembly = buildBrickAssembly(
    [node('big', { files: 9 }), node('huge', { files: 1000 }), ...many],
    many.map((entry) => edge(entry.id, 'big')),
  );

  const big = assembly.bricks.find((brick) => brick.id === 'big');
  const huge = assembly.bricks.find((brick) => brick.id === 'huge');
  assert.equal(big?.footprint, 3, 'sqrt(9) = 3');
  assert.equal(huge?.footprint, MAX_FOOTPRINT, 'capped');
  assert.equal(big?.studs, MAX_STUDS, 'studs are capped at MAX_STUDS, not the raw 20');
});

test('layout keeps the foundation at the bottom and wires each snap underside to top', () => {
  const assembly = buildBrickAssembly(
    [node('a'), node('b'), node('c')],
    [edge('a', 'b'), edge('b', 'c')],
  );
  const layout = layoutAssembly(assembly);
  const at = new Map(layout.bricks.map((brick) => [brick.id, brick]));

  assert.ok(at.get('c')!.y > at.get('b')!.y, 'foundation sits below b');
  assert.ok(at.get('b')!.y > at.get('a')!.y, 'b sits below a');
  assert.ok(layout.width > 0 && layout.height > 0);

  const snap = layout.snaps.find((entry) => entry.from === 'a');
  assert.equal(snap?.y1, at.get('a')!.y + at.get('a')!.h, 'starts at the upper underside');
  assert.equal(snap?.y2, at.get('b')!.y, 'ends at the lower top face');
});

test('an empty map is unavailable rather than an empty stack', () => {
  const assembly = buildBrickAssembly([], []);
  assert.equal(assembly.available, false);
  assert.equal(assembly.bricks.length, 0);
  assert.equal(assemblySummary(assembly), 'No bricks to assemble.');
});

test('assemblySummary counts bricks, snaps, and problems', () => {
  const assembly = buildBrickAssembly(
    [node('a'), node('b'), node('c')],
    [edge('a', 'b'), edge('b', 'a'), edge('c', 'b')],
  );
  const summary = assemblySummary(assembly);
  assert.match(summary, /3 bricks · 3 snaps · 1 cycle/);
});
