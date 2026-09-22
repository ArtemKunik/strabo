import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

/**
 * The DOM panels are browser code, but their logic is a pure transform from a model to a tree.
 * A JSDOM document is enough to exercise that transform from Node, so a panel is covered
 * without a browser and without the acceptance round-trip.
 */
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;

globalThis.document = window.document;
globalThis.window = window;
globalThis.HTMLElement = window.HTMLElement;
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

const {
  renderChangesWith,
  renderDiagnostics,
  renderFolderList,
  renderFunctions,
  renderImpactPassport,
  renderInspector,
  renderLegend,
  renderMemberMap,
  renderNarrationPanel,
  renderNarrativeReply,
  renderOverlayPanel,
  renderReview,
  renderShortcuts,
  renderSource,
  renderWorkspace,
  structuralCycleLabel,
  structuralDiffGroups,
  structuralEdgeLabel,
  structuralTierEdgeLabel,
} = await import('../../ui/strabo-panels.js');
const { createVirtualList } = await import('../../ui/strabo-virtual.js');

const container = () => document.createElement('div');

test('renderFolderList renders one button per directory and an empty note', () => {
  const target = container();
  renderFolderList(
    target,
    {
      directories: [
        { path: 'src', name: 'src', isRepository: false },
        { path: 'pkg', name: 'pkg', isRepository: true },
      ],
    },
    () => {},
  );

  const buttons = [...target.querySelectorAll('button.folder')];
  assert.deepEqual(buttons.map((button) => button.dataset.path), ['src', 'pkg']);
  assert.match(buttons[1].textContent, /repository/);

  const empty = container();
  renderFolderList(empty, { directories: [] }, () => {});
  assert.match(empty.textContent, /No subfolders/);
});

test('renderLegend labels each reading cue and each node kind', () => {
  const target = container();
  renderLegend(target, { nodes: [{ id: 'a', kind: 'module' }, { id: 'b', kind: 'test' }] });

  const text = target.textContent;
  assert.match(text, /island = directory/);
  assert.match(text, /module \(round-rectangle\)/);
  assert.match(text, /test \(diamond\)/);
});

test('renderShortcuts pairs each key with its action', () => {
  const target = container();
  renderShortcuts(target);

  assert.ok(target.querySelectorAll('.shortcut-list dt').length > 0);
  assert.equal(
    target.querySelectorAll('.shortcut-list dt').length,
    target.querySelectorAll('.shortcut-list dd').length,
  );
});

test('renderDiagnostics groups diagnostics by kind and keeps their source', () => {
  const target = container();
  const summary = renderDiagnostics(target, {
    diagnostics: [
      { kind: 'parse', file: 'a.ts', line: 3, message: 'unexpected token' },
      { kind: 'parse', file: 'b.ts', line: 1, message: 'unexpected token' },
    ],
    nodes: [],
    edges: [],
  });

  assert.equal(summary.diagnostics, 2);
  assert.match(target.querySelector('.diag-group summary').textContent, /parse \(2\)/);
  assert.equal(target.querySelectorAll('[data-delegate-diagnostic]').length, 2);
});

test('renderOverlayPanel virtualizes a long list and keeps the full scroll height', () => {
  const target = container();
  const items = Array.from({ length: 500 }, (_, index) => `mod${index}`);
  renderOverlayPanel(target, 'Impact', { summary: '500 modules', items, meta: {} }, {});

  const rows = [...target.querySelectorAll('.overlay-list-row')];
  assert.ok(rows.length > 0 && rows.length < 500, `expected a window of rows, got ${rows.length}`);
  assert.equal(rows[0].dataset.delegateOverlayItem, 'mod0');
  assert.equal(target.querySelector('.overlay-list-spacer').style.height, '10000px');
});

