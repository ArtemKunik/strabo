import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { buildTierReport } from '../../src/analysis/tiers.ts';
import { scanRepository } from '../../src/index.ts';
import { isTypeOnlyStatement } from '../../src/scan/scan-js.ts';
import { buildStructureGridViewModel, buildStructureViewModel } from '../../src/view/view-model.ts';
import { buildElements } from '../../ui/strabo-graph-elements.js';
import { wrongWayFlowsFor } from '../../ui/strabo-graph-facts.js';
import { fitLabel } from '../../ui/strabo-islands.js';

const root = path.resolve('test/fixtures/structure-repo');
const cache = { status: 'memory', fingerprint: 'x', artifactVersion: 1, generatedAt: new Date().toISOString(), stale: false } as never;
const descriptor = { name: 'structure-repo', root } as never;

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
