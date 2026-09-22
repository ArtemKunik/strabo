import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  buildCommitEvidence,
  commitWorkingTree,
  normalizeCommitMessage,
  type ReviewResult,
} from '../../src/index.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(prefix = 'strabo-commit-'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(directory);
  return directory;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    stdio: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).toString();
}

interface Fixture {
  root: string;
  remote: string;
}

/** A local repo tracking a bare `origin` remote, with `main` pushed. */
function makeFixture(): Fixture {
  const base = tempDir();
  const remote = path.join(base, 'remote.git');
  const root = path.join(base, 'local');
  fs.mkdirSync(remote, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  git(remote, 'init', '--bare', '-q', '-b', 'main');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Tester');
  fs.writeFileSync(path.join(root, 'file.txt'), 'one\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'one');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', '-q', 'origin', 'main');
  return { root, remote };
}

test('normalizeCommitMessage trims, bounds, and rejects an empty message', () => {
  assert.equal(normalizeCommitMessage('  hello\n\nworld  '), 'hello\n\nworld');
  assert.equal(normalizeCommitMessage(''), null);
  assert.equal(normalizeCommitMessage('   '), null);
  assert.equal(normalizeCommitMessage(42), null);
  assert.equal(normalizeCommitMessage(undefined), null);
  const long = normalizeCommitMessage('x'.repeat(9000));
  assert.equal(long?.length, 8000);
});

test('buildCommitEvidence names the changed files, the impact, and outside paths', () => {
  const review: ReviewResult = {
    available: true,
    kind: 'working-tree',
    files: [
      {
        path: 'src/a.ts',
        status: 'modified',
        group: 'unstaged',
        insertions: 3,
        deletions: 1,
        inGraph: true,
      },
      {
        path: 'src/new.ts',
        status: 'untracked',
        group: 'untracked',
        insertions: 5,
        deletions: 0,
        inGraph: true,
      },
    ],
    totals: { files: 2, insertions: 8, deletions: 1, uncounted: 0 },
    impact: {
      affected: [
        { id: 'src/a.ts', distance: 0 },
        { id: 'src/b.ts', distance: 1 },
      ],
      outsideGraph: ['docs/readme.md'],
    },
  };
  const evidence = buildCommitEvidence(review);
  assert.match(evidence, /2 file\(s\) changed · \+8 −1/);
  assert.match(evidence, /- modified · src\/a\.ts · \+3 −1/);
  assert.match(evidence, /- untracked · src\/new\.ts · \+5 −0/);
  assert.match(evidence, /src\/b\.ts \(distance 1\)/);
  // A distance-0 entry is a changed file, not a dependent, so it is not repeated as impact.
  assert.doesNotMatch(evidence, /src\/a\.ts \(distance 0\)/);
  assert.match(evidence, /outside the scanned graph: docs\/readme\.md/);
});

test('commitWorkingTree commits the working tree and pushes the current branch', async () => {
  const { root, remote } = makeFixture();
  const before = git(root, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(root, 'file.txt'), 'two\n');
  fs.writeFileSync(path.join(root, 'added.txt'), 'new file\n');

  const result = await commitWorkingTree(root, 'feat: update file\n\nAnd add one.', { push: true });
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.subject, 'feat: update file');
  assert.equal(result.branch, 'main');
  assert.equal(result.pushed, true);
  assert.equal(result.files, 2);
  assert.match(result.message, /^Committed [0-9a-f]+ and pushed main to origin\.$/);

  const head = git(root, 'rev-parse', 'HEAD').trim();
  assert.notEqual(head, before);
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  // The commit reached the remote: origin/main now matches local HEAD.
  assert.equal(git(remote, 'rev-parse', 'refs/heads/main').trim(), head);
  // The working tree is clean after the commit.
  assert.equal(git(root, 'status', '--porcelain').trim(), '');
});

test('commitWorkingTree leaves the commit in place when the push is refused', async () => {
  const { root } = makeFixture();
  // Remove every remote so the push has nowhere to go.
  git(root, 'remote', 'remove', 'origin');
  fs.writeFileSync(path.join(root, 'file.txt'), 'three\n');
  const result = await commitWorkingTree(root, 'chore: update', { push: true });
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.pushed, false);
  assert.equal(result.pushReason, 'no-remote');
  // The commit happened even though the push did not.
  assert.equal(git(root, 'log', '-1', '--pretty=%s').trim(), 'chore: update');
});

test('commitWorkingTree reports nothing to commit and an empty message', async () => {
  const { root } = makeFixture();
  const clean = await commitWorkingTree(root, 'noop');
  assert.equal(clean.available, false);
  if (clean.available) return;
  assert.equal(clean.reason, 'nothing-to-commit');

  fs.writeFileSync(path.join(root, 'file.txt'), 'four\n');
  const empty = await commitWorkingTree(root, '   ');
  assert.equal(empty.available, false);
  if (empty.available) return;
  assert.equal(empty.reason, 'empty-message');
  // Nothing was committed by the rejected call.
  assert.equal(git(root, 'log', '-1', '--pretty=%s').trim(), 'one');
});

test('commitWorkingTree refuses a directory that is not a repository', async () => {
  const directory = tempDir('strabo-nogit-');
  const result = await commitWorkingTree(directory, 'message');
  assert.equal(result.available, false);
  if (result.available) return;
  assert.equal(result.reason, 'no-git');
});