test('renderOverlayPanel filters the list and reports an empty match', () => {
  const target = container();
  const items = Array.from({ length: 20 }, (_, index) => `module-${index}`);
  renderOverlayPanel(target, 'Impact', { summary: '20 modules', items, meta: {} }, {});

  const search = target.querySelector('.overlay-filter');
  assert.ok(search, 'a long list should offer a filter');

  search.value = 'module-7';
  search.dispatchEvent(new window.Event('input'));
  const rows = [...target.querySelectorAll('.overlay-list-row')];
  assert.deepEqual(rows.map((row) => row.dataset.delegateOverlayItem), ['module-7']);

  search.value = 'nothing-matches';
  search.dispatchEvent(new window.Event('input'));
  assert.equal(target.querySelectorAll('.overlay-list-row').length, 0);
  assert.equal(target.querySelector('.overlay-empty').hidden, false);
});

test('renderOverlayPanel focuses changed rows and marks affected dependents', () => {
  const target = container();
  const items = ['c.ts · distance 0', 'b.ts · distance 1', 'a.ts · distance 2'];
  renderOverlayPanel(
    target,
    'Change impact',
    {
      summary: '1 changed · 2 affected',
      items,
      changedItems: new Set(['c.ts · distance 0']),
      affectedItems: new Set(['b.ts · distance 1', 'a.ts · distance 2']),
    },
    { kind: 'impact' }
  );

  assert.equal(target.querySelectorAll('.overlay-row-affected').length, 2);

  const toggle = target.querySelector('.overlay-toggle-changed');
  assert.ok(toggle, 'a changed-only toggle is offered when dependents can be hidden');
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const rows = [...target.querySelectorAll('.overlay-list-row')];
  assert.deepEqual(rows.map((row) => row.dataset.delegateOverlayItem), ['c.ts · distance 0']);
});

test('renderOverlayPanel shows the empty note when it has no items', () => {
  const target = container();
  renderOverlayPanel(target, 'Impact', { summary: 'nothing', items: [], emptyNote: 'No files changed.' }, {});

  assert.match(target.textContent, /No files changed\./);
});

test('renderWorkspace lists service endpoints and flows, and states empty sections', () => {
  const target = container();
  renderWorkspace(
    target,
    {
      name: 'shop',
      repositories: [],
      flows: [],
      serviceEndpoints: [
        { repository: 'api', source: 'openapi.yaml', method: 'GET', path: '/users', host: 'api.dev' },
      ],
      serviceFlows: [
        {
          from: 'web',
          to: 'api',
          method: 'GET',
          path: '/users',
          host: 'api.dev',
          calls: [{ file: 'src/client.ts', line: 1, target: 'https://api.dev/users', method: 'GET' }],
          declaredBy: 'openapi.yaml',
        },
      ],
      contracts: [],
      drift: [],
      summary: { repositories: 0, flows: 0, serviceFlows: 1, contracts: 0, drifting: 0 },
    },
    {},
  );

  assert.match(target.textContent, /Service endpoints \(1\)/);
  assert.match(target.textContent, /GET api\.dev\/users — api/);
  assert.match(target.textContent, /Service flows \(1\)/);
  assert.match(target.textContent, /web → api \(GET api\.dev\/users\)/);
  assert.match(target.textContent, /1 service flows/);

  const empty = container();
  renderWorkspace(empty, null, {});
  assert.match(empty.textContent, /No service endpoints recorded\./);
  assert.match(empty.textContent, /No service flows recorded\./);
});

test('createVirtualList renders a window and redraws on scroll', () => {
  const list = createVirtualList({
    rowHeight: 20,
    overscan: 1,
    className: 'test-list',
    viewportHeight: 100,
    renderRow: (item, index) => {
      const row = document.createElement('div');
      row.className = 'test-row';
      row.dataset.index = String(index);
      row.textContent = item;
      return row;
    },
  });

  list.setItems(Array.from({ length: 100 }, (_, index) => `row-${index}`));

  const visible = () => [...list.element.querySelectorAll('.test-row')].map((row) => row.dataset.index);
  assert.deepEqual(visible(), ['0', '1', '2', '3', '4', '5']);

  list.element.scrollTop = 200;
  list.element.dispatchEvent(new window.Event('scroll'));

  assert.deepEqual(visible(), ['9', '10', '11', '12', '13', '14', '15']);
  assert.equal(list.element.querySelector('.test-list-window').style.transform, 'translateY(180px)');
});

