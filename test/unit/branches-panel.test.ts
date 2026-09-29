import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.document = dom.window.document;
globalThis.window = dom.window as unknown as typeof globalThis.window;
globalThis.HTMLElement = dom.window.HTMLElement;

const { branchTags, formatAge, renderBranches, renderReview, renderReviewLoading } = await import('../../ui/strabo-panels.js');
const { renderBranchDivergence } = await import('../../ui/strabo-panel-branches.js');

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

test('renderBranches offers push, merge-request, and drop actions', () => {
  const target = document.createElement('div');
  const calls: string[] = [];
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
        { name: 'merged', kind: 'local', current: false, isBase: false, tip: tip('2026-09-20'), upstream: null, againstBase: { ahead: 0, behind: 0, merged: true } },
        { name: 'gone', kind: 'local', current: false, isBase: false, tip: tip('2026-09-20'), upstream: { name: 'origin/gone', ahead: 0, behind: 0, gone: true }, againstBase: null },
      ],
    },
    {
      onPush: (name: string) => calls.push(`push:${name}`),
      onMergeRequest: (name: string) => calls.push(`mr:${name}`),
      onDrop: (name: string) => calls.push(`drop:${name}`),
    },
  );

  const names = (role: string) =>
    [...target.querySelectorAll(`[data-role="${role}"]`)].map((button) => (button as HTMLElement).dataset.branch);
  assert.deepEqual(names('branch-push'), ['feature', 'merged', 'gone']);
  assert.deepEqual(names('branch-merge-request'), ['feature', 'merged', 'gone']);
  assert.deepEqual(names('branch-drop'), ['merged', 'gone']);

  (target.querySelector('[data-role="branch-drop"]') as HTMLButtonElement).click();
  (target.querySelector('[data-role="branch-push"]') as HTMLButtonElement).click();
  (target.querySelector('[data-role="branch-merge-request"]') as HTMLButtonElement).click();
  assert.deepEqual(calls, ['drop:merged', 'push:feature', 'mr:feature']);
});

test('renderBranches omits write actions when no handlers are given', () => {
  const target = document.createElement('div');
  renderBranches(target, {
    available: true,
    current: 'main',
    head: 'h',
    base: { name: 'main', hash: 'h', source: 'conventional' },
    capped: false,
    branches: [
      { name: 'main', kind: 'local', current: true, isBase: true, tip: tip('2026-09-20'), upstream: null, againstBase: null },
      { name: 'feature', kind: 'local', current: false, isBase: false, tip: tip('2026-09-20'), upstream: null, againstBase: { ahead: 4, behind: 0, merged: false } },
    ],
  });
  assert.equal(target.querySelector('[data-role="branch-actions"]'), null);
});

test('renderBranchDivergence offers push and create-MR actions', () => {
  const target = document.createElement('div');
  const calls: string[] = [];
  renderBranchDivergence(
    target,
    {
      branch: 'feature',
      base: 'main',
      tipHash: 't',
      baseHash: 'b',
      mergeBase: 'abcdef123456',
      ahead: 2,
      behind: 1,
      baseChanged: [],
      baseChangedCapped: false,
      overlap: [],
      conflicts: { available: true, clean: true, paths: [] },
      movedUnderneath: [],
      checkedOut: true,
    },
    {
      onPush: (name: string) => calls.push(`push:${name}`),
      onMergeRequest: (name: string) => calls.push(`mr:${name}`),
    },
  );

  const actions = target.querySelector('[data-role="review-branch-actions"]');
  assert.ok(actions);
  (actions.querySelector('[data-role="branch-push"]') as HTMLButtonElement).click();
  (actions.querySelector('[data-role="branch-merge-request"]') as HTMLButtonElement).click();
  assert.deepEqual(calls, ['push:feature', 'mr:feature']);
});

test('renderBranches says why no branches are listed', () => {
  const target = document.createElement('div');
  renderBranches(target, { available: false, reason: 'no-git', detail: 'not a git repository' });
  assert.equal(target.querySelector('[data-role="branches-unavailable"]')?.textContent, 'No branches: not a git repository');
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

test('renderReview offers Back to the previous review, disabled when there is none', () => {
  const review = {
    available: true,
    kind: 'commit',
    commit: { shortHash: 'abc1234', author: 'Ada', date: '2026-09-21T00:00:00Z', subject: 'Change' },
    files: [],
    totals: { files: 0, insertions: 0, deletions: 0, uncounted: 0 },
    impact: { affected: [], outsideGraph: [] },
  };
  let backs = 0;
  const onBack = () => {
    backs += 1;
  };

  const first = document.createElement('div');
  renderReview(first, review, { onBack, canGoBack: false });
  const disabled = first.querySelector('[data-role="panel-back"]') as HTMLButtonElement;
  assert.equal(disabled.disabled, true);
  disabled.click();
  assert.equal(backs, 0);

  const deeper = document.createElement('div');
  renderReview(deeper, review, { onBack, canGoBack: true });
  const back = deeper.querySelector('[data-role="panel-back"]') as HTMLButtonElement;
  assert.equal(back.disabled, false);
  back.click();
  assert.equal(backs, 1);

  const loading = document.createElement('div');
  renderReviewLoading(loading, { onBack, canGoBack: true });
  (loading.querySelector('[data-role="panel-back"]') as HTMLButtonElement).click();
  assert.equal(backs, 2);
});
