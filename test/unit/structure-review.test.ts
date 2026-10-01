import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { buildTierReport } from '../../src/analysis/tiers.ts';
import { scanRepository } from '../../src/index.ts';
import { isTypeOnlyStatement } from '../../src/scan/scan-js.ts';
import { buildStructureGridViewModel, buildStructureViewModel, buildViewModel } from '../../src/view/view-model.ts';
import { buildElements } from '../../ui/strabo-graph-elements.js';
import { isWrongWayEdge, structureWrongWayEvidence, wrongWayFlowsFor } from '../../ui/strabo-graph-facts.js';
import { graphSummary } from '../../ui/strabo-graph-summary.js';
import { fitLabel } from '../../ui/strabo-islands.js';

const root = path.resolve('test/fixtures/structure-repo');
const cache = { status: 'memory', fingerprint: 'x', artifactVersion: 1, generatedAt: new Date().toISOString(), stale: false } as never;
const descriptor = { name: 'structure-repo', root } as never;

test('buildViewModel carries the scanned revision so a removed file stays readable', async () => {
  const { graph, scannedAt } = await scanRepository(root);
  const scan = { graph, scannedAt } as never;
  const withRef = buildViewModel(root, scan, descriptor, { ...(cache as object), revision: 'abc1234' } as never);
  assert.equal(withRef.scannedRef, 'abc1234');

  const withoutRef = buildViewModel(root, scan, descriptor, cache);
  assert.equal(withoutRef.scannedRef, undefined);
});

test('isTypeOnlyStatement tells a type-only import or re-export from a value one', () => {
  assert.equal(isTypeOnlyStatement("import type { A } from './a'"), true);
  assert.equal(isTypeOnlyStatement("export type { A } from './a'"), true);
  assert.equal(isTypeOnlyStatement("import { type A, type B } from './a'"), true);
  assert.equal(isTypeOnlyStatement("import { type A, b } from './a'"), false);
  assert.equal(isTypeOnlyStatement("import A, { type B } from './a'"), false);
  assert.equal(isTypeOnlyStatement("import { a } from './a'"), false);
  assert.equal(isTypeOnlyStatement("import types from './types'"), false);
  assert.equal(isTypeOnlyStatement("import './side-effect'"), false);
});

test('every tier-flow edge lists the imports behind it, and the stack edge carries them', async () => {
  const { graph } = await scanRepository(root);
  const report = buildTierReport(root, 'structure-repo', graph);
  for (const edge of report.tierFlow.edges) {
    assert.equal(edge.imports?.length, Math.min(edge.weight, 50));
    assert.equal(edge.typeOnly, 0);
  }
  const model = buildStructureViewModel(report, descriptor, cache);
  const upward = model.edges.find((edge) => edge.tierKind === 'upward');
  assert.ok(upward, 'the fixture has an upward edge');
  assert.deepEqual(
    upward.tierImports?.map((entry) => `${entry.source}:${entry.line} → ${entry.target}`),
    ['orders/src/data/audit.ts:1 → orders/src/domain/orders.ts'],
  );
});

test('a type-only wrong-way edge is marked, labelled, and left out of the card count', async () => {
  const { graph } = await scanRepository(root);
  // The same repository, with the one upward import recorded as type-only.
  const typed = {
    ...graph,
    edges: graph.edges.map((edge) =>
      edge.source === 'orders/src/data/audit.ts' && edge.kind === 'import' ? { ...edge, typeOnly: true } : edge,
    ),
  };
  const model = buildStructureViewModel(buildTierReport(root, 'structure-repo', typed), descriptor, cache);
  const upward = model.edges.find((edge) => edge.tierKind === 'upward');
  assert.equal(upward?.typeOnlyCount, 1);
  const elements = buildElements(model);
  const drawn = elements.edges.find((edge) => edge.data.tierKind === 'upward');
  assert.match(drawn?.classes ?? '', /edge-type-only/);
  assert.equal(drawn?.data.label, '1 upward · types only');
  const data = elements.nodes.find((node) => node.data.id === 'data');
  assert.doesNotMatch(data?.data.label ?? '', /wrong-way/);
});