const functionFixture = (name, overrides = {}) => ({
  name,
  owner: '',
  visibility: 'public',
  line: 1,
  metrics: {
    endLine: 5,
    lines: 5,
    statementCount: 3,
    decisionPoints: 1,
    maxNestingDepth: 0,
    loopNestingDepth: 0,
    loops: 0,
    loopScans: [],
    loopSorts: [],
    recursive: false,
  },
  calls: [],
  callers: [],
  signals: [],
  ...overrides,
});

const functionsResult = (functions) => ({
  available: true,
  functions: { file: 'sample.rs', available: true, functions },
});

test('renderFunctions shows a summary row and one table row per function', () => {
  const target = container();
  renderFunctions(
    target,
    functionsResult([
      functionFixture('helper', { visibility: 'public' }),
      functionFixture('renders', {
        visibility: 'private',
        entry: { kind: 'test', evidence: '#[test]' },
        calls: [{ name: 'helper', kind: 'bare', line: 6 }],
        signals: [{ kind: 'nested-loops', line: 5, detail: 'loop nesting 2 (threshold 2)' }],
      }),
    ]),
    {},
  );

  assert.match(target.textContent, /Functions \(2\)/);
  assert.match(
    target.textContent,
    /2 functions · total complexity 2 · max complexity 1 · max nesting 0 · 1 signal/,
  );

  const rows = [...target.querySelectorAll('.function-row')];
  assert.equal(rows.length, 2);
  // Worst signals first.
  assert.match(rows[0].textContent, /renders/);
  assert.match(rows[0].textContent, /entry: test \(#\[test\]\)/);
  assert.match(rows[0].querySelector('.function-name').title, /renders/);
  assert.match(rows[1].textContent, /no callers in this file \(cross-file not resolved\)/);

  const chips = [...target.querySelectorAll('.signal-chip')];
  assert.equal(chips.length, 1);
  assert.equal(chips[0].textContent, 'nested-loops');
});

test('renderFunctions sorts columns on click and expands rows for call sites', () => {
  const target = container();
  renderFunctions(
    target,
    functionsResult([
      functionFixture('zebra', { metrics: { ...functionFixture('z').metrics, decisionPoints: 1 } }),
      functionFixture('alpha', { metrics: { ...functionFixture('a').metrics, decisionPoints: 9 } }),
    ]),
    {},
  );

  const names = () => [...target.querySelectorAll('.function-row .function-name')].map((b) => b.textContent);
  // Default: signal count (tied) then complexity, so alpha first.
  assert.deepEqual(names(), ['alpha', 'zebra']);

  const nameHeader = [...target.querySelectorAll('.function-sort')].find(
    (button) => button.dataset.sort === 'name',
  );
  nameHeader.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.deepEqual(names(), ['alpha', 'zebra']);
  // Clicking again reverses the direction.
  nameHeader.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.deepEqual(names(), ['zebra', 'alpha']);

  // Expanding a row reveals the signature and the call sites with lines.
  const withCalls = container();
  renderFunctions(
    withCalls,
    functionsResult([
      functionFixture('caller', { calls: [{ name: 'helper', kind: 'bare', line: 6 }] }),
      functionFixture('helper'),
    ]),
    {},
  );
  const callerRow = [...withCalls.querySelectorAll('.function-row')].find((row) =>
    row.textContent.includes('caller'),
  );
  const detail = callerRow.nextElementSibling;
  assert.equal(detail.hidden, true);
  callerRow.querySelector('.function-count').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(detail.hidden, false);
  assert.match(detail.textContent, /complexity 1/);
  const site = detail.querySelector('.function-callsite');
  assert.equal(site.textContent, 'helper (L6)');
  assert.equal(site.dataset.line, '6');
});

test('renderFunctions virtualizes large files and keeps the summary', () => {
  const target = container();
  const functions = Array.from({ length: 120 }, (_, index) =>
    functionFixture(`fn${String(index).padStart(3, '0')}`),
  );
  renderFunctions(target, functionsResult(functions), {});

  assert.match(target.textContent, /120 functions/);
  const rows = [...target.querySelectorAll('.function-virtual-row')];
  assert.ok(rows.length > 0 && rows.length < 120, `expected a window of rows, got ${rows.length}`);
  assert.match(target.querySelector('.function-virtual-detail').textContent, /fn000/);
});

test('renderNarrativeReply builds prose, code, and lists as nodes and never parses HTML', () => {
  const target = container();
  renderNarrativeReply(target, {
    available: true,
    text: 'Calls `run()` twice <img src=x onerror=alert(1)>.\n\n1. one\n2. two',
  });
  assert.equal(target.querySelectorAll('img').length, 0, 'markup in a reply stays text');
  assert.equal(target.querySelector('p code').textContent, 'run()');
  assert.deepEqual([...target.querySelectorAll('ol li')].map((item) => item.textContent), ['one', 'two']);
  assert.match(target.querySelector('.narrator-attribution').textContent, /not recorded evidence/);

  renderNarrativeReply(target, { available: false, reason: 'not-configured' });
  assert.match(target.textContent, /Narrator unavailable: not-configured/);
  assert.equal(target.querySelector('.narrator-attribution'), null);
});

test('renderNarrationPanel shows loading, the reply, and a way to the settings when it is off', () => {
  const target = container();
  renderNarrationPanel(target, { label: 'ui/strabo-virtual.js', phase: 'loading' });
  assert.match(target.querySelector('h3').textContent, /Narrator · ui\/strabo-virtual\.js/);
  assert.match(target.textContent, /Asking the narrator/);

  renderNarrationPanel(target, { label: 'a.js', phase: 'done', reply: { available: true, text: 'A helper.' } });
  assert.match(target.querySelector('[data-role="narrative"]').textContent, /A helper\./);
  assert.equal(target.querySelector('button'), null);

  let opened = 0;
  renderNarrationPanel(
    target,
    { label: 'a.js', phase: 'done', reply: { available: false, reason: 'not-configured' } },
    { onOpenNarratorSettings: () => (opened += 1) },
  );
  target.querySelector('button.narrator-setup').click();
  assert.equal(opened, 1);

  renderNarrationPanel(target, { label: 'a.js', phase: 'error', message: 'boom' });
  assert.match(target.textContent, /Narrator unavailable: boom/);
});

test('renderReview offers the change-set narrator only when a handler is supplied', () => {
  const review = {
    available: true,
    kind: 'commit',
    commit: { shortHash: 'abc1234', author: 'a', date: '2026-01-01T00:00:00Z', subject: 'Change' },
    files: [],
    totals: { files: 0, insertions: 0, deletions: 0, uncounted: 0 },
    impact: { affected: [], outsideGraph: [] },
  };

  const inert = container();
  renderReview(inert, review, {});
  assert.equal(inert.querySelector('#narrate-change'), null);

  const off = container();
  renderReview(off, review, {
    narratorStatus: { configured: false, reason: 'not-configured' },
    onNarrate: async () => ({ available: false }),
  });
  const offButton = off.querySelector('#narrate-change');
  assert.equal(offButton.disabled, true);
  assert.match(offButton.title, /off/i);

  const ready = container();
  renderReview(ready, review, {
    narratorStatus: { configured: true, model: 'gpt-x', requestBudget: 20, remaining: 19 },
    onNarrate: async () => ({ available: true, text: 'It removes a crash.' }),
  });
  const button = ready.querySelector('#narrate-change');
  assert.equal(button.textContent, 'Narrate change');
  assert.equal(button.disabled, false);
});

test('structuralDiffGroups labels each structural event from the same document the report prints', () => {
  const structural = {
    available: true,
    base: 'HEAD~1',
    baseRevision: 'abc',
    headRevision: 'def',
    diff: {
      edgesAdded: [{ source: 'src/a.ts', target: 'src/b.ts', kind: 'import' }],
      edgesRemoved: [],
      cyclesIntroduced: [{ id: 'src/a.ts', members: ['src/a.ts', 'src/b.ts'] }],
      cyclesResolved: [],
      tierEdgesAdded: [{ unit: '.', source: 'src/data/x.ts', target: 'src/api/y.ts', kind: 'upward' }],
      entryPointsAdded: ['src/cli.ts'],
      newlyUnreached: ['src/lib.ts'],
      counts: {},
    },
  };

  assert.equal(structuralEdgeLabel({ source: 'a', target: 'b', kind: 'import' }), 'a → b (import)');
  assert.equal(structuralCycleLabel({ members: ['a', 'b'] }), 'a → b');
  assert.equal(structuralTierEdgeLabel({ unit: '.', source: 'x', target: 'y', kind: 'upward' }), 'x → y (upward, .)');

  const groups = structuralDiffGroups(structural);
  assert.deepEqual(
    groups.map((group) => group.key),
    ['edges-added', 'cycles-introduced', 'tier-edges-added', 'entry-points-added', 'newly-unreached'],
  );
  assert.equal(groups[0].items[0], 'src/a.ts → src/b.ts (import)');
  assert.equal(groups[1].items[0], 'src/a.ts → src/b.ts');
  assert.equal(groups[2].items[0], 'src/data/x.ts → src/api/y.ts (upward, .)');
  assert.deepEqual(structuralDiffGroups({ available: false, reason: 'unknown-revision' }), []);
});

test('structuralDiffGroups is empty when nothing structural changed', () => {
  const empty = {
    available: true,
    diff: {
      edgesAdded: [],
      edgesRemoved: [],
      cyclesIntroduced: [],
      cyclesResolved: [],
      tierEdgesAdded: [],
      entryPointsAdded: [],
      newlyUnreached: [],
    },
  };
  assert.deepEqual(structuralDiffGroups(empty), []);
});

test('renderReview renders the Structure section from the structural document', () => {
  const target = container();
  renderReview(
    target,
    {
      available: true,
      kind: 'commit',
      commit: { shortHash: 'abc1234', author: 'a', date: '2026-01-01T00:00:00Z', subject: 'Change' },
      files: [],
      totals: { files: 0, insertions: 0, deletions: 0, uncounted: 0 },
      impact: { affected: [], outsideGraph: [] },
      structural: {
        available: true,
        base: 'HEAD~1',
        baseRevision: 'abc',
        headRevision: 'def',
        diff: {
          edgesAdded: [],
          edgesRemoved: [],
          cyclesIntroduced: [{ id: 'src/a.ts', members: ['src/a.ts', 'src/b.ts'] }],
          cyclesResolved: [],
          tierEdgesAdded: [],
          entryPointsAdded: [],
          newlyUnreached: [],
        },
      },
    },
    {},
  );
  assert.equal(
    target.querySelector('[data-role="review-structure-cycles-introduced"] li').textContent,
    'src/a.ts → src/b.ts',
  );
});

test('renderReview names an unavailable structure instead of an empty diff', () => {
  const target = container();
  renderReview(
    target,
    {
      available: true,
      kind: 'commit',
      files: [],
      totals: { files: 0, insertions: 0, deletions: 0, uncounted: 0 },
      impact: { affected: [], outsideGraph: [] },
      structural: { available: false, reason: 'unknown-revision', detail: 'Unknown revision "x".' },
    },
    {},
  );
  assert.match(
    target.querySelector('[data-role="review-structure-unavailable"]').textContent,
    /Unknown revision/,
  );
});

test('renderReview sends the change set to the narrator and renders the reply', async () => {
  const target = container();
  renderReview(
    target,
    {
      available: true,
      kind: 'commit',
      commit: { shortHash: 'abc1234', author: 'a', date: '2026-01-01T00:00:00Z', subject: 'Change' },
      files: [],
      totals: { files: 0, insertions: 0, deletions: 0, uncounted: 0 },
      impact: { affected: [], outsideGraph: [] },
    },
    {
      narratorStatus: { configured: true, model: 'gpt-x', requestBudget: 20, remaining: 19 },
      onNarrate: async () => ({ available: true, text: 'It removes a crash.' }),
    },
  );
  target.querySelector('#narrate-change').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(target.querySelector('[data-role="narrative"]').textContent, /It removes a crash\./);
  assert.match(target.querySelector('.narrator-attribution').textContent, /not recorded evidence/);
});

test('renderImpactPassport renders the file card with its cells, signals, and functions', () => {
  const target = container();
  renderImpactPassport(target, {
    scope: 'file',
    baseline: 'HEAD',
    capped: false,
    files: [
      {
        path: 'src/dispatch.rs',
        status: 'modified',
        risk: {
          score: 100,
          band: 'critical',
          inputs: { maxComplexity: 35, blastRadius: 0, signals: 1, untestedShare: 0, directImporters: 0 },
        },
        complexity: {
          maxBefore: 32,
          maxAfter: 35,
          averageBefore: 8.2,
          averageAfter: 8.4,
          sumBefore: 115,
          sumAfter: 118,
          functionCountBefore: 14,
          functionCountAfter: 14,
          functionsUnchanged: 13,
          classesUnchanged: 0,
        },
        coherence: { score: 100, changedSymbols: 1, detail: '1 changed symbol(s); concentration heuristic' },
        snapshot: { blastRadius: 0, directImporters: 0, directImports: 5 },
        signals: [{ kind: 'high-complexity', label: 'High complexity logic', detail: 'maximum C35' }],
        mostComplex: [{ name: 'try_dispatch', owner: '', complexity: 35, before: 32, delta: 3 }],
        impact: null,
        testsToRun: [],
        untestedDependents: [],
      },
    ],
    totals: null,
  });

  assert.match(target.textContent, /Change impact passport/);
  assert.equal(target.querySelector('[data-role="impact-risk"] .impact-cell-value').textContent, 'CRITICAL 100/100');
  assert.equal(target.querySelector('[data-role="impact-max-complexity"] .impact-cell-value').textContent, 'C35');
  assert.match(target.querySelector('[data-role="impact-max-complexity"] .impact-cell-detail').textContent, /grown \+C3/);
  assert.equal(target.querySelector('[data-role="impact-coherence"] .impact-cell-value').textContent, '100/100');
  assert.equal(target.querySelector('[data-role="impact-imports"] .impact-cell-value').textContent, '0 / 5');
  assert.match(target.querySelector('[data-role="impact-average-complexity"] .impact-cell-detail').textContent, /13 function\(s\) unchanged/);
  assert.equal(target.querySelector('[data-role="impact-signals"] li').textContent, 'High complexity logicmaximum C35');
  assert.equal(target.querySelector('[data-role="impact-most-complex"] li').textContent, 'try_dispatchC35 (+C3)');
});

test('renderImpactPassport rolls a change set up and lists each file', () => {
  const target = container();
  const file = {
    path: 'a.ts',
    status: 'modified',
    risk: { score: 40, band: 'moderate', inputs: { maxComplexity: 10, blastRadius: 1, signals: 0, untestedShare: 0, directImporters: 1 } },
    complexity: {
      maxBefore: 5,
      maxAfter: 10,
      averageBefore: 3,
      averageAfter: 5,
      sumBefore: 5,
      sumAfter: 10,
      functionCountBefore: 1,
      functionCountAfter: 2,
      functionsUnchanged: 1,
      classesUnchanged: 0,
    },
    coherence: { score: 100, changedSymbols: 1, detail: '1 changed symbol(s); concentration heuristic' },
    snapshot: { blastRadius: 1, directImporters: 1, directImports: 0 },
    signals: [],
    mostComplex: [],
    impact: null,
    testsToRun: [],
    untestedDependents: [],
  };
  renderImpactPassport(
    target,
    {
      scope: 'change-set',
      baseline: 'HEAD',
      capped: false,
      files: [file],
      totals: {
        files: 1,
        risk: { score: 40, band: 'moderate' },
        maxComplexity: 10,
        averageComplexity: 5,
        coherence: 100,
        changedSymbols: 1,
        blastRadius: 1,
        directImporters: 1,
        directImports: 0,
        signals: [],
        mostComplex: [],
        functionsUnchanged: 1,
        classesUnchanged: 0,
      },
    },
    { onSelect: () => {} },
  );

  assert.match(target.textContent, /compared with HEAD/);
  assert.equal(target.querySelector('[data-role="impact-totals"] [data-role="impact-risk"] .impact-cell-value').textContent, 'MODERATE 40/100');
  assert.equal(target.querySelector('[data-role="impact-files"] button.link').dataset.path, 'a.ts');
  assert.match(target.querySelector('[data-role="impact-files"] .impact-risk-band').textContent, /MODERATE 40/);
});

test('renderSource shows a file line by line, numbered and marked at the evidence line', () => {
  const target = container();
  renderSource(target, {
    file: 'src/a.ts',
    ref: null,
    mode: 'content',
    loading: false,
    error: null,
    content: 'const a = 1;\nconst b = 2;\n',
    line: 2,
    hasDiff: false,
  });

  assert.equal(target.querySelector('.source-path').textContent, 'src/a.ts');
  const rows = [...target.querySelectorAll('.src-line')];
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => [row.querySelector('.src-no').textContent, row.querySelector('.src-code').textContent]),
    [
      ['1', 'const a = 1;'],
      ['2', 'const b = 2;'],
    ],
  );
  assert.equal(rows[1].classList.contains('src-mark'), true);
  assert.equal(rows[0].classList.contains('src-mark'), false);
  assert.equal(target.querySelectorAll('.source-mode').length, 0);
});

