import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildLayeredPositions } from '../../src/analysis/layered-layout.ts';
import type { Graph } from '../../src/types.ts';

function graphOf(ids: string[], pairs: Array<[string, string]>): Graph {
  return {
    nodes: ids.map((id) => ({ id, kind: 'module', directory: '.' })),
    edges: pairs.map(([source, target]) => ({ source, target, kind: 'import', evidence: [] })),
    diagnostics: [],
    excluded: [],
  } as unknown as Graph;
}

function yOf(graph: Graph): Record<string, number> {
  return Object.fromEntries(buildLayeredPositions(graph).map((position) => [position.id, position.y]));
}

test('every import points down: an importer sits above what it imports', () => {
  const y = yOf(graphOf(['app', 'api', 'core', 'util'], [['app', 'api'], ['api', 'core'], ['app', 'core'], ['core', 'util']]));
  assert.ok(y.app! < y.api! && y.api! < y.core! && y.core! < y.util!);
});

test('a cycle is broken at one edge, so its members still spread over layers', () => {
  const y = yOf(graphOf(['app', 'a', 'b', 'base'], [['app', 'a'], ['a', 'b'], ['b', 'a'], ['b', 'base']]));
  // Only b->a can point up; everything else keeps importer above imported.
  assert.ok(y.app! < y.a! && y.a! < y.b! && y.b! < y.base!);
});

test('a large cycle does not collapse onto one row', () => {
  const ring = ['a', 'b', 'c', 'd', 'e', 'f'];
  const pairs = ring.map((id, index) => [id, ring[(index + 1) % ring.length]!] as [string, string]);
  const rows = new Set(Object.values(yOf(graphOf(ring, pairs))));
  assert.ok(rows.size >= 3);
});

test('a long chain is folded into rows that keep the map wider than it is tall', () => {
  const chain = Array.from({ length: 20 }, (_, index) => `n${String(index).padStart(2, '0')}`);
  const pairs = chain.slice(1).map((id, index) => [chain[index]!, id] as [string, string]);
  const y = yOf(graphOf(chain, pairs));
  // Rows sit 150 apart; a zigzag shifts nodes within a row by less than that.
  assert.ok(new Set(Object.values(y).map((value) => Math.floor(value / 150))).size <= 4);
  // Folding keeps the order: nothing lands above what imports it.
  for (const [source, target] of pairs) assert.ok(Math.floor(y[source]! / 150) <= Math.floor(y[target]! / 150));
});

test('nodes with no edges stand in a column to the right of the rest', () => {
  const positions = buildLayeredPositions(graphOf(['a', 'b', 'lonely', 'solo'], [['a', 'b']]));
  const at = Object.fromEntries(positions.map((position) => [position.id, position]));
  assert.ok(at.lonely!.x > Math.max(at.a!.x, at.b!.x));
  assert.equal(at.lonely!.x, at.solo!.x);
  assert.notEqual(at.lonely!.y, at.solo!.y);
});

test('barycentre ordering keeps a chain straight rather than crossed', () => {
  // Two parallel chains: left1->left2 and right1->right2. Uncrossed, left2 stays left of right2.
  const positions = buildLayeredPositions(
    graphOf(['l1', 'l2', 'r1', 'r2'], [['l1', 'l2'], ['r1', 'r2']]),
  );
  const x = Object.fromEntries(positions.map((position) => [position.id, position.x]));
  assert.equal(Math.sign(x.l1! - x.r1!), Math.sign(x.l2! - x.r2!));
});

test('the layout is deterministic and gives every node one position', () => {
  const graph = graphOf(['c', 'a', 'b'], [['a', 'b'], ['b', 'c']]);
  const first = buildLayeredPositions(graph);
  assert.deepEqual(first, buildLayeredPositions(graph));
  assert.deepEqual(first.map((position) => position.id), ['a', 'b', 'c']);
});

test('a wide row wraps into even parts rather than leaving one node alone', () => {
  const leaves = Array.from({ length: 9 }, (_, index) => `leaf${index}`);
  const y = yOf(graphOf(['root', ...leaves], leaves.map((leaf) => ['root', leaf] as [string, string])));
  const counts = new Map<number, number>();
  for (const leaf of leaves) counts.set(y[leaf]!, (counts.get(y[leaf]!) ?? 0) + 1);
  assert.deepEqual([...counts.values()].sort(), [4, 5]);
});

test('a row whose nodes import each other zigzags, and one without such edges stays straight', () => {
  const straight = yOf(graphOf(['top', 'a', 'b', 'c'], [['top', 'a'], ['top', 'b'], ['top', 'c']]));
  assert.equal(new Set([straight.a, straight.b, straight.c]).size, 1);
  // A 12-deep chain folds into 4 rows, so each row holds links of the chain: it zigzags.
  const chain = Array.from({ length: 12 }, (_, index) => `n${String(index).padStart(2, '0')}`);
  const pairs = chain.slice(1).map((id, index) => [chain[index]!, id] as [string, string]);
  const positions = buildLayeredPositions(graphOf(chain, pairs));
  const rowOf = (y: number) => Math.floor(y / 150);
  const byRow = new Map<number, number[]>();
  for (const position of positions) {
    const list = byRow.get(rowOf(position.y)) ?? [];
    list.push(position.y);
    byRow.set(rowOf(position.y), list);
  }
  assert.ok([...byRow.values()].some((ys) => new Set(ys).size > 1));
});
