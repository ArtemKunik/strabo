import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;
globalThis.document = window.document;
globalThis.window = window;
globalThis.HTMLElement = window.HTMLElement;

const { coverageEntryLabel, coverageTotalsLabel, renderCoverageFile, renderCoverageReport } = await import(
  '../../ui/strabo-panels.js'
);

const PROVENANCE_MEASURED = {
  available: true,
  basis: 'measured',
  format: 'lcov',
  reportPath: 'coverage/lcov.info',
  reportModified: '2026-09-26T00:00:00.000Z',
  reportAgeMs: 2 * 60 * 60 * 1000,
  outOfGraph: [],
  stale: ['src/b.ts'],
  summary: { filesMeasured: 8, linesFound: 200, linesHit: 120, lineCoverage: 60 },
};

const PROVENANCE_REACHABLE = {
  available: false,
  basis: 'reachable',
  format: null,
  reportPath: null,
  reportModified: null,
  reportAgeMs: null,
  reason: 'no-report-found',
  detail: 'no coverage report was found inside the scan ceiling',
  outOfGraph: [],
  stale: [],
  summary: { filesMeasured: 0, linesFound: 0, linesHit: 0, lineCoverage: null },
};

const PROJECT_MEASURED = {
  scope: 'project',
  subject: '.',
  threshold: 50,
  totals: {
    files: 10,
    filesMeasured: 8,
    notInReport: 1,
    reached: 7,
    untested: 3,
    linesHit: 120,
    linesFound: 200,
    value: 60,
    basis: 'measured',
  },
  provenance: PROVENANCE_MEASURED,
  folders: [
    {
      folder: 'src',
      files: 6,
      filesMeasured: 5,
      notInReport: 0,
      reached: 5,
      untested: 2,
      linesHit: 100,
      linesFound: 150,
      value: 66.6,
      basis: 'measured',
    },
    {
      folder: 'ui',
      files: 4,
      filesMeasured: 3,
      notInReport: 1,
      reached: 2,
      untested: 1,
      linesHit: 20,
      linesFound: 50,
      value: 40,
      basis: 'measured',
    },
  ],
};

const PROJECT_REACHABLE = {
  scope: 'project',
  subject: '.',
  threshold: 50,
  totals: {
    files: 5,
    filesMeasured: 0,
    notInReport: 0,
    reached: 2,
    untested: 4,
    linesHit: 0,
    linesFound: 0,
    value: null,
    basis: 'reachable',
  },
  provenance: PROVENANCE_REACHABLE,
  folders: [
    {
      folder: 'src',
      files: 5,
      filesMeasured: 0,
      notInReport: 0,
      reached: 2,
      untested: 4,
      linesHit: 0,
      linesFound: 0,
      value: null,
      basis: 'reachable',
    },
  ],
};

const FOLDER_MEASURED = {
  scope: 'folder',
  subject: 'src',
  threshold: 50,
  totals: {
    files: 3,
    filesMeasured: 2,
    notInReport: 1,
    reached: 2,
    untested: 2,
    linesHit: 80,
    linesFound: 100,
    value: 80,
    basis: 'measured',
  },
  provenance: PROVENANCE_MEASURED,
  folders: [
    {
      folder: 'src/api',
      files: 1,
      filesMeasured: 1,
      notInReport: 0,
      reached: 1,
      untested: 0,
      linesHit: 40,
      linesFound: 50,
      value: 80,
      basis: 'measured',
    },
  ],
  files: [
    {
      file: 'src/a.ts',
      basis: 'measured',
      value: 80,
      linesHit: 8,
      linesFound: 10,
      reached: true,
      notInReport: false,
      stale: false,
      untested: false,
    },
    {
      file: 'src/b.ts',
      basis: 'measured',
      value: null,
      linesHit: null,
      linesFound: null,
      reached: false,
      notInReport: false,
      stale: null,
      untested: true,
    },
    {
      file: 'src/c.ts',
      basis: 'measured',
      value: null,
      linesHit: null,
      linesFound: null,
      reached: false,
      notInReport: true,
      stale: null,
      untested: true,
    },
  ],
};