test('a baseline comparison reads card and edge deltas and keeps the edges a change removed', async () => {
  const { graph } = await scanRepository(root);
  const report = buildTierReport(root, 'structure-repo', graph);
  // The baseline: no frontend import yet, and a second upward import the change since removed.
  const extra = graph.edges.find((edge) => edge.source === 'orders/src/data/audit.ts' && edge.kind === 'import')!;
  const baselineGraph = {
    ...graph,
    edges: [
      ...graph.edges.filter((edge) => !(edge.source === 'web/src/ui/home.ts')),
      { ...extra, evidence: { ...extra.evidence, line: 9 } },
    ],
  };
  const baseline = buildTierReport(root, 'structure-repo', baselineGraph);
  const model = buildStructureViewModel(report, descriptor, cache, {
    baseline: { available: true, ref: 'HEAD~1', revision: 'abc1234', report: baseline },
  });
  const upward = model.edges.find((edge) => edge.tierKind === 'upward' && !edge.baselineOnly);
  assert.equal(upward?.weightDelta, -1);
  const added = model.edges.find((edge) => edge.source === 'frontend');
  assert.equal(added?.weightDelta, 1);
  assert.equal(model.structureBaseline?.available, true);
  assert.match(model.directoryLabels?.stack ?? '', /−1 wrong-way since HEAD~1/);

  const unavailable = buildStructureViewModel(report, descriptor, cache, {
    baseline: { available: false, ref: 'nope', detail: 'Unknown revision "nope".' },
  });
  assert.deepEqual(unavailable.structureBaseline, { available: false, ref: 'nope', detail: 'Unknown revision "nope".' });
  assert.ok(unavailable.edges.every((edge) => edge.weightDelta === undefined));
});

test('fitLabel sheds a stack verdict from the end before cutting the name', () => {
  const title = 'Architecture Stack — weakly layered · 2 upward · 96% same-tier';
  assert.equal(fitLabel(title, 2000), title);
  const narrow = fitLabel(title, 300);
  assert.ok(narrow.startsWith('Architecture Stack'), narrow);
  assert.ok(!narrow.includes('same-tier'), narrow);
});

test('the Structure grid folds same-cell imports into the cell instead of drawing self-loops', async () => {
  const { graph } = await scanRepository(root);
  const report = buildTierReport(root, 'structure-repo', graph);
  const model = buildStructureGridViewModel(report, descriptor, cache);
  assert.ok(model.edges.every((edge) => edge.source !== edge.target));
  const internal = new Map(report.grid.edges.filter((e) => e.source === e.target).map((e) => [e.source, e.weight]));
  for (const node of model.nodes.filter((n) => n.kind === 'tier')) {
    assert.equal(node.internalImports, internal.get(node.id) ?? 0);
  }
});

test('a Structure grid edge lists the imports behind it, like a stack edge', async () => {
  const { graph } = await scanRepository(root);
  const report = buildTierReport(root, 'structure-repo', graph);
  for (const edge of report.grid.edges) {
    assert.equal(edge.imports?.length, Math.min(edge.weight, 50));
  }
  const model = buildStructureGridViewModel(report, descriptor, cache);
  const upward = model.edges.find((edge) => edge.tierKind === 'upward');
  assert.deepEqual(
    upward?.tierImports?.map((entry) => `${entry.source}:${entry.line} → ${entry.target}`),
    ['orders/src/data/audit.ts:1 → orders/src/domain/orders.ts'],
  );
});

test('a Structure card names the wrong-way imports it starts, grouped by edge', async () => {
  const { graph } = await scanRepository(root);
  const model = buildStructureViewModel(buildTierReport(root, 'structure-repo', graph), descriptor, cache);
  const flows = wrongWayFlowsFor(model, 'data');
  assert.ok(flows, 'the data tier starts an upward read');
  assert.equal(flows.valueCount, 1);
  assert.equal(flows.typeOnlyCount, 0);
  assert.equal(flows.groups.length, 1);
  assert.equal(flows.groups[0].kind, 'upward');
  assert.equal(flows.groups[0].targetLabel, 'Domain/service');
  assert.deepEqual(
    flows.groups[0].imports.map((entry) => `${entry.source}:${entry.line} → ${entry.target}`),
    ['orders/src/data/audit.ts:1 → orders/src/domain/orders.ts'],
  );
  // A tier that starts no wrong-way read, and a file id that is not a card, stay silent.
  assert.equal(wrongWayFlowsFor(model, 'frontend'), null);
  assert.equal(wrongWayFlowsFor(model, 'orders/src/data/audit.ts'), null);
});

test('a type-only wrong-way read is counted out of the card value total', async () => {
  const { graph } = await scanRepository(root);
  const typed = {
    ...graph,
    edges: graph.edges.map((edge) =>
      edge.source === 'orders/src/data/audit.ts' && edge.kind === 'import' ? { ...edge, typeOnly: true } : edge,
    ),
  };
  const model = buildStructureViewModel(buildTierReport(root, 'structure-repo', typed), descriptor, cache);
  const flows = wrongWayFlowsFor(model, 'data');
  assert.equal(flows?.valueCount, 0);
  assert.equal(flows?.typeOnlyCount, 1);
});