test('renderSource reports an empty file, a loading panel, and an unavailable one', () => {
  const empty = container();
  renderSource(empty, { file: 'a.ts', mode: 'content', loading: false, content: '' });
  assert.match(empty.textContent, /empty/i);

  const loading = container();
  renderSource(loading, { file: 'a.ts', mode: 'content', loading: true });
  assert.equal(loading.querySelector('[data-role="source-loading"]') !== null, true);

  const failed = container();
  renderSource(failed, { file: 'a.ts', mode: 'content', loading: false, error: 'not readable as text' });
  assert.equal(failed.querySelector('[data-role="source-unavailable"]').textContent, 'Unavailable: not readable as text');
});

test('renderSource draws a diff with both line numbers and offers the other side', () => {
  const target = container();
  renderSource(
    target,
    {
      file: 'src/a.ts',
      ref: 'abc123',
      mode: 'diff',
      loading: false,
      status: 'modified',
      hasDiff: true,
      diff: {
        file: 'src/a.ts',
        header: [],
        added: 1,
        removed: 1,
        binary: false,
        hunks: [
          {
            header: '@@ -1,2 +1,2 @@',
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 2,
            lines: [
              { kind: 'context', text: 'one', oldLine: 1, newLine: 1 },
              { kind: 'del', text: 'two', oldLine: 2, newLine: null },
              { kind: 'add', text: 'TWO', oldLine: null, newLine: 2 },
            ],
          },
        ],
      },
    },
    { onShowFile: () => {} },
  );

  assert.equal(target.querySelector('.source-counts').textContent, '+1 −1');
  assert.match(target.querySelector('.src-hunk').textContent, /@@ -1,2 \+1,2 @@/);
  const del = target.querySelector('.src-del');
  assert.deepEqual([...del.querySelectorAll('.src-no')].map((node) => node.textContent), ['2', '']);
  const add = target.querySelector('.src-add');
  assert.deepEqual([...add.querySelectorAll('.src-no')].map((node) => node.textContent), ['', '2']);
  assert.deepEqual([...target.querySelectorAll('.source-mode')].map((button) => button.textContent), ['File']);
});

