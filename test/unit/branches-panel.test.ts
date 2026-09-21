import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.document = dom.window.document;
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.HTMLElement = dom.window.HTMLElement;

const { branchTags, formatAge, renderBranches, renderReview, renderReviewLoading } = await import('../../ui/strabo-panels.js');

const NOW = Date.parse('2026-09-21T12:00:00Z');
const tip = (date: string) => ({ hash: 'h', shortHash: 'h', author: 'Ada', date, subject: 's' });

test('formatAge buckets days into a compact age', () => {
  assert.equal(formatAge(0), 'today');
  assert.equal(formatAge(5), '5d');
  assert.equal(formatAge(21), '3w');
  assert.equal(formatAge(200), '6mo');
  assert.equal(formatAge(800), '2y');
  assert.equal(formatAge(null), '');
});

test('branchTags reports merge, upstream sync, and staleness from the listing', () => {
  const texts = (branch: Record<string, unknown>) => branchTags(branch, NOW).map((tag: { text: string }) => tag.text);
  assert.deepEqual(
    texts({ kind: 'local', current: false, isBase: false, tip: tip('2026-09-20'), upstream: null, againstBase: { ahead: 0, behind: 3, merged: true } }),
    ['merged', 'no upstream'],
  );
  assert.deepEqual(
    texts({ kind: 'local', current: true, isBase: false, tip: tip('2026-01-01'), upstream: { name: 'origin/x', ahead: 2, behind: 1, gone: false }, againstBase: { ahead: 2, behind: 0, merged: false } }),
    ['checked out', '2 to push, 1 to pull', 'stale'],
  );
  assert.deepEqual(
    texts({ kind: 'local', current: false, isBase: false, tip: tip('2026-09-20'), upstream: { name: 'origin/x', ahead: 0, behind: 0, gone: true }, againstBase: null }),
    ['upstream gone'],
  );
  assert.deepEqual(texts({ kind: 'remote', current: false, isBase: true, tip: tip('2026-09-20'), upstream: null, againstBase: null }), ['base', 'remote only']);
});

test('renderBranches lists branches with divergence and offers the base picker', () => {
  const target = document.createElement('div');
  const selected: string[] = [];
  const bases: string[] = [];
  renderBranches(
    target,
    {
      available: true,
      current: 'main',
      head: 'h',
      base: { name: 'main', hash: 'h', source: 'conventional' },
      capped: false,
      branches: [
        { name: 'main', kind: 'local', current: true, isBase: true, tip: tip('2026-09-20'), upstream: null, againstBase: null },
        { name: 'feature', kind: 'local', current: false, isBase: false, tip: tip('2026-09-20'), upstream: null, againstBase: { ahead: 4, behind: 2, merged: false } },
      ],
    },
    { onSelect: (branch: { name: string }) => selected.push(branch.name), onBase: (name: string) => bases.push(name) },
  );

  assert.match(target.querySelector('[data-role="branches-summary"]')?.textContent ?? '', /1 branch\(es\) · 1 with unmerged work/);
  const rows = [...target.querySelectorAll('.branch')] as HTMLButtonElement[];
  assert.deepEqual(rows.map((row) => row.dataset.branch), ['main', 'feature']);
  assert.equal(rows[0]?.disabled, true);
  assert.equal(target.querySelector('[data-role="branch-divergence"]')?.textContent, '↓2↑4');
  rows[1]?.click();
  assert.deepEqual(selected, ['feature']);

  const select = target.querySelector('[data-role="branches-base-select"]') as HTMLSelectElement;
  select.value = 'feature';
  select.dispatchEvent(new dom.window.Event('change'));
  assert.deepEqual(bases, ['feature']);
});

test('renderBranches says why no branches are listed', () => {
  const target = document.createElement('div');
  renderBranches(target, { available: false, reason: 'no-git', detail: 'not a git repository' });
  assert.equal(target.querySelector('[data-role="branches-unavailable"]')?.textContent, 'No branches: not a git repository');
});

