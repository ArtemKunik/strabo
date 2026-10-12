import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

/**
 * The refactor sandbox panel is browser code over two server answers. JSDOM exercises the
 * pure helpers and the render from Node, so the panel is covered without a browser.
 */
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;

globalThis.document = window.document;
globalThis.window = window;
globalThis.HTMLElement = window.HTMLElement;

const {
  addOperation,
  describeOperation,
  extractionClasses,
  extractionEvidence,
  removeOperation,
  renderSandboxPanel,
  whatIfClasses,
  whatIfEvidence,
} = await import('../../ui/strabo-sandbox.js');

const result = {
  hypothetical: true,
  applied: [
    { operation: { op: 'add', source: 'src/c.ts', target: 'src/a.ts' }, count: 1 },
    { operation: { op: 'move', from: 'src/words', to: 'pkg/words' }, count: 1 },
  ],
  rejected: [{ operation: { op: 'cut', source: 'x.ts', target: 'y.ts' }, reason: '"x.ts" is not a scanned file' }],
  moved: [{ from: 'src/words/w.ts', to: 'pkg/words/w.ts' }],
  edgesAdded: [{ source: 'src/c.ts', target: 'src/a.ts', kind: 'import' }],
  edgesRemoved: [],
  cyclesIntroduced: [{ id: 'pkg/words/w.ts', members: ['pkg/words/w.ts', 'src/a.ts', 'src/c.ts'] }],
  cyclesResolved: [],
  tiers: { available: true, introduced: [], resolved: [] },
  rules: { available: false, reason: 'no declared rules', introduced: [], resolved: [] },
  newlyUnreached: [],
  reach: [{ file: 'src/a.ts', before: 0, after: 2 }],
  reachTruncated: 0,
  counts: {
    edgesAdded: 1,
    edgesRemoved: 0,
    cyclesIntroduced: 1,
    cyclesResolved: 0,
    tierIntroduced: 0,
    tierResolved: 0,
    rulesIntroduced: 0,
    rulesResolved: 0,
    newlyUnreached: 0,
  },
};

const plan = {
  include: ['src/words'],
  unmatched: [],
  files: ['src/words/a.ts'],
  dependencies: [
    {
      file: 'src/shared.ts',
      importedBy: ['src/words/a.ts'],
      edges: 1,
      pulls: 3,
      usedOutside: 4,
      typeOnly: true,
      evidence: [{ source: 'src/words/a.ts', target: 'src/shared.ts', line: 2, specifier: '../shared' }],
    },
  ],
  dependents: [{ file: 'src/words/a.ts', importers: ['src/app.ts'], edges: 1, evidence: [] }],
  closure: ['src/shared.ts'],
  boundaryCycles: [{ id: 'src/app.ts', inside: ['src/words/a.ts'], outside: ['src/app.ts'] }],
  stringCrossings: [],
  externalPackages: [{ package: 'lodash', ecosystem: 'npm', files: ['src/words/a.ts'] }],
  stringEdges: { available: true },
  summary: {
    files: 1,
    dependencies: 1,
    dependents: 1,
    closure: 1,
    boundaryCycles: 1,
    stringCrossings: 0,
    externalPackages: 1,
    selfContained: false,
  },
  notCovered: ['data contracts and shared schemas'],
};

test('edits are normalised, de-duplicated, and malformed ones are dropped', () => {
  let ops = addOperation([], { op: 'cut', source: './src/a.ts ', target: 'src\\b.ts' });
  ops = addOperation(ops, { op: 'cut', source: 'src/a.ts', target: 'src/b.ts' });
  ops = addOperation(ops, { op: 'move', from: 'src/words/', to: '' });
  ops = addOperation(ops, { op: 'move', from: 'src/words/', to: 'pkg/words' });
  assert.deepEqual(ops.map(describeOperation), ['cut src/a.ts → src/b.ts', 'move src/words → pkg/words']);
  assert.deepEqual(removeOperation(ops, 0).map(describeOperation), ['move src/words → pkg/words']);
});

