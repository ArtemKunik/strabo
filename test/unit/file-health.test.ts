import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeFileHealth } from '../../src/index.ts';
import type { CodeSymbol, MemberAccess } from '../../src/index.ts';
import type { Graph } from '../../src/index.ts';

const node = (id: string, kind: 'module' | 'test' = 'module') => ({
  id,
  kind,
  directory: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '.',
});

const edge = (source: string, target: string) => ({
  source,
  target,
  kind: 'import' as const,
  evidence: { line: 1, specifier: target, resolution: 'exact' as const },
});

const graph: Graph = {
  nodes: [node('src/a.ts'), node('src/b.ts'), node('src/a.test.ts', 'test')],
  edges: [edge('src/b.ts', 'src/a.ts'), edge('src/a.test.ts', 'src/a.ts')],
};

const symbol = (partial: Partial<CodeSymbol> & Pick<CodeSymbol, 'name' | 'kind'>): CodeSymbol => ({
  visibility: 'public',
  owner: 'Main',
  line: 1,
  ...partial,
});

const symbols: CodeSymbol[] = [
  symbol({ name: 'Main', kind: 'type', owner: '' }),
  symbol({ name: 'count', kind: 'field' }),
  symbol({ name: 'name', kind: 'field' }),
  symbol({ name: 'temp', kind: 'field' }),
  symbol({ name: 'orphan', kind: 'field' }),
  symbol({ name: 'greet', kind: 'method' }),
  symbol({ name: 'compute', kind: 'method' }),
];

const accesses: MemberAccess[] = [
  { owner: 'Main', method: 'greet', field: 'count', mode: 'read', qualified: true, line: 1 },
  { owner: 'Main', method: 'greet', field: 'count', mode: 'write', qualified: true, line: 1 },
  { owner: 'Main', method: 'greet', field: 'name', mode: 'read', qualified: false, line: 2 },
  { owner: 'Main', method: 'compute', field: 'name', mode: 'read', qualified: false, line: 3 },
  { owner: 'Main', method: 'compute', field: 'temp', mode: 'write', qualified: false, line: 4 },
];

function axisValue(report: ReturnType<typeof computeFileHealth>, key: string): number | null {
  return report.axes.find((axis) => axis.key === key)?.value ?? null;
}

test('computeFileHealth scopes the graph axes and counts connections and blast radius', () => {
  const report = computeFileHealth(graph, 'src/a.ts', symbols, accesses);

  assert.equal(report.found, true);
  assert.deepEqual(report.metrics, { directImports: 0, directImporters: 2, blastRadius: 2 });
  assert.equal(axisValue(report, 'lowCoupling'), 83);
  assert.equal(axisValue(report, 'lowFanOut'), 100);
  assert.equal(axisValue(report, 'lowComplexity'), 100);
  assert.equal(axisValue(report, 'coverage'), 100);
  assert.equal(report.score, 93);
});

test('cohesion is derived from member wiring, and an unconnected field lowers it', () => {
  const report = computeFileHealth(graph, 'src/a.ts', symbols, accesses);
  const cohesion = report.axes.find((axis) => axis.key === 'cohesion');

  assert.equal(cohesion?.value, 80);
  assert.match(cohesion?.detail ?? '', /2 cluster\(s\) across 6 member\(s\)/);

  const fieldsOnly = symbols.filter((entry) => entry.kind === 'field');
  const noMethods = computeFileHealth(graph, 'src/a.ts', fieldsOnly, []);
  const noMethodCohesion = noMethods.axes.find((axis) => axis.key === 'cohesion');
  assert.equal(noMethodCohesion?.value, null, 'a data-only type is unavailable, not scored 0');
  assert.match(noMethodCohesion?.detail ?? '', /no methods wire them/);
});

test('cohesion is unavailable when no members were recorded', () => {
  const report = computeFileHealth(graph, 'src/a.ts', [], []);
  const cohesion = report.axes.find((axis) => axis.key === 'cohesion');

  assert.equal(cohesion?.value, null);
  assert.equal(cohesion?.detail, 'no members recorded');
});

test('coverage reports a test file and is unavailable without tests', () => {
  const testFile = computeFileHealth(graph, 'src/a.test.ts');
  assert.equal(axisValue(testFile, 'coverage'), 100);

  const noTests: Graph = {
    nodes: [node('src/a.ts'), node('src/b.ts')],
    edges: [edge('src/b.ts', 'src/a.ts')],
  };
  const report = computeFileHealth(noTests, 'src/a.ts');
  const coverage = report.axes.find((axis) => axis.key === 'coverage');
  assert.equal(coverage?.value, null);
  assert.equal(coverage?.detail, 'no test files identified');
});

test('a file outside the graph keeps its graph axes unavailable rather than zero', () => {
  const report = computeFileHealth(graph, 'src/missing.ts', symbols, accesses);

  assert.equal(report.found, false);
  assert.deepEqual(report.metrics, { directImports: 0, directImporters: 0, blastRadius: 0 });
  assert.equal(axisValue(report, 'lowCoupling'), null);
  assert.equal(axisValue(report, 'coverage'), null);
  assert.equal(axisValue(report, 'cohesion'), 80);
  assert.equal(report.score, 80);
});
