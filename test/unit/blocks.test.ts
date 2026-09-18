import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildBlockViewModel } from '../../src/analysis/blocks.ts';
import { scanRepository } from '../../src/scan/scan.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'block-repo');

async function loadGraph() {
  return (await scanRepository(fixture)).graph;
}

function idsOf(model: { nodes: Array<{ id: string }> }): string[] {
  return model.nodes.map((node) => node.id).sort();
}

function pairsOf(model: { edges: Array<{ source: string; target: string }> }): string[] {
  return model.edges.map((edge) => `${edge.source}->${edge.target}`).sort();
}

test('depth 1 groups by top-level directory and puts root files in the root block', async () => {
  const graph = await loadGraph();
  const model = buildBlockViewModel(graph, { depth: 1 });

  assert.deepEqual(idsOf(model), ['.', 'lib', 'src', 'tests']);
  assert.ok(!model.nodes.some((node) => node.id.includes('.ts')));
});

test('a block is only a test block when every member is a test', async () => {
  const graph = await loadGraph();
  const model = buildBlockViewModel(graph, { depth: 1 });
  const kind = (id: string) => model.nodes.find((node) => node.id === id)?.kind;

  assert.equal(kind('tests'), 'test');
  assert.equal(kind('src'), 'module');
});

test('depth 2 merges deeper directories into their parent block', async () => {
  const graph = await loadGraph();
  const model = buildBlockViewModel(graph, { depth: 2 });

  assert.deepEqual(idsOf(model), ['.', 'lib', 'src', 'src/api', 'tests']);
});

test('self-loops are dropped and parallel edges are deduplicated', async () => {
  const graph = await loadGraph();
  const model = buildBlockViewModel(graph, { depth: 1 });

  assert.deepEqual(pairsOf(model), ['.->lib', '.->src', 'src->lib', 'tests->src']);
});

test('block metrics are computed on the aggregated graph', async () => {
  const graph = await loadGraph();
  const model = buildBlockViewModel(graph, { depth: 1 });
  const src = model.nodes.find((node) => node.id === 'src');

  assert.equal(src?.fanIn, 2);
  assert.equal(src?.fanOut, 1);
  assert.equal(src?.transitiveDependents, 2);
});

test('prefix drills into one directory and keeps block ids absolute', async () => {
  const graph = await loadGraph();
  const shallow = buildBlockViewModel(graph, { depth: 1, prefix: 'src' });
  const deeper = buildBlockViewModel(graph, { depth: 2, prefix: 'src' });

  assert.deepEqual(idsOf(shallow), ['src', 'src/api']);
  assert.deepEqual(pairsOf(shallow), ['src/api->src']);
  assert.deepEqual(idsOf(deeper), ['src', 'src/api', 'src/api/v2']);
  assert.deepEqual(pairsOf(deeper), ['src/api->src', 'src/api/v2->src/api']);
});

test('prefix with trailing slash and backslashes is normalised', async () => {
  const graph = await loadGraph();
  const a = buildBlockViewModel(graph, { depth: 1, prefix: 'src/' });
  const b = buildBlockViewModel(graph, { depth: 1, prefix: 'src\\' });

  assert.deepEqual(idsOf(a), idsOf(b));
  assert.deepEqual(pairsOf(a), pairsOf(b));
});

test('depth clamps to available segments without turning files into blocks', async () => {
  const graph = await loadGraph();
  const model = buildBlockViewModel(graph, { depth: 99, prefix: 'src/api' });

  assert.deepEqual(idsOf(model), ['src/api', 'src/api/v2']);
});

test('positions are deterministic and every node has one', async () => {
  const graph = await loadGraph();
  const model = buildBlockViewModel(graph, { depth: 1 });
  const positionIds = model.positions.map((position) => position.id).sort();

  assert.deepEqual(positionIds, idsOf(model));
  assert.deepEqual(model.positions, buildBlockViewModel(graph, { depth: 1 }).positions);
});
