import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  dropBranches,
  forgeMergeRequestUrl,
  isSafeBranch,
  parseRemoteUrl,
  pushBranch,
} from '../../src/index.ts';

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

test('parseRemoteUrl reads SCP-like and URL remotes', () => {
  assert.deepEqual(parseRemoteUrl('git@github.com:acme/strabo.git'), { host: 'github.com', path: 'acme/strabo' });
  assert.deepEqual(parseRemoteUrl('https://gitlab.com/group/sub/repo.git'), { host: 'gitlab.com', path: 'group/sub/repo' });
  assert.deepEqual(parseRemoteUrl('ssh://git@git.example.com:2222/team/repo.git'), {
    host: 'git.example.com',
    path: 'team/repo',
  });
  assert.equal(parseRemoteUrl(''), null);
});

test('forgeMergeRequestUrl builds GitHub, GitLab, and Bitbucket links', () => {
  const github = forgeMergeRequestUrl('git@github.com:acme/strabo.git', 'feature/x', 'main');
  assert.equal(github.available, true);
  if (github.available) {
    assert.equal(github.forge, 'github');
    assert.equal(github.url, 'https://github.com/acme/strabo/compare/main...feature%2Fx?expand=1');
  }

  const gitlab = forgeMergeRequestUrl('https://gitlab.com/group/repo.git', 'feature/x', 'main');
  assert.equal(gitlab.available, true);
  if (gitlab.available) {
    assert.equal(gitlab.forge, 'gitlab');
    assert.match(gitlab.url, /^https:\/\/gitlab\.com\/group\/repo\/-\/merge_requests\/new\?/);
    assert.match(gitlab.url, /source_branch%5D=feature%2Fx/);
    assert.match(gitlab.url, /target_branch%5D=main/);
  }

  const bitbucket = forgeMergeRequestUrl('git@bitbucket.org:acme/repo.git', 'feature', 'main');
  assert.equal(bitbucket.available, true);
  if (bitbucket.available) {
    assert.equal(bitbucket.url, 'https://bitbucket.org/acme/repo/pull-requests/new?source=feature&dest=main');
  }
});

test('forgeMergeRequestUrl names the repository but admits an unknown forge', () => {
  const result = forgeMergeRequestUrl('git@git.example.com:team/repo.git', 'feature', 'main');
  assert.equal(result.available, false);
  if (!result.available) {
    assert.equal(result.reason, 'unknown-forge');
    assert.equal(result.webUrl, 'https://git.example.com/team/repo');
  }
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
  assert.equal(result.published, true);
  assert.equal(result.remote, 'origin');
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

test('dropBranches deletes a branch merged into the base and skips the rest', async () => {
  const { root } = makeFixture();
  git(root, 'checkout', '-q', '-b', 'merged');
  fs.writeFileSync(path.join(root, 'merged.txt'), 'x\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'merged work');
  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '-q', '--ff-only', 'merged');

  const result = await dropBranches(root, ['merged', 'main', 'missing']);
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.deepEqual(result.dropped, ['merged']);
  const skipped = new Map(result.skipped.map((entry) => [entry.name, entry.reason]));
  assert.equal(skipped.get('main'), 'not-current');
  assert.equal(skipped.get('missing'), 'unknown-branch');
  assert.equal(
    execFileSync('git', ['branch', '--list', 'merged'], { cwd: root, stdio: 'pipe' }).toString().trim(),
    '',
  );
});

test('dropBranches drops a branch whose upstream is gone', async () => {
  const { root, remote } = makeFixture();
  git(root, 'checkout', '-q', '-b', 'abandoned');
  fs.writeFileSync(path.join(root, 'abandoned.txt'), 'x\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'abandoned work');
  git(root, 'push', '-u', '-q', 'origin', 'abandoned');
  git(root, 'checkout', '-q', 'main');
  git(remote, 'update-ref', '-d', 'refs/heads/abandoned');
  git(root, 'update-ref', '-d', 'refs/remotes/origin/abandoned');

  const result = await dropBranches(root, ['abandoned']);
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.deepEqual(result.dropped, ['abandoned']);
});

test('dropBranches refuses a live, unmerged branch', async () => {
  const { root } = makeFixture();
  git(root, 'checkout', '-q', '-b', 'wip');
  fs.writeFileSync(path.join(root, 'wip.txt'), 'x\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'wip');
  git(root, 'checkout', '-q', 'main');

  const result = await dropBranches(root, ['wip']);
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.deepEqual(result.dropped, []);
  assert.equal(result.skipped.find((entry) => entry.name === 'wip')?.reason, 'not-stale');
});
