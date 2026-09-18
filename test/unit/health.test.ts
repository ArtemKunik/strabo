import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeArchitectureHealth } from '../../src/analysis/health.ts';
import type { Graph } from '../../src/types.ts';

function graph(nodes: Graph['nodes'], edges: Graph['edges']): Graph {
  return { nodes, edges, diagnostics: [], excluded: [] };
}

function edge(source: string, target: string): Graph['edges'][number] {
  return { source, target, kind: 'import', evidence: { line: 1, specifier: target, resolution: 'exact' } };
}

const sample = graph(
  [
    { id: 'src/a.ts', kind: 'module', directory: 'src' },
    { id: 'src/b.ts', kind: 'module', directory: 'src' },
    { id: 'lib/c.ts', kind: 'module', directory: 'lib' },
    { id: 'lib/d.ts', kind: 'module', directory: 'lib' },
    { id: 'tests/a.test.ts', kind: 'test', directory: 'tests' },
  ],
  [
    edge('tests/a.test.ts', 'src/a.ts'),
    edge('src/a.ts', 'src/b.ts'),
    edge('src/b.ts', 'lib/c.ts'),
    edge('lib/c.ts', 'lib/d.ts'),
  ],
);

test('computeArchitectureHealth derives each axis from explainable values', () => {
  const report = computeArchitectureHealth(sample);
  const axis = (key: string) => report.axes.find((entry) => entry.key === key);

  assert.equal(axis('lowCoupling')?.value, 92);
  assert.equal(axis('lowFanOut')?.value, 96);
  assert.equal(axis('lowComplexity')?.value, 100);
  assert.equal(axis('cohesion')?.value, 50);
  assert.equal(axis('coverage')?.value, 100);
  assert.match(axis('coverage')?.detail ?? '', /4 of 4 modules reachable from tests/);
  assert.equal(report.score, 88);
});

test('coverage is unavailable when the scan found no tests', () => {
  const report = computeArchitectureHealth(
    graph(
      [
        { id: 'src/a.ts', kind: 'module', directory: 'src' },
        { id: 'src/b.ts', kind: 'module', directory: 'src' },
      ],
      [edge('src/a.ts', 'src/b.ts')],
    ),
  );
  const coverage = report.axes.find((entry) => entry.key === 'coverage');

  assert.equal(coverage?.value, null);
  assert.match(coverage?.detail ?? '', /no test files identified/);
  // The score still averages the axes that could be derived.
  assert.ok(typeof report.score === 'number');
});
