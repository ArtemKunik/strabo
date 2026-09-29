import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildAdjacency,
  clearAnalysisCache,
  computeGraphMetrics,
  reachableSize,
} from '../../src/analysis/analysis.ts';
import { condense, transitiveReach } from '../../src/analysis/reachability.ts';
import type { Graph } from '../../src/types.ts';

/** A graph from `{ id: [targets] }`; ids are their own directory. */
function graphOf(edges: Record<string, string[]>): Graph {
  const ids = new Set(Object.keys(edges));
  for (const targets of Object.values(edges)) {
    for (const target of targets) {
      ids.add(target);
    }
  }
  return {
    nodes: [...ids].sort().map((id) => ({ id, kind: 'module' as const, directory: '.' })),
    edges: Object.entries(edges).flatMap(([source, targets]) =>
      targets.map((target) => ({
        source,
        target,
        kind: 'import' as const,
        evidence: { line: 1, specifier: target, resolution: 'exact' as const },
      })),
    ),
    diagnostics: [],
    excluded: [],
  };
}

/** The DFS baseline for one direction, as a plain map. */
function dfsCounts(graph: Graph, direction: 'forward' | 'backward'): Map<string, number> {
  const adjacency = buildAdjacency(graph);
  const map = direction === 'forward' ? adjacency.forward : adjacency.backward;
  return new Map(graph.nodes.map((node) => [node.id, reachableSize(node.id, map)]));
}

test('condense groups a cycle into one component and keeps the rest singletons', () => {
  const graph = graphOf({ a: ['b'], b: ['a'], c: ['a'], d: ['c'] });
  const adjacency = buildAdjacency(graph);
  const condensed = condense(graph.nodes.map((node) => node.id), adjacency.forward);

  // a and b are strongly connected; c and d are their own components.
  const componentOfA = condensed.componentOf.get('a');
  assert.equal(condensed.componentOf.get('b'), componentOfA);
  assert.notEqual(condensed.componentOf.get('c'), componentOfA);
  const group = condensed.members[componentOfA!] ?? [];
  assert.deepEqual(group, ['a', 'b']);
});

test('the bitset reachability equals the DFS for transitive dependencies and dependents', () => {
  const graph = graphOf({
    a: ['b'],
    b: ['a', 'c'],
    c: ['d'],
    d: [],
    e: ['a', 'd'],
    f: ['f'],
  });
  const adjacency = buildAdjacency(graph);
  const ids = graph.nodes.map((node) => node.id);

  const forwardBitset = transitiveReach(ids, adjacency.forward, { force: true });
  const backwardBitset = transitiveReach(ids, adjacency.backward, { force: true });
  assert.ok(forwardBitset && backwardBitset, 'the forced bitset path should run');

  assert.deepEqual(forwardBitset, dfsCounts(graph, 'forward'));
  assert.deepEqual(backwardBitset, dfsCounts(graph, 'backward'));
});

test('computeGraphMetrics matches between the DFS and the forced bitset path', () => {
  const graph = graphOf({
    a: ['b', 'c'],
    b: ['d'],
    c: ['d', 'e'],
    d: ['a'],
    e: ['f'],
    f: [],
    g: ['g'],
  });
  const adjacency = buildAdjacency(graph);
  const viaDfs = computeGraphMetrics(graph, adjacency);

  // Force the bitset path by driving the reach module directly, then compare per node.
  const ids = graph.nodes.map((node) => node.id);
  const forward = transitiveReach(ids, adjacency.forward, { force: true })!;
  const backward = transitiveReach(ids, adjacency.backward, { force: true })!;
  for (const node of graph.nodes) {
    assert.equal(forward.get(node.id), viaDfs.transitiveDependencies.get(node.id), `${node.id} dependencies`);
    assert.equal(backward.get(node.id), viaDfs.transitiveDependents.get(node.id), `${node.id} dependents`);
  }
});

test('a self-loop does not count as its own dependency', () => {
  const graph = graphOf({ a: ['a'], b: ['a'] });
  const adjacency = buildAdjacency(graph);
  const ids = graph.nodes.map((node) => node.id);
  const forward = transitiveReach(ids, adjacency.forward, { force: true })!;
  assert.equal(forward.get('a'), 0);
  assert.equal(forward.get('b'), 1);
});

test('a large acyclic chain exercises the real bitset path and matches the DFS', () => {
  // 300 nodes in a chain is past BITSET_MIN_COMPONENTS, so the metrics call uses the bitsets
  // without forcing: this asserts the production path, not only the forced one.
  const edges: Record<string, string[]> = {};
  for (let index = 0; index < 300; index += 1) {
    edges[`n${index}`] = index + 1 < 300 ? [`n${index + 1}`] : [];
  }
  const graph = graphOf(edges);
  const metrics = computeGraphMetrics(graph, buildAdjacency(graph));
  // A chain n0 → n1 → … → n299: n0 depends on all 299 after it, and n299 depends on none.
  assert.equal(metrics.transitiveDependencies.get('n0'), 299);
  assert.equal(metrics.transitiveDependents.get('n0'), 0);
  assert.equal(metrics.transitiveDependencies.get('n299'), 0);
  assert.equal(metrics.transitiveDependents.get('n299'), 299);
});

test('buildAdjacency and computeGraphMetrics memoise per graph without changing the result (P3)', () => {
  const graph = graphOf({ a: ['b'], b: ['c'], c: [] });
  const first = buildAdjacency(graph);
  const second = buildAdjacency(graph);
  assert.equal(first, second, 'the same graph returns the cached adjacency object');

  // The three adjacency variants are cached apart, so a re-export-aware read is not the default.
  const withReExports = buildAdjacency(graph, { includeReExports: true });
  assert.notEqual(withReExports, first);

  const metricsA = computeGraphMetrics(graph);
  const metricsB = computeGraphMetrics(graph);
  assert.equal(metricsA, metricsB, 'the same graph and adjacency return the cached metrics');
  // a → b → c: a depends on two nodes, and c is depended on by two.
  assert.equal(metricsB.transitiveDependencies.get('a'), 2);
  assert.equal(metricsB.transitiveDependents.get('c'), 2);

  // After a cache clear, a rebuild returns an equivalent but fresh object.
  clearAnalysisCache(graph);
  const rebuilt = buildAdjacency(graph);
  assert.notEqual(rebuilt, first);
  assert.deepEqual([...rebuilt.forward.entries()], [...first.forward.entries()]);
});

test('a dense large cycle condenses so members share one reach set', () => {
  // 300 nodes in one big cycle: one component, so every node reaches the other 299.
  const edges: Record<string, string[]> = {};
  for (let index = 0; index < 300; index += 1) {
    edges[`c${index}`] = [`c${(index + 1) % 300}`];
  }
  const graph = graphOf(edges);
  const metrics = computeGraphMetrics(graph, buildAdjacency(graph));
  for (const node of graph.nodes) {
    assert.equal(metrics.transitiveDependents.get(node.id), 299, node.id);
    assert.equal(metrics.transitiveDependencies.get(node.id), 299, node.id);
  }
});
