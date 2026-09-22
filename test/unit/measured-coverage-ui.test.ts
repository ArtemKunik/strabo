import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

const {
  coverageAge,
  coverageCaption,
  coverageLabel,
  functionCoverage,
  functionCoverageLabel,
} = await import('../../ui/strabo-functions.js');
const { overlayFor } = await import('../../ui/strabo-overlays.js');

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;
globalThis.document = window.document;
globalThis.window = window;
globalThis.HTMLElement = window.HTMLElement;
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

const { renderFunctions } = await import('../../ui/strabo-panels.js');

test('coverageLabel distinguishes measured from unavailable and never fabricates 0%', () => {
  assert.equal(coverageLabel({ lineCoverage: 0 }), 'measured 0%');
  assert.equal(coverageLabel({ lineCoverage: 42.5 }), 'measured 43%');
  assert.equal(coverageLabel({ lineCoverage: null, hits: 3 }), 'measured (executed)');
  assert.equal(coverageLabel({ lineCoverage: null, hits: 0 }), 'measured 0%');
  assert.equal(coverageLabel({ lineCoverage: null, hits: null }), 'measured');
  assert.equal(coverageLabel(undefined), 'unavailable');
  assert.equal(functionCoverageLabel({}), 'unavailable');
});

test('functionCoverage states that an unnamed function is unavailable', () => {
  assert.match(functionCoverage({}), /unavailable/);
  assert.match(
    functionCoverage({ coverage: { lineCoverage: 0, linesHit: 0, linesFound: 5, hits: 0 } }),
    /measured 0% \(0\/5 lines\)/,
  );
  assert.match(
    functionCoverage({ coverage: { lineCoverage: null, linesHit: 0, linesFound: 0, hits: 7 } }),
    /executed 7/,
  );
});

test('coverageCaption names the basis, the percent, the age, and staleness', () => {
  assert.equal(
    coverageCaption({
      basis: 'measured',
      value: 0,
      reportAgeMs: 3 * 24 * 60 * 60 * 1000,
      stale: true,
    }),
    'measured: 0% · report 3d old · stale',
  );
  assert.equal(
    coverageCaption({ basis: 'reachable', value: null, reportAgeMs: null, stale: null }),
    'reachable: unavailable',
  );
  assert.equal(coverageAge(30 * 60 * 1000), '30m');
});

test('the hotspot overlay names measured coverage per function and the report age', () => {
  const report = {
    hotspots: [
      {
        file: 'src/a.ts',
        owner: 'A',
        name: 'run',
        line: 3,
        signals: [{ kind: 'nested-loops', detail: 'loop nesting 2' }],
        coverage: { lineCoverage: 0, linesHit: 0, linesFound: 4, hits: 0 },
      },
      {
        file: 'src/b.ts',
        owner: '',
        name: 'skip',
        line: 9,
        signals: [{ kind: 'long-function', detail: '60 lines' }],
      },
    ],
    filesScanned: 2,
    filesSkipped: 0,
    coverage: { available: true, basis: 'measured', reportAgeMs: 2 * 60 * 60 * 1000, stale: [] },
  };

  const overlay = overlayFor('hotspots', report);
  assert.match(overlay.items[0], /coverage measured 0%/);
  assert.match(overlay.items[1], /coverage unavailable/);
  assert.match(overlay.summary, /coverage measured \(report 2h old\)/);

  const unavailable = overlayFor('hotspots', {
    hotspots: [],
    coverage: { available: false, basis: 'reachable', reason: 'no-report-found' },
  });
  assert.match(unavailable.summary, /coverage unavailable \(no-report-found\)/);
});

test('the architecture overlay labels a coverage axis measured or reachable', () => {
  const overlay = overlayFor('architecture', {
    score: 80,
    axes: [
      { key: 'coverage', label: 'Coverage', value: 50, detail: 'measured 50% line coverage', basis: 'measured' },
      { key: 'lowCoupling', label: 'Low coupling', value: 90, detail: 'average fan-out 1.0' },
    ],
  });
  assert.deepEqual(overlay.items, [
    'Coverage [measured]: 50/100 (measured 50% line coverage)',
    'Low coupling: 90/100 (average fan-out 1.0)',
  ]);
});

test('renderFunctions renders the coverage basis and a coverage cell', () => {
  const target = document.createElement('div');
  const functions = [
    {
      name: 'measured',
      owner: '',
      visibility: 'public',
      line: 1,
      metrics: undefined,
      calls: [],
      callers: [],
      signals: [],
      coverage: { lineCoverage: 0, linesHit: 0, linesFound: 3, hits: 0 },
    },
    {
      name: 'unnamed',
      owner: '',
      visibility: 'public',
      line: 8,
      metrics: undefined,
      calls: [],
      callers: [],
      signals: [],
    },
  ];
  renderFunctions(
    target,
    {
      available: true,
      coverage: { basis: 'measured', value: 0, reportAgeMs: 90 * 60 * 1000, stale: false },
      functions: { file: 'src/a.ts', available: true, functions },
    },
    {},
  );

  assert.match(target.querySelector('.function-coverage-basis').textContent, /Coverage measured: 0% · report 1h old/);
  const cells = [...target.querySelectorAll('.function-coverage')];
  assert.equal(cells.length, 2);
  assert.deepEqual(
    cells.map((cell) => `${cell.dataset.basis}:${cell.textContent}`),
    ['measured:measured 0%', 'unavailable:unavailable'],
  );
});
