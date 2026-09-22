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
import { computeCoverage } from '../../src/index.ts';
import { computeCycles } from '../../src/index.ts';
import { buildPositions } from '../../src/index.ts';
import { buildSystemPositions } from '../../src/index.ts';
import { scanRepository } from '../../src/index.ts';

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

test('buildSystemPositions orders units left-to-right by dependency depth', () => {
  const units = [{ id: 'app' }, { id: 'lib' }, { id: 'core' }];
  const edges = [
    { source: 'app', target: 'lib' },
    { source: 'lib', target: 'core' },
  ];
  const x = new Map(buildSystemPositions(units, edges).map((position) => [position.id, position.x]));
  assert.ok((x.get('core') as number) < (x.get('lib') as number));
  assert.ok((x.get('lib') as number) < (x.get('app') as number));
});

test('buildSystemPositions terminates on a cycle and places every unit once', () => {
  const units = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'a' },
  ];
  const positions = buildSystemPositions(units, edges);
  assert.equal(positions.length, 3);
  assert.equal(new Set(positions.map((position) => position.id)).size, 3);
  assert.deepEqual(buildSystemPositions(units, edges), positions);
});

test('buildSystemPositions wraps a wide rank into a compact block', () => {
  const units = Array.from({ length: 20 }, (_, index) => ({
    id: `u${String(index).padStart(2, '0')}`,
  }));
  const positions = buildSystemPositions(units, []);
  const xs = positions.map((position) => position.x);
  const ys = positions.map((position) => position.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  assert.ok(width > 0 && height > 0, 'a wide rank should not collapse to a single line');
  assert.ok(height <= 5 * 300, `a rank should cap its rows, got height ${height}`);
  assert.equal(new Set(positions.map((position) => `${position.x},${position.y}`)).size, positions.length);
});

test('buildAdjacency leaves declare edges out of blast radius unless asked', () => {
  const nodes = ['src/lib.rs', 'src/a.rs', 'src/b.rs', 'app/main.rs'].map((id) => ({
    id,
    kind: 'module' as const,
    directory: id.slice(0, id.lastIndexOf('/')),
  }));
  const edges = [
    { source: 'src/lib.rs', target: 'src/a.rs', kind: 'namespace' as const, evidence: { line: 1, specifier: 'mod a', resolution: 'exact' as const }, role: 'declare' as const },
    { source: 'src/lib.rs', target: 'src/b.rs', kind: 'namespace' as const, evidence: { line: 2, specifier: 'mod b', resolution: 'exact' as const }, role: 'declare' as const },
    { source: 'app/main.rs', target: 'src/lib.rs', kind: 'import' as const, evidence: { line: 1, specifier: 'crate::a::A', resolution: 'module-tree' as const }, role: 'use' as const },
  ];
  const graph = { nodes, edges, diagnostics: [], excluded: [] };

  const counted = computeGraphMetrics(graph, buildAdjacency(graph));
  // `mod a;` alone does not make the crate root a dependent of a.rs.
  assert.equal(counted.transitiveDependents.get('src/a.rs'), 0);

  const withDeclare = computeGraphMetrics(graph, buildAdjacency(graph, { includeDeclare: true }));
  assert.equal(withDeclare.transitiveDependents.get('src/a.rs'), 2);
});

test('buildAdjacency collapses parallel edges to unique neighbours', () => {
  const nodes = ['src/a.ts', 'src/b.ts'].map((id) => ({
    id,
    kind: 'module' as const,
    directory: 'src',
  }));
  // A recorded call sits beside the import; a second import of the same target also
  // exists. Neither may make `.length` read as more than one neighbour.
  const edges = [
    { source: 'src/a.ts', target: 'src/b.ts', kind: 'import' as const, evidence: { line: 1, specifier: './b.ts', resolution: 'exact' as const }, role: 'use' as const },
    { source: 'src/a.ts', target: 'src/b.ts', kind: 'call' as const, evidence: { line: 4, specifier: 'b', resolution: 'exact' as const }, role: 'use' as const },
    { source: 'src/a.ts', target: 'src/b.ts', kind: 'import' as const, evidence: { line: 9, specifier: './b.ts', resolution: 'exact' as const }, role: 'use' as const },
  ];
  const graph = { nodes, edges, diagnostics: [], excluded: [] };

  const { forward, backward } = buildAdjacency(graph);
  assert.deepEqual(forward.get('src/a.ts'), ['src/b.ts']);
  assert.deepEqual(backward.get('src/b.ts'), ['src/a.ts']);
});
