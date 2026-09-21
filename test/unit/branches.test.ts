import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  computeRangeMetrics,
  listBranches,
  parseMergeTreeConflicts,
  parseRefs,
  parseTrack,
  reviewBranch,
  scanRepository,
} from '../../src/index.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-branches-'));
  created.push(directory);
  return directory;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
}

function write(root: string, file: string, content: string): void {
  fs.writeFileSync(path.join(root, file), content);
}

function commitAll(root: string, message: string): void {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
}

/**
 * main:     init ── base: edit b.ts, shared.ts ── (HEAD)
 *              └── feature: edit a.ts, shared.ts (conflicts with main) ── two commits
 *              └── done: merged back into main
 */
function fixture(): string {
  const root = tempDir();
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Tester');
  write(root, 'a.ts', "import { b } from './b.ts';\nexport const a = b;\n");
  write(root, 'b.ts', 'export const b = 1;\n');
  write(root, 'c.ts', "import { a } from './a.ts';\nexport const c = a;\n");
  write(root, 'shared.ts', 'export const shared = 1;\n');
  commitAll(root, 'init');

  git(root, 'checkout', '-q', '-b', 'done');
  write(root, 'd.ts', 'export const d = 1;\n');
  commitAll(root, 'done work');
  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '-q', '--no-ff', '-m', 'merge done', 'done');

  git(root, 'checkout', '-q', '-b', 'feature');
  write(root, 'a.ts', "import { b } from './b.ts';\nexport const a = b + 1;\n");
  commitAll(root, 'feature one');
  write(root, 'shared.ts', 'export const shared = 2;\n');
  commitAll(root, 'feature two');

  git(root, 'checkout', '-q', 'main');
  write(root, 'b.ts', 'export const b = 10;\n');
  write(root, 'shared.ts', 'export const shared = 3;\n');
  commitAll(root, 'main moves on');
  return root;
}

test('parseTrack reads in-sync, diverged, and gone upstreams', () => {
  assert.deepEqual(parseTrack('origin/x', ''), { name: 'origin/x', ahead: 0, behind: 0, gone: false });
  assert.deepEqual(parseTrack('origin/x', 'ahead 2, behind 5'), { name: 'origin/x', ahead: 2, behind: 5, gone: false });
  assert.deepEqual(parseTrack('origin/x', 'behind 1'), { name: 'origin/x', ahead: 0, behind: 1, gone: false });
  assert.equal(parseTrack('origin/x', 'gone').gone, true);
});

test('parseMergeTreeConflicts skips the tree id and de-duplicates stage entries', () => {
  assert.deepEqual(parseMergeTreeConflicts('abc123\0shared.ts\0a.ts\0shared.ts\0\0'), ['a.ts', 'shared.ts']);
});

test('parseRefs drops a remote HEAD and marks remotes and the current branch', () => {
  const row = (...fields: string[]) => fields.join('\u001f');
  const stdout = [
    row('refs/heads/main', 'main', '*', 'h1', 'h1', 'A', '2026-01-01', 's', 'origin/main', ''),
    row('refs/remotes/origin/HEAD', 'origin', ' ', 'h1', 'h1', 'A', '2026-01-01', 's', '', ''),
    row('refs/remotes/origin/x', 'origin/x', ' ', 'h2', 'h2', 'B', '2026-01-02', 't', '', ''),
  ].join('\n');
  const rows = parseRefs(stdout);
  assert.deepEqual(
    rows.map((entry) => [entry.name, entry.kind, entry.current]),
    [
      ['main', 'local', true],
      ['origin/x', 'remote', false],
    ],
  );
});

test('listBranches reports divergence from the base and which branches are merged', async () => {
  const root = fixture();
  const result = await listBranches(root);
  assert.equal(result.available, true);
  if (!result.available) return;

  assert.equal(result.current, 'main');
  assert.equal(result.base?.name, 'main');
  assert.equal(result.base?.source, 'conventional');

  const byName = new Map(result.branches.map((branch) => [branch.name, branch]));
  assert.equal(byName.get('main')?.isBase, true);
  assert.equal(byName.get('main')?.againstBase, null);
  assert.deepEqual(byName.get('feature')?.againstBase, { ahead: 2, behind: 1, merged: false });
  assert.equal(byName.get('done')?.againstBase?.merged, true);
  assert.equal(byName.get('feature')?.upstream, null);
});

test('listBranches compares with a requested base and rejects an unknown one', async () => {
  const root = fixture();
  const result = await listBranches(root, 'feature');
  assert.equal(result.available, true);
  if (!result.available) return;
  const main = result.branches.find((branch) => branch.name === 'main');
  assert.deepEqual(main?.againstBase, { ahead: 1, behind: 2, merged: false });

  const unknown = await listBranches(root, 'no-such-branch');
  assert.equal(unknown.available, false);
  assert.equal(unknown.available === false && unknown.reason, 'unknown-revision');

  const option = await listBranches(root, '--output=/tmp/x');
  assert.equal(option.available, false);
});

test('reviewBranch reports the branch work, the trial-merge conflicts, and what moved underneath', async () => {
  const root = fixture();
  const report = await scanRepository(root);
  const review = await reviewBranch(root, report.graph, 'feature');
  assert.equal(review.available, true);
  if (!review.available || !review.branch) return;

  assert.equal(review.kind, 'branch');
  // Only the branch's own work, not main's newer b.ts edit.
  assert.deepEqual(
    review.files.map((file) => [file.path, file.group]),
    [
      ['a.ts', 'branch'],
      ['shared.ts', 'branch'],
    ],
  );
  assert.equal(review.branch.ahead, 2);
  assert.equal(review.branch.behind, 1);
  assert.deepEqual(review.branch.overlap, ['shared.ts']);
  assert.deepEqual(review.branch.conflicts, { available: true, clean: false, paths: ['shared.ts'] });
  // a.ts imports b.ts, which main changed after feature left it.
  assert.deepEqual(review.branch.movedUnderneath, [{ id: 'b.ts', via: 'a.ts', distance: 1 }]);
  assert.equal(review.branch.checkedOut, false);
  assert.ok(review.impact.affected.some((entry) => entry.id === 'c.ts' && entry.distance === 1));
});

test('reviewBranch reports a clean trial merge and an unknown branch', async () => {
  const root = fixture();
  const report = await scanRepository(root);
  git(root, 'checkout', '-q', '-b', 'clean', 'main');
  write(root, 'c.ts', "import { a } from './a.ts';\nexport const c = a * 2;\n");
  commitAll(root, 'clean change');
  git(root, 'checkout', '-q', 'main');

  const review = await reviewBranch(root, report.graph, 'clean');
  assert.equal(review.available && review.branch?.conflicts.available && review.branch.conflicts.clean, true);

  const missing = await reviewBranch(root, report.graph, 'nope');
  assert.equal(missing.available, false);
});

test('computeRangeMetrics measures a branch from its merge base', async () => {
  const root = fixture();
  const mergeBase = git(root, 'merge-base', 'main', 'feature').trim();
  const tip = git(root, 'rev-parse', 'feature').trim();
  const metrics = await computeRangeMetrics(root, mergeBase, tip);
  assert.equal(metrics.available, true);
  if (!metrics.available) return;
  assert.equal(metrics.kind, 'range');
  assert.equal(metrics.baseline, mergeBase);
  assert.deepEqual(metrics.files.map((file) => file.path).sort(), ['a.ts', 'shared.ts']);
});
