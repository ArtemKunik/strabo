import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

/**
 * The route panel is browser code, but its logic is a pure transform from the route model to
 * a DOM tree plus two pure storage helpers. A JSDOM document exercises both from Node, so the
 * panel is covered without a browser and without the acceptance round-trip.
 */
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;

globalThis.document = window.document;
globalThis.window = window;
globalThis.HTMLElement = window.HTMLElement;

const {
  ROUTE_PROGRESS_PREFIX,
  clampRouteIndex,
  readRouteProgress,
  renderRoutePanel,
  routeIndexOf,
  routeProgressKey,
  routeStepLabel,
  routeSteps,
  writeRouteProgress,
} = await import('../../ui/strabo-route.js');

const container = () => document.createElement('div');

const route = {
  repository: 'system-repo',
  entryPoints: [{ file: 'crates/alpha/src/main.rs', reason: 'Cargo.toml bin', source: 'crates/alpha/Cargo.toml', unit: 'crates/alpha' }],
  order: [],
  unreached: [],
  units: [
    {
      summary: { id: 'crates/alpha', name: 'alpha', role: 'library', roleEvidence: 'no frontend evidence', files: 2, routed: 2, unreached: 0, entryPoints: 1 },
      files: [
        { file: 'crates/alpha/src/main.rs', depth: 0, from: null, entry: 'crates/alpha/src/main.rs', entryPoint: true, fanIn: 0, tier: 'unclassified', unit: 'crates/alpha' },
        { file: 'crates/alpha/src/service.rs', depth: 1, from: 'crates/alpha/src/main.rs', entry: 'crates/alpha/src/main.rs', entryPoint: false, fanIn: 2, tier: 'unclassified', unit: 'crates/alpha' },
      ],
      unreached: [],
    },
    {
      summary: { id: 'crates/beta', name: 'beta', role: 'library', roleEvidence: 'no evidence', files: 1, routed: 0, unreached: 1, entryPoints: 0 },
      files: [],
      unreached: [{ file: 'crates/beta/src/lib.rs', unit: 'crates/beta', fanIn: 0, tier: 'unclassified' }],
    },
  ],
  summary: { entryPoints: 1, routed: 2, unreached: 1, units: 2, skipped: 0 },
};

test('routeProgressKey is per repository', () => {
  assert.equal(routeProgressKey('acme'), `${ROUTE_PROGRESS_PREFIX}acme`);
  assert.notEqual(routeProgressKey('acme'), routeProgressKey('other'));
  assert.equal(routeProgressKey(undefined), `${ROUTE_PROGRESS_PREFIX}default`);
});

test('routeSteps flattens the units and tags each step with its unit name', () => {
  const steps = routeSteps(route);
  assert.deepEqual(steps.map((step) => step.file), [
    'crates/alpha/src/main.rs',
    'crates/alpha/src/service.rs',
  ]);
  assert.equal(steps[0].unitName, 'alpha');
  assert.deepEqual(routeSteps(null), []);
});

test('routeIndexOf finds a routed file and refuses an unrouted one', () => {
  assert.equal(routeIndexOf(route, 'crates/alpha/src/service.rs'), 1);
  assert.equal(routeIndexOf(route, 'crates/beta/src/lib.rs'), -1);
  assert.equal(routeIndexOf(route, null), -1);
});

test('clampRouteIndex bounds the step and tolerates an empty route', () => {
  assert.equal(clampRouteIndex(-3, 2), 0);
  assert.equal(clampRouteIndex(9, 2), 1);
  assert.equal(clampRouteIndex(1.9, 2), 1);
  assert.equal(clampRouteIndex(0, 0), 0);
  assert.equal(clampRouteIndex(Number.NaN, 2), 0);
});

test('routeStepLabel states the recorded evidence and never a guess', () => {
  assert.match(routeStepLabel(route.units[0].files[0]), /entry point/);
  assert.match(routeStepLabel(route.units[0].files[1]), /reached from crates\/alpha\/src\/main\.rs/);
  assert.match(routeStepLabel(route.units[0].files[1]), /2 importer\(s\)/);
  assert.equal(routeStepLabel(null), 'No file is on the route.');
});

test('progress round-trips through a storage and survives a broken one', () => {
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  };
  assert.equal(readRouteProgress(storage, 'acme'), null);
  writeRouteProgress(storage, 'acme', 3);
  assert.equal(readRouteProgress(storage, 'acme'), 3);
  // A different repository keeps its own step.
  assert.equal(readRouteProgress(storage, 'other'), null);

  const broken = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(readRouteProgress(broken, 'acme'), null);
  writeRouteProgress(broken, 'acme', 1);
});

