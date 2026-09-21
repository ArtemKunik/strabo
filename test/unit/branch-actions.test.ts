import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { fetchBranches, isSafeBranch, pullBranch, pushBranch, syncBranch } from '../../src/index.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(prefix = 'strabo-branch-'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(directory);
  return directory;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).toString();
}

function configure(root: string): void {
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Tester');
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
  configure(root);
  fs.writeFileSync(path.join(root, 'file.txt'), 'one\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'one');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', '-q', 'origin', 'main');
  return { root, remote };
}

function head(root: string): string {
  return git(root, 'rev-parse', 'HEAD').trim();
}

test('isSafeBranch rejects option-like and ref-expression names', () => {
  assert.equal(isSafeBranch('feature/x'), true);
  assert.equal(isSafeBranch('release-1.2'), true);
  assert.equal(isSafeBranch('--force'), false);
  assert.equal(isSafeBranch('-x'), false);
  assert.equal(isSafeBranch('main..other'), false);
  assert.equal(isSafeBranch('feature@{1}'), false);
  assert.equal(isSafeBranch('trailing/'), false);
  assert.equal(isSafeBranch('trailing.'), false);
});

test('pushBranch sends a local commit to the upstream remote', () => {
  const { root, remote } = makeFixture();
  fs.writeFileSync(path.join(root, 'file.txt'), 'two\n');
  git(root, 'commit', '-aqm', 'two');

  return pushBranch(root, 'main').then((result) => {
    assert.equal(result.available, true);
    if (!result.available) return;
    assert.equal(result.action, 'push');
    assert.equal(result.pushed, true);
    assert.equal(git(remote, 'rev-parse', 'refs/heads/main').trim(), head(root));
  });
});

test('pushBranch publishes a branch with no upstream and sets it', async () => {
  const { root, remote } = makeFixture();
  git(root, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(root, 'feature.txt'), 'x\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'feature work');

  const result = await pushBranch(root, 'feature');
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.pushed, true);
  assert.equal(git(remote, 'rev-parse', 'refs/heads/feature').trim(), head(root));
  assert.equal(git(root, 'config', '--get', 'branch.feature.remote').trim(), 'origin');
});

test('pushBranch refuses an option-like branch name without running git', async () => {
  const { root } = makeFixture();
  const result = await pushBranch(root, '--force');
  assert.equal(result.available, false);
  if (result.available) return;
  assert.equal(result.reason, 'unknown-branch');
});

test('fetchBranches updates remote-tracking refs from the upstream remote', async () => {
  const { root, remote } = makeFixture();
  const peer = tempDir('strabo-branch-peer-');
  git(peer, 'clone', '-q', remote, '.');
  configure(peer);
  fs.writeFileSync(path.join(peer, 'file.txt'), 'from peer\n');
  git(peer, 'commit', '-aqm', 'peer change');
  git(peer, 'push', '-q', 'origin', 'main');
  const peerTip = git(peer, 'rev-parse', 'HEAD').trim();

  const result = await fetchBranches(root);
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.deepEqual(result.remotes, ['origin']);
  assert.equal(git(root, 'rev-parse', 'origin/main').trim(), peerTip);
});

test('fetchBranches reports an unknown remote rather than passing it through', async () => {
  const { root } = makeFixture();
  const result = await fetchBranches(root, 'nope');
  assert.equal(result.available, false);
  if (result.available) return;
  assert.equal(result.reason, 'unknown-remote');
});

test('syncBranch fast-forwards a branch that is only behind', async () => {
  const { root, remote } = makeFixture();
  const peer = tempDir('strabo-branch-peer-');
  git(peer, 'clone', '-q', remote, '.');
  configure(peer);
  fs.writeFileSync(path.join(peer, 'file.txt'), 'from peer\n');
  git(peer, 'commit', '-aqm', 'peer change');
  git(peer, 'push', '-q', 'origin', 'main');
  const peerTip = git(peer, 'rev-parse', 'HEAD').trim();

  const result = await syncBranch(root, 'main');
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.fastForwarded, true);
  assert.equal(result.pushed, false);
  assert.equal(head(root), peerTip);
});