test('renderSource names a binary and an unchanged file instead of leaving the viewer blank', () => {
  const binary = container();
  renderSource(binary, {
    file: 'logo.png',
    mode: 'diff',
    loading: false,
    hasDiff: true,
    diff: { file: 'logo.png', header: [], added: 0, removed: 0, binary: true, hunks: [] },
  });
  assert.equal(binary.querySelector('[data-role="source-binary"]') !== null, true);

  const same = container();
  renderSource(same, {
    file: 'a.ts',
    mode: 'diff',
    loading: false,
    hasDiff: true,
    diff: { file: 'a.ts', header: [], added: 0, removed: 0, binary: false, hunks: [] },
  });
  assert.match(same.textContent, /No change between the two sides/);
});

test('renderInspector offers Back to the map', () => {
  const target = container();
  let backs = 0;
  renderInspector(
    target,
    {
      nodes: [{ id: 'a.ts', label: 'a.ts', kind: 'module', transitiveDependents: 2, transitiveDependencies: 1, lines: 12 }],
      edges: [],
    },
    'a.ts',
    { onBack: () => { backs += 1; } },
  );

  const back = target.querySelector('[data-role="panel-back"]') as HTMLButtonElement;
  assert.equal(back.disabled, false);
  assert.match(back.getAttribute('aria-label') ?? '', /map/);
  back.click();
  assert.equal(backs, 1);
});

