import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseWhatIfOperations, simulateWhatIf, WHAT_IF_SPECIFIER } from '../../src/analysis/what-if.ts';
import type { SystemUnit } from '../../src/analysis/units.ts';
import type { Graph, GraphEdge } from '../../src/types.ts';

function edge(source: string, target: string, line = 1): GraphEdge {
  return { source, target, kind: 'import', evidence: { line, specifier: `./${target}`, resolution: 'exact' } };
}

function graphOf(ids: string[], edges: GraphEdge[]): Graph {
  return {
    nodes: ids.map((id) => ({
      id,
      kind: id.includes('.test.') ? 'test' : 'source',
      directory: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '.',
    })) as Graph['nodes'],
    edges,
    diagnostics: [],
    excluded: [],
  };
}

const unit = (id: string): SystemUnit =>
  ({ id, name: id, ecosystem: 'npm', manifest: `${id}/package.json`, parent: null, why: 'test' }) as SystemUnit;

test('adding an edge that closes a loop introduces a cycle and grows the blast radius', () => {
  const graph = graphOf(['a.ts', 'b.ts', 'c.ts'], [edge('a.ts', 'b.ts'), edge('b.ts', 'c.ts')]);
  const result = simulateWhatIf(graph, [{ op: 'add', source: 'c.ts', target: 'a.ts' }]);

  assert.equal(result.hypothetical, true);
  assert.deepEqual(result.cyclesIntroduced.map((cycle) => cycle.members), [['a.ts', 'b.ts', 'c.ts']]);
  assert.deepEqual(result.edgesAdded, [{ source: 'c.ts', target: 'a.ts', kind: 'import' }]);
  assert.deepEqual(
    result.reach.find((entry) => entry.file === 'c.ts'),
    { file: 'c.ts', before: 2, after: 2 },
  );
  assert.deepEqual(result.reach.find((entry) => entry.file === 'a.ts'), { file: 'a.ts', before: 0, after: 2 });
  // The recorded graph is never mutated.
  assert.equal(graph.edges.length, 2);
});

test('cutting the edge behind a cycle resolves it, and a cut with no edge is rejected', () => {
  const graph = graphOf(['a.ts', 'b.ts'], [edge('a.ts', 'b.ts'), edge('b.ts', 'a.ts')]);
  const result = simulateWhatIf(graph, [
    { op: 'cut', source: 'b.ts', target: 'a.ts' },
    { op: 'cut', source: 'b.ts', target: 'a.ts' },
  ]);

  assert.equal(result.counts.cyclesResolved, 1);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.rejected.map((entry) => entry.reason), ['no recorded edge joins these files']);
});

test('a move reports only what it changes, not every edge it renamed', () => {
  const graph = graphOf(['src/words/a.ts', 'src/words/b.ts', 'src/app.ts'], [
    edge('src/app.ts', 'src/words/a.ts'),
    edge('src/words/a.ts', 'src/words/b.ts'),
  ]);
  const result = simulateWhatIf(graph, [{ op: 'move', from: 'src/words', to: 'packages/words' }]);

  assert.deepEqual(result.moved, [
    { from: 'src/words/a.ts', to: 'packages/words/a.ts' },
    { from: 'src/words/b.ts', to: 'packages/words/b.ts' },
  ]);
  assert.equal(result.counts.edgesAdded, 0);
  assert.equal(result.counts.edgesRemoved, 0);
  assert.equal(result.applied[0]?.count, 2);
});

test('a move onto an existing file, or of a path no file sits under, is rejected', () => {
  const graph = graphOf(['a.ts', 'b.ts'], []);
  const result = simulateWhatIf(graph, [
    { op: 'move', from: 'a.ts', to: 'b.ts' },
    { op: 'move', from: 'nowhere', to: 'x' },
  ]);

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.rejected.map((entry) => entry.reason), [
    '"b.ts" is already a scanned file',
    'no scanned file is at or under "nowhere"',
  ]);
});

test('a wrong-way tier edge is introduced by an add and left behind by a move into another unit', () => {
  const graph = graphOf(['app/ui.ts', 'app/repo.ts'], [edge('app/ui.ts', 'app/repo.ts')]);
  const tierOf = new Map([
    ['app/ui.ts', 'frontend' as const],
    ['app/repo.ts', 'data' as const],
  ]);
  const units = [unit('app'), unit('lib')];

  const added = simulateWhatIf(graph, [{ op: 'add', source: 'app/repo.ts', target: 'app/ui.ts' }], { tierOf, units });
  assert.deepEqual(
    added.tiers.introduced.map((direction) => [direction.source, direction.target, direction.kind]),
    [['app/repo.ts', 'app/ui.ts', 'upward']],
  );

  // Directions count only inside one unit, so moving one end out drops the pair.
  const withUpward = graphOf(['app/ui.ts', 'app/repo.ts'], [edge('app/repo.ts', 'app/ui.ts')]);
  const moved = simulateWhatIf(withUpward, [{ op: 'move', from: 'app/repo.ts', to: 'lib/repo.ts' }], {
    tierOf,
    units,
  });
  assert.deepEqual(
    moved.tiers.resolved.map((direction) => [direction.source, direction.target]),
    [['lib/repo.ts', 'app/ui.ts']],
  );
  assert.deepEqual(moved.tiers.introduced, []);
});

test('declared rules are checked on the edited graph, with recorded violations mapped through moves', () => {
  const graph = graphOf(['domain/a.ts', 'infra/db.ts'], []);
  const rules = [{ id: 'domain-no-infra', from: 'domain/**', to: 'infra/**', allow: 'never' as const }];
  const result = simulateWhatIf(graph, [{ op: 'add', source: 'domain/a.ts', target: 'infra/db.ts' }], { rules });

  assert.equal(result.rules.available, true);
  assert.deepEqual(result.rules.introduced.map((violation) => violation.edge.specifier), [WHAT_IF_SPECIFIER]);

  const unavailable = simulateWhatIf(graph, []);
  assert.equal(unavailable.rules.available, false);
  assert.equal(unavailable.tiers.available, false);
});

test('cutting the only edge from a test reports the file as no longer reached', () => {
  const graph = graphOf(['a.test.ts', 'a.ts'], [edge('a.test.ts', 'a.ts')]);
  const result = simulateWhatIf(graph, [{ op: 'cut', source: 'a.test.ts', target: 'a.ts' }]);
  assert.deepEqual(result.newlyUnreached, ['a.ts']);
});

test('malformed operations are rejected with the shape they should take', () => {
  const parsed = parseWhatIfOperations([
    { op: 'cut', source: './a.ts', target: 'b.ts' },
    { op: 'move', from: 'src\\words\\' },
    'nonsense',
  ]);
  assert.deepEqual(parsed.operations, [{ op: 'cut', source: 'a.ts', target: 'b.ts' }]);
  assert.equal(parsed.rejected.length, 2);
  assert.equal(parseWhatIfOperations({}).rejected[0]?.reason, 'operations must be an array');
});
