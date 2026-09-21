import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildAdjacency, computeGraphMetrics } from '../../src/analysis/analysis.ts';
import { computeReadingRoute, detectEntryPoints, scanRepository } from '../../src/index.ts';
import type { Graph } from '../../src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * The system-view fixture is the polyglot one: a Gradle app, two Cargo crates, and an npm
 * package in one repository, with `crates/alpha/src/main.rs` the only declared entry point.
 */
const fixture = path.resolve(here, '..', 'fixtures', 'system-repo');
const polyglot = path.resolve(here, '..', 'fixtures', 'polyglot-repo');

const created: string[] = [];

after(() => {
  for (const directory of created) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // The OS will reclaim the temp directory.
    }
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-route-'));
  created.push(directory);
  return directory;
}

function write(root: string, file: string, content: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

/** The recorded use edges: a `declare` edge is the module tree and a call edge parallels an import. */
function useEdges(graph: Graph): Array<{ source: string; target: string }> {
  return graph.edges
    .filter((edge) => edge.role !== 'declare' && edge.kind !== 'call')
    .map((edge) => ({ source: edge.source, target: edge.target }));
}

test('the polyglot route starts at every declared entry point', async () => {
  const graph = (await scanRepository(fixture)).graph;
  const declared = detectEntryPoints(fixture, graph.nodes.map((node) => node.id));
  assert.ok(declared.length > 0, 'the fixture should declare at least one entry point');

  const route = computeReadingRoute(fixture, 'system-repo', graph);

  // Every declared entry point is a routed file, at depth 0, reached from nothing recorded.
  for (const entry of declared) {
    const step = route.order.find((candidate) => candidate.file === entry.file);
    assert.ok(step, `${entry.file} should be routed`);
    assert.equal(step.depth, 0);
    assert.equal(step.from, null);
    assert.equal(step.entryPoint, true);
    assert.equal(step.entry, entry.file);
  }
  // The walk starts at the entry point, not merely contains it.
  assert.equal(route.order[0]?.file, declared[0]?.file);
  // The flat order is the merge of the per-unit routes, nothing dropped or invented.
  assert.deepEqual(
    route.order.map((step) => step.file).sort(),
    route.units.flatMap((unit) => unit.files.map((step) => step.file)).sort(),
  );
});

test('no file appears before a file that imports it within the same unit', async () => {
  const graph = (await scanRepository(fixture)).graph;
  const route = computeReadingRoute(fixture, 'system-repo', graph);

  const unitOf = new Map(route.order.map((step) => [step.file, step.unit]));
  const indexIn = (files: string[]): Map<string, number> =>
    new Map(files.map((file, index) => [file, index]));

  const flatIndex = indexIn(route.order.map((step) => step.file));
  for (const edge of useEdges(graph)) {
    const sourceUnit = unitOf.get(edge.source);
    const targetUnit = unitOf.get(edge.target);
    // The invariant is per unit: a cross-unit edge makes no ordering claim here.
    if (!sourceUnit || sourceUnit !== targetUnit) {
      continue;
    }
    const sourceIndex = flatIndex.get(edge.source);
    const targetIndex = flatIndex.get(edge.target);
    if (sourceIndex === undefined || targetIndex === undefined) {
      continue;
    }
    assert.ok(
      sourceIndex < targetIndex,
      `${edge.source} imports ${edge.target} but appears after it in the ${sourceUnit} route`,
    );
  }

  // The same holds inside each unit route, which is the list the panel steps through.
  for (const unit of route.units) {
    const unitIndex = indexIn(unit.files.map((step) => step.file));
    for (const edge of useEdges(graph)) {
      if (unitOf.get(edge.source) !== unit.summary.id || unitOf.get(edge.target) !== unit.summary.id) {
        continue;
      }
      const sourceIndex = unitIndex.get(edge.source);
      const targetIndex = unitIndex.get(edge.target);
      if (sourceIndex === undefined || targetIndex === undefined) {
        continue;
      }
      assert.ok(sourceIndex < targetIndex, `${unit.summary.id}: ${edge.source} after ${edge.target}`);
    }
  }
});

test('files no entry point reaches are separated, not forced into the order', async () => {
  const graph = (await scanRepository(fixture)).graph;
  const route = computeReadingRoute(fixture, 'system-repo', graph);

  // The dependency of `web` is recorded, but `web` itself is unreached, so neither routes.
  const orderSet = new Set(route.order.map((step) => step.file));
  for (const file of ['lib/src/util.ts', 'web/src/app.ts', 'crates/beta/src/lib.rs']) {
    assert.ok(!orderSet.has(file), `${file} should not be in the route order`);
    assert.ok(
      route.unreached.some((candidate) => candidate.file === file),
      `${file} should be in the unreached list`,
    );
  }

  // Routing and unreached partition the graph exactly.
  assert.equal(route.summary.routed + route.summary.unreached, graph.nodes.length);
  assert.equal(route.summary.routed, route.order.length);
});

test('each routed file names a recorded importer and its recorded fan-in', async () => {
  const graph = (await scanRepository(fixture)).graph;
  const route = computeReadingRoute(fixture, 'system-repo', graph);
  const edges = new Set(useEdges(graph).map((edge) => `${edge.source}\u0000${edge.target}`));
  const metrics = computeGraphMetrics(
    { ...graph, edges: graph.edges.filter((edge) => edge.role !== 'declare' && edge.kind !== 'call') },
    buildAdjacency({
      ...graph,
      edges: graph.edges.filter((edge) => edge.role !== 'declare' && edge.kind !== 'call'),
    }),
  );

  for (const step of route.order) {
    if (step.from === null) {
      assert.equal(step.depth, 0);
      continue;
    }
    assert.ok(
      edges.has(`${step.from}\u0000${step.file}`),
      `${step.file} claims to be reached from ${step.from}, which does not import it`,
    );
    assert.equal(step.depth > 0, true);
  }
  for (const step of route.order) {
    assert.equal(step.fanIn, metrics.fanIn.get(step.file) ?? 0);
  }
});

test('the route groups by unit with a summary before its files (W2)', async () => {
  const graph = (await scanRepository(fixture)).graph;
  const route = computeReadingRoute(fixture, 'system-repo', graph);

  const alpha = route.units.find((unit) => unit.summary.id === 'crates/alpha');
  assert.ok(alpha, 'the entry point unit should have a route');
  assert.equal(alpha.summary.entryPoints, 1);
  assert.equal(alpha.summary.routed, alpha.files.length);
  assert.equal(alpha.summary.unreached, alpha.unreached.length);
  assert.equal(alpha.files[0]?.file, 'crates/alpha/src/main.rs');
  // A unit with no entry point still appears, with all its files unreached.
  const beta = route.units.find((unit) => unit.summary.id === 'crates/beta');
  assert.equal(beta?.files.length, 0);
  assert.equal(beta?.unreached.length, 1);
});

test('a single-unit repository with only the root fallback still routes', () => {
  const root = tempDir();
  write(root, 'src/index.ts', "import { util } from './util';\nexport const index = util;\n");
  write(root, 'src/util.ts', 'export function util() {\n  return 1;\n}\n');

  const graph: Graph = {
    nodes: [
      { id: 'src/index.ts', kind: 'module', directory: 'src' },
      { id: 'src/util.ts', kind: 'module', directory: 'src' },
    ],
    edges: [
      {
        source: 'src/index.ts',
        target: 'src/util.ts',
        kind: 'import',
        evidence: { line: 1, specifier: './util', resolution: 'exact' },
      },
    ],
    diagnostics: [],
    excluded: [],
  };
  const route = computeReadingRoute(root, 'solo', graph, {
    entryPoints: [{ file: 'src/index.ts', reason: 'test entry', source: 'test' }],
  });

  assert.equal(route.units.length, 1);
  assert.equal(route.units[0]?.summary.id, '.');
  assert.deepEqual(route.order.map((step) => step.file), ['src/index.ts', 'src/util.ts']);
  assert.equal(route.unreached.length, 0);
});

test('a route with no declared entry point returns an empty order and all files unreached', async () => {
  const graph = (await scanRepository(polyglot)).graph;
  const route = computeReadingRoute(polyglot, 'polyglot-repo', graph);

  assert.equal(route.entryPoints.length, 0);
  assert.equal(route.order.length, 0);
  assert.equal(route.unreached.length, graph.nodes.length);
  assert.equal(route.summary.routed, 0);
});

test('a cyclic reach still routes every file once', () => {
  const root = tempDir();
  const graph: Graph = {
    nodes: ['a.ts', 'b.ts'].map((id) => ({ id, kind: 'module' as const, directory: '.' })),
    edges: [
      { source: 'a.ts', target: 'b.ts', kind: 'import', evidence: { line: 1, specifier: 'b', resolution: 'exact' } },
      { source: 'b.ts', target: 'a.ts', kind: 'import', evidence: { line: 1, specifier: 'a', resolution: 'exact' } },
    ],
    diagnostics: [],
    excluded: [],
  };
  const route = computeReadingRoute(root, 'cycle', graph, {
    entryPoints: [{ file: 'a.ts', reason: 'test entry', source: 'test' }],
  });

  assert.equal(route.order.length, 2);
  assert.equal(new Set(route.order.map((step) => step.file)).size, 2);
  // The declared entry point is seeded first even though the cycle imports it back.
  assert.equal(route.order[0]?.file, 'a.ts');
});