test('a measured project report shows the provenance, the percent, and folder rows', () => {
  const target = document.createElement('div');
  renderCoverageReport(target, PROJECT_MEASURED, {});

  assert.match(target.querySelector('h3').textContent, /Coverage — project/);

  const provenance = target.querySelector('[data-role="coverage-provenance"]').textContent;
  assert.match(provenance, /measured basis/);
  assert.match(provenance, /lcov/);
  assert.match(provenance, /report 2h old/);
  assert.match(provenance, /1 stale/);

  const value = target.querySelector('[data-role="coverage-value"]');
  assert.equal(value.textContent, '60%');
  assert.equal(value.dataset.basis, 'measured');

  const rows = target.querySelectorAll('.coverage-folder-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dataset.folder, 'src');
  assert.equal(rows[0].querySelector('.coverage-figure').textContent, '67%');
  assert.equal(rows[0].querySelector('.coverage-figure').dataset.basis, 'measured');
  assert.equal(rows[1].dataset.folder, 'ui');
  assert.equal(rows[1].querySelector('.coverage-figure').textContent, '40%');
});

test('a folder report lists its direct files with percent, unavailable, and not in report', () => {
  const target = document.createElement('div');
  const selected: string[] = [];
  renderCoverageReport(target, FOLDER_MEASURED, { onSelect: (file: string) => selected.push(file) });

  const rows = target.querySelectorAll('.coverage-file-row');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].querySelector('.coverage-figure').textContent, '80%');
  assert.equal(rows[1].querySelector('.coverage-figure').textContent, 'unavailable');
  assert.equal(rows[2].querySelector('.coverage-figure').textContent, 'not in report');

  (rows[0].querySelector('.link') as HTMLElement).click();
  assert.deepEqual(selected, ['src/a.ts']);
});

test('a reachable report never renders a reachable figure as a percent', () => {
  const target = document.createElement('div');
  renderCoverageReport(target, PROJECT_REACHABLE, {});

  const provenance = target.querySelector('[data-role="coverage-provenance"]').textContent;
  assert.match(provenance, /reachable basis/);
  assert.match(provenance, /no-report-found/);
  assert.ok(!provenance.includes('%'), 'the reachable provenance must not show a percent');

  const value = target.querySelector('[data-role="coverage-value"]');
  assert.equal(value.textContent, '2/5 reached');
  assert.equal(value.dataset.basis, 'reachable');
  assert.ok(!value.textContent.includes('%'), 'the reachable total must not be a percent');

  for (const figure of target.querySelectorAll('.coverage-figure')) {
    assert.equal(figure.dataset.basis, 'reachable');
    assert.ok(!figure.textContent.includes('%'), `a reachable figure is never a percent: ${figure.textContent}`);
  }
});

test('the file section names the basis, the lines, and the tests and importers as links', () => {
  const target = document.createElement('div');
  const selected: string[] = [];
  renderCoverageFile(
    target,
    {
      scope: 'file',
      subject: 'src/a.ts',
      threshold: 50,
      totals: PROJECT_MEASURED.totals,
      provenance: PROVENANCE_MEASURED,
      file: {
        file: 'src/a.ts',
        basis: 'measured',
        value: 80,
        linesHit: 8,
        linesFound: 10,
        reached: true,
        notInReport: false,
        stale: true,
        untested: false,
        tests: ['test/a.test.ts'],
        importers: ['src/index.ts'],
      },
    },
    { onSelect: (file: string) => selected.push(file) },
  );

  assert.match(target.querySelector('[data-role="coverage-file-figure"]').textContent, /measured coverage/);
  assert.match(target.querySelector('[data-role="coverage-file-figure"]').textContent, /80%/);
  assert.match(target.textContent, /8 hit \/ 10 found/);
  assert.match(target.textContent, /stale/);
  assert.match(target.textContent, /2h old/);

  const links = [...target.querySelectorAll('.coverage-link-list .link')];
  assert.ok(links.some((link) => link.textContent === 'test/a.test.ts'));
  assert.ok(links.some((link) => link.textContent === 'src/index.ts'));
  (links[0] as HTMLElement).click();
  assert.deepEqual(selected, ['test/a.test.ts']);
});

test('the pure labels never turn an unrecorded or reachable figure into 0%', () => {
  assert.equal(coverageEntryLabel({ basis: 'measured', value: 0 }), '0%');
  assert.equal(coverageEntryLabel({ basis: 'measured', value: null }), 'unavailable');
  assert.equal(coverageEntryLabel({ basis: 'measured', value: null, notInReport: true }), 'not in report');
  assert.equal(coverageEntryLabel({ basis: 'reachable', value: null, reached: true }), 'reachable (test-reach)');
  assert.equal(coverageEntryLabel({ basis: 'reachable', value: null, reached: false }), 'no test reaches it');
  assert.equal(coverageTotalsLabel({ basis: 'measured', value: null }), 'unavailable');
  assert.equal(coverageTotalsLabel({ basis: 'reachable', value: null, files: 5, reached: 2 }), '2/5 reached');
  assert.equal(coverageEntryLabel(undefined), 'unavailable');
});
