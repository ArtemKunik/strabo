import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planExtraction } from '../../src/analysis/extraction.ts';
import type { StringEdgeReport } from '../../src/analysis/string-edges.ts';
import type { Graph, GraphEdge } from '../../src/types.ts';

function edge(source: string, target: string, line = 1, extra: Partial<GraphEdge> = {}): GraphEdge {
  return {
    source,
    target,
    kind: 'import',
    evidence: { line, specifier: `./${target}`, resolution: 'exact' },
    ...extra,
  };
}

function graphOf(ids: string[], edges: GraphEdge[], extra: Partial<Graph> = {}): Graph {
  return {
    nodes: ids.map((id) => ({ id, kind: 'source', directory: '.' })) as Graph['nodes'],
    edges,
    diagnostics: [],
    excluded: [],
    ...extra,
  };
}

const ids = ['words/a.ts', 'words/b.ts', 'shared/util.ts', 'shared/deep.ts', 'app/main.ts', 'app/other.ts'];

test('a bare directory selects its files; outward dependencies rank by how many selected files use them', () => {
  const graph = graphOf(ids, [
    edge('words/a.ts', 'shared/util.ts', 3),
    edge('words/b.ts', 'shared/util.ts', 4),
    edge('words/b.ts', 'app/other.ts', 5),
    edge('shared/util.ts', 'shared/deep.ts'),
    edge('app/main.ts', 'shared/util.ts'),
    edge('app/main.ts', 'words/a.ts', 9),
    edge('words/a.ts', 'words/b.ts'),
  ]);
  const plan = planExtraction(graph, ['words']);

  assert.deepEqual(plan.files, ['words/a.ts', 'words/b.ts']);
  assert.deepEqual(
    plan.dependencies.map((entry) => [entry.file, entry.importedBy.length, entry.pulls, entry.usedOutside]),
    [
      ['shared/util.ts', 2, 1, 1],
      ['app/other.ts', 1, 0, 0],
    ],
  );
  assert.deepEqual(plan.dependents.map((entry) => [entry.file, entry.importers]), [['words/a.ts', ['app/main.ts']]]);
  assert.deepEqual(plan.dependents[0]?.evidence, [
    { source: 'app/main.ts', target: 'words/a.ts', line: 9, specifier: './words/a.ts' },
  ]);
  assert.deepEqual(plan.closure, ['app/other.ts', 'shared/deep.ts', 'shared/util.ts']);
  assert.equal(plan.summary.selfContained, false);
});

test('calls and module declarations are not counted as dependencies', () => {
  const graph = graphOf(ids, [
    edge('words/a.ts', 'shared/util.ts', 1, { kind: 'call' }),
    edge('words/a.ts', 'shared/deep.ts', 1, { role: 'declare', relationship: 'module-declaration' }),
  ]);
  const plan = planExtraction(graph, ['words/**']);
  assert.deepEqual(plan.dependencies, []);
  assert.equal(plan.summary.selfContained, true);
});

test('a dependency imported only for its types is flagged as type-only', () => {
  const graph = graphOf(ids, [
    edge('words/a.ts', 'shared/util.ts', 1, { typeOnly: true }),
    edge('words/a.ts', 'shared/deep.ts', 2, { typeOnly: true }),
    edge('words/b.ts', 'shared/deep.ts', 3),
  ]);
  const plan = planExtraction(graph, ['words']);
  assert.deepEqual(
    plan.dependencies.map((entry) => [entry.file, entry.typeOnly]),
    [
      ['shared/deep.ts', false],
      ['shared/util.ts', true],
    ],
  );
});

test('a cycle across the boundary is named as a blocker, and an unmatched pattern is reported', () => {
  const graph = graphOf(ids, [edge('words/a.ts', 'app/main.ts'), edge('app/main.ts', 'words/a.ts')]);
  const plan = planExtraction(graph, ['words', 'wordz']);
  assert.deepEqual(plan.boundaryCycles, [{ id: 'app/main.ts', inside: ['words/a.ts'], outside: ['app/main.ts'] }]);
  assert.deepEqual(plan.unmatched, ['wordz']);
});

test('string edges with sites on both sides cross the boundary; external packages are listed', () => {
  const graph = graphOf(ids, [], {
    externalImports: [
      { file: 'words/a.ts', line: 1, specifier: 'lodash/fp', package: 'lodash', ecosystem: 'npm', kind: 'import' },
      { file: 'app/main.ts', line: 1, specifier: 'express', package: 'express', ecosystem: 'npm', kind: 'import' },
    ],
  } as Partial<Graph>);
  const stringEdges: StringEdgeReport = {
    available: true,
    env: [
      {
        kind: 'env',
        key: 'API_KEY',
        readers: [{ file: 'words/b.ts', line: 2 }, { file: 'app/main.ts', line: 7 }],
        declarations: [],
        declared: false,
      },
      {
        kind: 'env',
        key: 'ONLY_WORDS',
        readers: [{ file: 'words/b.ts', line: 3 }],
        declarations: [],
        declared: false,
      },
    ],
    routes: [],
    flags: [],
    diagnostics: [],
    totals: { env: 2, routes: 0, flags: 0, unresolved: 0 },
  };
  const plan = planExtraction(graph, ['words'], { stringEdges });

  assert.deepEqual(plan.stringCrossings.map((entry) => entry.key), ['API_KEY']);
  assert.deepEqual(plan.externalPackages, [{ package: 'lodash', ecosystem: 'npm', files: ['words/a.ts'] }]);
  assert.equal(plan.stringEdges.available, true);
});