test('renderChangesWith lists a partner with its commits and flags hidden coupling', () => {
  const target = container();
  let selected = null;
  renderChangesWith(
    target,
    {
      available: true,
      partners: [
        {
          file: 'src/config.ts',
          hidden: true,
          ratio: 0.6,
          commitsShared: 3,
          commits: [
            { hash: 'abcdef1234', date: '2026-01-05', subject: 'retune port' },
            { hash: 'abcdef5678', date: '2026-01-04', subject: 'retune port again' },
          ],
        },
      ],
    },
    { onSelect: (id) => { selected = id; } },
  );

  const list = target.querySelector('[data-role="changes-with-list"]');
  assert.ok(list);
  assert.match(target.textContent, /config\.ts/);
  assert.match(target.textContent, /3 shared commit\(s\) · ratio 0\.6/);
  assert.match(target.textContent, /hidden coupling/);
  assert.match(target.textContent, /abcdef12 · 2026-01-05 · retune port/);
  list.querySelector('button.link').click();
  assert.equal(selected, 'src/config.ts');
});

test('renderChangesWith says so when there is no evidence', () => {
  const empty = container();
  renderChangesWith(empty, { available: true, partners: [] });
  assert.match(empty.textContent, /No recorded commits changed this file together/);

  const unavailable = container();
  renderChangesWith(unavailable, { available: false, detail: 'no Git history' });
  assert.match(unavailable.textContent, /no Git history/);
});

test('renderInspector includes a Changes with section', () => {
  const target = container();
  renderInspector(
    target,
    {
      nodes: [{ id: 'a.ts', label: 'a.ts', kind: 'module', transitiveDependents: 0, transitiveDependencies: 0 }],
      edges: [],
    },
    'a.ts',
    {},
  );

  assert.ok(target.querySelector('[data-role="changes-with"]'));
  assert.match(target.querySelector('[data-role="changes-with"]').textContent, /Changes with/);
});

test('renderMemberMap offers Back to the module passport', () => {  const target = container();
  let backs = 0;
  renderMemberMap(
    target,
    { file: 'a.ts', repository: 'acme', memberMap: { types: [], dataFlow: { available: false } } },
    {},
    { onBack: () => { backs += 1; } },
  );

  const back = target.querySelector('[data-role="panel-back"]') as HTMLButtonElement;
  assert.equal(back.disabled, false);
  assert.match(back.getAttribute('aria-label') ?? '', /module passport/);
  back.click();
  assert.equal(backs, 1);
});