test('a Structure view names every wrong-way read, import by import, for a view-level task', async () => {
  const { graph } = await scanRepository(root);
  const model = buildStructureViewModel(buildTierReport(root, 'structure-repo', graph), descriptor, cache);
  const evidence = structureWrongWayEvidence(model);
  const upward = evidence.findIndex((line) => line.startsWith('upward: '));
  assert.ok(upward >= 0, 'the upward edge is named by its tiers');
  assert.match(evidence[upward], /— 1 import\(s\)$/);
  assert.equal(evidence[upward + 1], '  orders/src/data/audit.ts:1 → orders/src/domain/orders.ts');
  // The summary counts edges and the imports behind them, matching the canvas labels.
  assert.match(graphSummary(model), /1 upward edge · 1 import/);
  // Not a Structure view: nothing to list.
  assert.deepEqual(structureWrongWayEvidence({ nodes: [], edges: [] }), []);
});

test('an edge whose imports exceed the cap names how many were not listed', () => {
  const imports = [1, 2, 3].map((line) => ({ source: 'src/data/a.ts', target: 'src/api/b.ts', line, specifier: '../api/b' }));
  const model = {
    structure: true,
    nodes: [
      { id: 'data', kind: 'tier', label: 'Data' },
      { id: 'api', kind: 'tier', label: 'API surface' },
    ],
    edges: [{ source: 'data', target: 'api', tierKind: 'upward', weight: 5, tierImports: imports }],
  };
  assert.deepEqual(structureWrongWayEvidence(model, { importLimit: 2 }), [
    'upward: Data → API surface — 5 import(s)',
    '  src/data/a.ts:1 → src/api/b.ts',
    '  src/data/a.ts:2 → src/api/b.ts',
    '  …and 3 more import(s) not listed',
  ]);
});

test('a skip-layer edge a declared rule allows is drawn and counted as allowed, not wrong-way', () => {
  const model = {
    structure: true,
    nodes: [
      { id: 'api', kind: 'tier', label: 'API surface', files: 3 },
      { id: 'domain', kind: 'tier', label: 'Domain', files: 3 },
      { id: 'data', kind: 'tier', label: 'Data', files: 3 },
    ],
    edges: [
      { source: 'api', target: 'data', tierKind: 'skip-layer', weight: 4, intended: true, ruleId: 'api-reads-stores' },
      { source: 'domain', target: 'api', tierKind: 'upward', weight: 2, intended: true },
    ],
  };
  assert.equal(isWrongWayEdge(model.edges[0]), false);
  // Upward stays wrong-way whatever the rules say.
  assert.equal(isWrongWayEdge(model.edges[1]), true);
  const drawn = buildElements(model as never).edges;
  assert.doesNotMatch(drawn[0].classes ?? '', /edge-tier-skip/);
  assert.equal(drawn[0].data.label, '4 skip-layer · allowed (api-reads-stores)');
  assert.equal(wrongWayFlowsFor(model, 'api'), null);
  assert.doesNotMatch(graphSummary(model), /skip-layer/);
});

test('an edge a rule covers only in part is still wrong-way, and counts and lists just the unexplained imports', () => {
  const imports = [
    { source: 'src/api/a.ts', target: 'src/state/s.ts', line: 1, specifier: './s', allowed: true },
    { source: 'src/api/a.ts', target: 'src/state/s.ts', line: 2, specifier: './s', allowed: true },
    { source: 'src/api/b.ts', target: 'src/cache/c.ts', line: 3, specifier: './c' },
    { source: 'src/api/c.ts', target: 'src/cache/c.ts', line: 4, specifier: './c', typeOnly: true },
  ];
  const model = {
    structure: true,
    nodes: [
      { id: 'api', kind: 'tier', label: 'API surface', files: 3 },
      { id: 'domain', kind: 'tier', label: 'Domain', files: 3 },
      { id: 'data', kind: 'tier', label: 'Data', files: 3 },
    ],
    edges: [
      {
        source: 'api',
        target: 'data',
        tierKind: 'skip-layer',
        weight: 4,
        typeOnlyCount: 1,
        allowedCount: 2,
        allowedTypeOnly: 0,
        tierImports: imports,
      },
    ],
  };
  assert.equal(isWrongWayEdge(model.edges[0]), true);
  assert.equal(buildElements(model as never).edges[0].data.label, '4 skip-layer · 2 allowed · 1 type-only');
  const flows = wrongWayFlowsFor(model, 'api');
  assert.equal(flows?.groups[0].weight, 2, 'four imports minus the two a rule covers');
  assert.equal(flows?.valueCount, 1, 'one of the two left is type-only');
  assert.deepEqual(
    flows?.groups[0].imports.map((entry: { line: number }) => entry.line),
    [3, 4],
  );
  assert.match(graphSummary(model), /1 skip-layer edge · 2 imports/);
  assert.ok(structureWrongWayEvidence(model).some((line) => line.includes('src/api/b.ts:3')));
});
