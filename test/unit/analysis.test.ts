import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildAdjacency,
  computeGraphMetrics,
  findDirectedPath,
  neighbourhood,
  rankHubs,
} from '../../src/analysis/analysis.ts';
import { computeCoverage } from '../../src/analysis/coverage.ts';
import { computeCycles } from '../../src/analysis/cycles.ts';
import { buildPositions } from '../../src/analysis/layout.ts';
import { scanRepository } from '../../src/scan/scan.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'sample-repo');

async function loadGraph() {
  return (await scanRepository(fixture)).graph;
}

test('computeGraphMetrics counts direct and transitive relationships', async () => {
  const graph = await loadGraph();
  const metrics = computeGraphMetrics(graph, buildAdjacency(graph));

  assert.equal(metrics.fanIn.get('src/util.ts'), 2);
  assert.equal(metrics.transitiveDependents.get('src/util.ts'), 3);
});

test('rankHubs puts the most depended-on file first', async () => {
  const graph = await loadGraph();
  const metrics = computeGraphMetrics(graph, buildAdjacency(graph));
  assert.equal(rankHubs(metrics)[0], 'src/util.ts');
});

test('findDirectedPath reports a path or explicitly no path', async () => {
  const graph = await loadGraph();
  assert.deepEqual(findDirectedPath(graph, 'src/index.ts', 'src/util.ts'), [
    'src/index.ts',
    'src/util.ts',
  ]);
  assert.equal(findDirectedPath(graph, 'src/util.ts', 'src/index.ts'), null);
});

test('neighbourhood returns the selected node and its immediate neighbours', async () => {
  const graph = await loadGraph();
  const ids = neighbourhood(graph, 'src/util.ts');
  assert.ok(ids.includes('src/util.ts'));
  assert.ok(ids.includes('src/index.ts'));
});

test('computeCycles finds circular coupling', async () => {
  const graph = await loadGraph();
  const groups = computeCycles(graph);
  const members = groups.flatMap((group) => group.members);
  assert.ok(members.includes('src/cycle-a.ts'));
  assert.ok(members.includes('src/cycle-b.ts'));
});

test('computeCoverage reports reachability from test files, not execution coverage', async () => {
  const graph = await loadGraph();
  const result = computeCoverage(graph);
  assert.ok(result.testFiles.includes('src/feature.test.ts'));
  assert.ok(result.reached.includes('src/feature.ts'));
  assert.ok(result.reached.includes('src/util.ts'));
});

test('buildPositions shelf-packs directories into a roughly rectangular map', () => {
  const nodes = [];
  for (let directory = 0; directory < 20; directory += 1) {
    const name = `dir${String(directory).padStart(2, '0')}`;
    const count = 5 + (directory % 11);
    for (let index = 0; index < count; index += 1) {
      nodes.push({ id: `${name}/file${index}.ts`, kind: 'module' as const, directory: name });
    }
  }
  const graph = { nodes, edges: [], diagnostics: [], excluded: [] };

  const positions = buildPositions(graph);
  const xs = positions.map((position) => position.x);
  const ys = positions.map((position) => position.y);
  const ratio = (Math.max(...xs) - Math.min(...xs)) / (Math.max(...ys) - Math.min(...ys));

  assert.equal(positions.length, nodes.length);
  assert.ok(ratio > 0.5 && ratio < 3, `aspect ratio ${ratio} should be roughly rectangular`);
  assert.equal(new Set(positions.map((position) => `${position.x},${position.y}`)).size, positions.length);
});

test('buildPositions is deterministic for equivalent graph input', async () => {
  const graph = await loadGraph();
  assert.deepEqual(buildPositions(graph), buildPositions(graph));
});