test('syncBranch reports a diverged branch instead of merging it', async () => {
  const { root, remote } = makeFixture();
  const peer = tempDir('strabo-branch-peer-');
  git(peer, 'clone', '-q', remote, '.');
  configure(peer);
  fs.writeFileSync(path.join(peer, 'file.txt'), 'from peer\n');
  git(peer, 'commit', '-aqm', 'peer change');
  git(peer, 'push', '-q', 'origin', 'main');

  fs.writeFileSync(path.join(root, 'local.txt'), 'local\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'local change');

  const result = await syncBranch(root, 'main');
  assert.equal(result.available, false);
  if (result.available) return;
  assert.equal(result.reason, 'not-fast-forward');
});

test('syncBranch only runs on the checked-out branch', async () => {
  const { root } = makeFixture();
  git(root, 'branch', 'other');
  const result = await syncBranch(root, 'other');
  assert.equal(result.available, false);
  if (result.available) return;
  assert.equal(result.reason, 'not-current');
});

test('pullBranch fast-forwards the checked-out branch without pushing', async () => {
  const { root, remote } = makeFixture();
  const peer = tempDir('strabo-branch-peer-');
  git(peer, 'clone', '-q', remote, '.');
  configure(peer);
  fs.writeFileSync(path.join(peer, 'file.txt'), 'from peer\n');
  git(peer, 'commit', '-aqm', 'peer change');
  git(peer, 'push', '-q', 'origin', 'main');
  const peerTip = git(peer, 'rev-parse', 'HEAD').trim();

  const result = await pullBranch(root, 'main');
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.action, 'pull');
  assert.equal(result.fastForwarded, true);
  assert.equal(result.pushed, false);
  assert.equal(head(root), peerTip);
});

test('pullBranch advances a branch that is not checked out through its ref', async () => {
  const { root, remote } = makeFixture();
  git(root, 'branch', 'other');
  git(root, 'branch', '--set-upstream-to=origin/main', 'other');

  const peer = tempDir('strabo-branch-peer-');
  git(peer, 'clone', '-q', remote, '.');
  configure(peer);
  fs.writeFileSync(path.join(peer, 'file.txt'), 'from peer\n');
  git(peer, 'commit', '-aqm', 'peer change');
  git(peer, 'push', '-q', 'origin', 'main');
  const peerTip = git(peer, 'rev-parse', 'HEAD').trim();

  const result = await pullBranch(root, 'other');
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.fastForwarded, true);
  assert.equal(git(root, 'rev-parse', 'other').trim(), peerTip);
  assert.equal(head(root), git(root, 'rev-parse', 'main').trim());
});

test('pullBranch reports a diverged branch instead of merging it', async () => {
  const { root, remote } = makeFixture();
  const peer = tempDir('strabo-branch-peer-');
  git(peer, 'clone', '-q', remote, '.');
  configure(peer);
  fs.writeFileSync(path.join(peer, 'file.txt'), 'from peer\n');
  git(peer, 'commit', '-aqm', 'peer change');
  git(peer, 'push', '-q', 'origin', 'main');

  fs.writeFileSync(path.join(root, 'local.txt'), 'local\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'local change');

  const result = await pullBranch(root, 'main');
  assert.equal(result.available, false);
  if (result.available) return;
  assert.equal(result.action, 'pull');
  assert.equal(result.reason, 'not-fast-forward');
});

test('pullBranch says when there is nothing to pull and refuses a branch with no upstream', async () => {
  const { root } = makeFixture();
  const upToDate = await pullBranch(root, 'main');
  assert.equal(upToDate.available, true);
  if (!upToDate.available) return;
  assert.equal(upToDate.fastForwarded, false);
  assert.match(upToDate.message, /up to date/);

  git(root, 'checkout', '-q', '-b', 'feature');
  const noUpstream = await pullBranch(root, 'feature');
  assert.equal(noUpstream.available, false);
  if (noUpstream.available) return;
  assert.equal(noUpstream.reason, 'no-upstream');
});

test('a directory outside Git is reported as no-git rather than throwing', async () => {
  const root = tempDir('strabo-branch-plain-');
  const result = await fetchBranches(root);
  assert.equal(result.available, false);
  if (result.available) return;
  assert.equal(result.reason, 'no-git');
});