test('renderRoutePanel steps through the route and focuses the current file', () => {
  const target = container();
  const steps = [];
  const focused = [];
  renderRoutePanel(target, route, { index: 0 }, {
    onStep: (index) => steps.push(index),
    onFocus: (file) => focused.push(file),
  });

  assert.match(target.querySelector('h3').textContent, /Reading route — system-repo/);
  assert.equal(target.querySelector('[data-role="route-counter"]').textContent, 'Step 1 of 2');
  assert.match(target.querySelector('[data-role="route-current"]').textContent, /entry point/);
  // The first unit's summary precedes its files.
  const unit = target.querySelector('[data-role="route-unit"][data-unit="crates/alpha"]');
  assert.match(unit.querySelector('h4').textContent, /alpha — 2 file\(s\)/);
  assert.equal(unit.querySelectorAll('[data-role="route-step"]').length, 2);
  assert.equal(unit.querySelector('[data-role="route-step"]').classList.contains('is-current'), true);

  // Previous is disabled at the first step; Next steps forward; Focus targets the current file.
  assert.equal(target.querySelector('.route-back').disabled, true);
  assert.equal(target.querySelector('.route-next').disabled, false);
  target.querySelector('.route-next').dispatchEvent(new window.Event('click'));
  assert.deepEqual(steps, [1]);
  target.querySelector('[data-role="route-focus"]').dispatchEvent(new window.Event('click'));
  assert.deepEqual(focused, ['crates/alpha/src/main.rs']);

  // A unit with no routed file still lists what no entry point reaches.
  const beta = target.querySelector('[data-role="route-unit"][data-unit="crates/beta"]');
  assert.equal(beta.querySelectorAll('[data-role="route-step"]').length, 0);
  assert.match(beta.querySelector('[data-role="route-unreached"] summary').textContent, /1 file\(s\)/);
});

test('renderRoutePanel marks the last step and reports an absent route', () => {
  const target = container();
  renderRoutePanel(target, route, { index: 1 }, {});
  assert.equal(target.querySelector('[data-role="route-counter"]').textContent, 'Step 2 of 2');
  assert.equal(target.querySelector('.route-next').disabled, true);
  assert.equal(target.querySelector('.route-back').disabled, false);
  assert.match(target.querySelector('[data-role="route-current"]').textContent, /reached from/);

  const empty = container();
  renderRoutePanel(empty, null, {}, {});
  assert.match(empty.textContent, /No reading route was recorded/);

  const none = container();
  renderRoutePanel(none, { repository: 'x', units: [], summary: {} }, {}, {});
  assert.match(none.querySelector('[data-role="route-counter"]').textContent, /No file is on the route/);
  assert.equal(none.querySelector('.route-focus').disabled, true);
});

test('renderRoutePanel reports a load failure and offers a retry', () => {
  const target = container();
  let retries = 0;
  renderRoutePanel(target, null, { error: '404 Not Found' }, { onRetry: () => (retries += 1) });
  assert.match(target.textContent, /could not be loaded/);
  assert.match(target.textContent, /404 Not Found/);
  target.querySelector('[data-role="route-retry"]').dispatchEvent(new window.Event('click'));
  assert.equal(retries, 1);
});

test('renderRoutePanel offers the opt-in tour only when a handler is supplied', async () => {
  const inert = container();
  renderRoutePanel(inert, route, {}, {});
  assert.equal(inert.querySelector('#narrate-tour'), null);

  const off = container();
  renderRoutePanel(off, route, { index: 0, narratorStatus: { configured: false } }, {
    onNarrateTour: async () => ({ available: true, text: 'tour' }),
    onOpenNarratorSettings: () => {},
  });
  const offButton = off.querySelector('#narrate-tour');
  assert.equal(offButton.disabled, true);
  assert.ok(off.querySelector('[data-role="narrator-setup"]'));

  const ready = container();
  renderRoutePanel(ready, route, {
    index: 0,
    narratorStatus: { configured: true, model: 'm', remaining: 2, requestBudget: 5 },
  }, {
    onNarrateTour: async () => ({ available: true, text: 'A guided tour.' }),
  });
  const button = ready.querySelector('#narrate-tour');
  assert.equal(button.disabled, false);
  button.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(ready.querySelector('.narrator-reply').textContent, /A guided tour\./);
});

test('renderRoutePanel narrates the current step inline when a handler is supplied', async () => {
  const target = container();
  renderRoutePanel(target, route, {
    index: 0,
    narratorStatus: { configured: true, model: 'm', remaining: 2, requestBudget: 5 },
  }, {
    onNarrateStep: async (step) => ({ available: true, text: `step ${step.file}` }),
  });
  const button = target.querySelector('[data-role="route-narrate-step"]');
  assert.equal(button.disabled, false);
  button.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(
    target.querySelector('[data-role="route-step-narrative"]').textContent,
    /crates\/alpha\/src\/main\.rs/,
  );
});
