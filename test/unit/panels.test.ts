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
  renderDiagnostics,
  renderFolderList,
  renderLegend,
  renderOverlayPanel,
  renderShortcuts,
  renderWorkspace,
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