test('the map rings use recorded paths, so a moved cycle member is ringed where the map draws it', () => {
  const classes = whatIfClasses(result);
  assert.equal(classes.get('src/words/w.ts'), 'ov-cycle');
  assert.equal(classes.get('src/a.ts'), 'ov-cycle');
  assert.equal(classes.has('pkg/words/w.ts'), false);

  const planned = extractionClasses(plan);
  assert.equal(planned.get('src/shared.ts'), 'ov-affected');
  assert.equal(planned.get('src/words/a.ts'), 'ov-cycle');
});

test('the agent evidence names the edits, the hypothetical outcome, and what was not applied', () => {
  const evidence = whatIfEvidence([{ op: 'add', source: 'src/c.ts', target: 'src/a.ts' }], result);
  assert.ok(evidence.includes('planned edit: add src/c.ts → src/a.ts'));
  assert.ok(evidence.includes('hypothetical cycles introduced: 1'));
  assert.ok(evidence.includes('blast radius of src/a.ts: 0 → 2'));
  assert.ok(evidence.includes('not applied: "x.ts" is not a scanned file'));

  const planEvidence = extractionEvidence(plan);
  assert.match(planEvidence[1] ?? '', /src\/shared\.ts — used by 1 selected file\(s\), would pull 3 more, shared with 4 outside file\(s\), type-only/);
  assert.ok(planEvidence.some((line) => line.startsWith('not covered:')));
});

test('the what-if tab labels the answer hypothetical and lists what was not applied', () => {
  const panel = document.createElement('div');
  const removed: number[] = [];
  renderSandboxPanel(
    panel,
    { tab: 'what-if', operations: [{ op: 'add', source: 'src/c.ts', target: 'src/a.ts' }], result },
    { onRemove: (index: number) => removed.push(index) },
  );

  assert.match(panel.querySelector('.sandbox-hypothetical')?.textContent ?? '', /Hypothetical/);
  assert.match(panel.querySelector('[data-role="sandbox-cycles-introduced"]')?.textContent ?? '', /3 files/);
  assert.match(panel.querySelector('[data-role="sandbox-rejected"]')?.textContent ?? '', /not a scanned file/);
  assert.match(panel.querySelector('[data-role="sandbox-reach"]')?.textContent ?? '', /0 → 2 dependents/);
  (panel.querySelector('[data-role="sandbox-remove"]') as HTMLElement).click();
  assert.deepEqual(removed, [0]);
});

test('the form submits the edit the selected operation names', () => {
  const panel = document.createElement('div');
  const added: unknown[] = [];
  renderSandboxPanel(panel, { tab: 'what-if', operations: [] }, { onAdd: (op: unknown) => added.push(op) });
  const form = panel.querySelector('[data-role="sandbox-form"]') as HTMLFormElement;
  (form.querySelector('select') as HTMLSelectElement).value = 'move';
  (form.querySelector('[name="first"]') as HTMLInputElement).value = 'src/words';
  (form.querySelector('[name="second"]') as HTMLInputElement).value = 'pkg/words';
  form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  assert.deepEqual(added, [{ op: 'move', from: 'src/words', to: 'pkg/words' }]);
  assert.match(panel.textContent ?? '', /No edits yet/);
});

test('the extraction tab shows the verdict, the cost lists, and what is not covered', () => {
  const panel = document.createElement('div');
  renderSandboxPanel(panel, { tab: 'extraction', operations: [], include: 'src/words', plan });

  assert.match(panel.querySelector('.sandbox-verdict')?.textContent ?? '', /Not self-contained/);
  assert.match(
    panel.querySelector('[data-role="sandbox-dependencies"]')?.textContent ?? '',
    /src\/shared\.ts · used by 1 · pulls 3 more · shared with 4 · type-only/,
  );
  assert.match(panel.querySelector('[data-role="sandbox-boundary-cycles"]')?.textContent ?? '', /src\/app\.ts/);
  assert.match(panel.textContent ?? '', /Not covered: data contracts/);
});