test('renderBranches offers Fetch and Sync, and Push only for a branch that is ahead', () => {
  const target = document.createElement('div');
  const actions: string[] = [];
  renderBranches(
    target,
    {
      available: true,
      current: 'main',
      head: 'h',
      base: { name: 'main', hash: 'h', source: 'conventional' },
      capped: false,
      branches: [
        { name: 'main', kind: 'local', current: true, isBase: true, tip: tip('2026-09-20'), upstream: null, againstBase: null },
        { name: 'feature', kind: 'local', current: false, isBase: false, tip: tip('2026-09-20'), upstream: { name: 'origin/feature', ahead: 2, behind: 0, gone: false }, againstBase: null },
        { name: 'in-sync', kind: 'local', current: false, isBase: false, tip: tip('2026-09-20'), upstream: { name: 'origin/in-sync', ahead: 0, behind: 0, gone: false }, againstBase: null },
        { name: 'unpublished', kind: 'local', current: false, isBase: false, tip: tip('2026-09-20'), upstream: null, againstBase: null },
      ],
    },
    {
      onFetch: () => actions.push('fetch'),
      onSync: () => actions.push('sync'),
      onPush: (branch: { name: string }) => actions.push(`push:${branch.name}`),
    },
  );

  const fetch = target.querySelector('[data-role="branch-fetch"]') as HTMLButtonElement;
  const sync = target.querySelector('[data-role="branch-sync"]') as HTMLButtonElement;
  assert.ok(fetch && sync);
  fetch.click();
  sync.click();
  assert.deepEqual(actions, ['fetch', 'sync']);

  const pushes = [...target.querySelectorAll('[data-role="branch-push"]')] as HTMLButtonElement[];
  assert.deepEqual(pushes.map((button) => button.dataset.branch), ['feature', 'unpublished']);
  assert.equal(pushes[0]?.textContent, 'Push ↑2');
  assert.equal(pushes[1]?.textContent, 'Publish');
  pushes[0]?.click();
  assert.equal(actions.at(-1), 'push:feature');
});

test('renderBranches disables branch actions while one is running', () => {
  const target = document.createElement('div');
  renderBranches(
    target,
    {
      available: true,
      current: 'main',
      head: 'h',
      base: { name: 'main', hash: 'h', source: 'conventional' },
      capped: false,
      branches: [
        { name: 'main', kind: 'local', current: true, isBase: true, tip: tip('2026-09-20'), upstream: null, againstBase: null },
        { name: 'feature', kind: 'local', current: false, isBase: false, tip: tip('2026-09-20'), upstream: { name: 'origin/feature', ahead: 1, behind: 0, gone: false }, againstBase: null },
      ],
    },
    { onFetch: () => {}, onSync: () => {}, onPush: () => {}, busy: true },
  );
  assert.equal((target.querySelector('[data-role="branch-fetch"]') as HTMLButtonElement).disabled, true);
  assert.equal((target.querySelector('[data-role="branch-sync"]') as HTMLButtonElement).disabled, true);
  assert.equal((target.querySelector('[data-role="branch-push"]') as HTMLButtonElement).disabled, true);
  assert.ok(target.querySelector('[data-role="branch-busy"]'));
});

test('renderReviewLoading says the review is computing instead of claiming Git is missing', () => {
  const target = document.createElement('div');
  renderReview(target, null, {});
  assert.match(target.textContent ?? '', /no Git metadata/);

  renderReviewLoading(target, { onClose: () => {} });
  assert.ok(target.querySelector('[data-role="review-loading"]'));
  assert.equal(target.querySelector('[data-role="review-unavailable"]'), null);
  assert.doesNotMatch(target.textContent ?? '', /no Git metadata/);
  assert.ok(target.querySelector('.panel-dismiss'));
});

test('renderReview shows a branch review with conflicts and code that moved underneath', () => {
  const target = document.createElement('div');
  renderReview(target, {
    available: true,
    kind: 'branch',
    ref: 'feature',
    files: [{ path: 'a.ts', status: 'modified', group: 'branch', insertions: 1, deletions: 1, inGraph: true }],
    totals: { files: 1, insertions: 1, deletions: 1, uncounted: 0 },
    impact: { affected: [], outsideGraph: [] },
    branch: {
      branch: 'feature',
      base: 'main',
      tipHash: 't',
      baseHash: 'b',
      mergeBase: 'abcdef123456',
      ahead: 2,
      behind: 1,
      baseChanged: ['b.ts', 'shared.ts'],
      baseChangedCapped: false,
      overlap: ['shared.ts'],
      conflicts: { available: true, clean: false, paths: ['shared.ts'] },
      movedUnderneath: [{ id: 'b.ts', via: 'a.ts', distance: 1 }],
      checkedOut: false,
    },
  });

  assert.equal(target.querySelector('h3')?.textContent, 'Branch review · feature');
  assert.match(target.querySelector('[data-role="review-branch"]')?.textContent ?? '', /2 commit\(s\) ahead of main · 1 behind · merge base abcdef1/);
  assert.equal(target.querySelector('[data-role="review-merge"]')?.textContent, 'Conflicts with main in 1 file(s).');
  assert.equal(target.querySelector('[data-role="review-conflicts"] button')?.textContent, 'shared.ts');
  // A conflicting file is not listed again as a clean overlap.
  assert.equal(target.querySelector('[data-role="review-overlap"]'), null);
  assert.match(target.querySelector('[data-role="review-moved-underneath"]')?.textContent ?? '', /b\.ts.*imported by a\.ts/);
  assert.ok(target.querySelector('[data-role="review-group-branch"]'));
  assert.ok(target.querySelector('[data-role="review-branch-graph"]'));
});
