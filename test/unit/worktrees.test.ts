import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import express from 'express';

import { createSettingsStore, createStraboRouter } from '../../src/index.ts';
import type { StraboConfig } from '../../src/index.ts';
import { listWorktrees, parseWorktrees, resolveWorktree } from '../../src/analysis/worktrees.ts';

const created: string[] = [];
const servers: Array<ReturnType<typeof express.application.listen>> = [];

after(() => {
  for (const server of servers) {
    server.close();
  }
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(directory);
  return directory;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
}

function initRepo(root: string): void {
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Tester');
}

function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      servers.push(server);
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

test('parseWorktrees reads the main, linked, detached, and bare entries', () => {
  const stdout = [
    'worktree /repo/main',
    'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'branch refs/heads/main',
    '',
    'worktree /repo/linked',
    'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'branch refs/heads/feature',
    '',
    'worktree /repo/detached',
    'HEAD cccccccccccccccccccccccccccccccccccccccc',
    'detached',
    '',
    'worktree /repo/bare.git',
    'bare',
    '',
  ].join('\n');

  const worktrees = parseWorktrees(stdout, '/repo/main');
  const posix = (value: string) => path.resolve(value).replace(/\\/g, '/');
  assert.deepEqual(
    worktrees.map((entry) => [entry.path.replace(/\\/g, '/'), entry.branch, entry.main, entry.bare]),
    [
      [posix('/repo/main'), 'main', true, false],
      [posix('/repo/linked'), 'feature', false, false],
      [posix('/repo/detached'), null, false, false],
      [posix('/repo/bare.git'), null, false, true],
    ],
  );
});

test('listWorktrees and resolveWorktree find a linked checkout and reject the outside', async () => {
  const base = tempDir('strabo-worktrees-');
  const root = path.join(base, 'app');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');

  const linked = path.join(base, 'app-feature');
  git(root, 'worktree', 'add', '-q', '-b', 'feature', linked);

  const result = await listWorktrees(root);
  assert.equal(result.available, true);
  if (result.available) {
    const names = result.worktrees.map((entry) => path.basename(entry.path));
    assert.deepEqual(names, ['app', 'app-feature']);
    assert.equal(result.worktrees[0]?.main, true);
    assert.equal(result.worktrees[1]?.branch, 'feature');
  }

  const resolved = await resolveWorktree(root, linked, base);
  assert.ok(resolved, 'the linked worktree resolves');
  assert.equal(resolved?.branch, 'feature');

  const outside = await resolveWorktree(root, path.join(os.tmpdir(), 'elsewhere'), base);
  assert.equal(outside, null);
});

test('the review route reads the named worktree, and refuses one outside the repository', async () => {
  const base = tempDir('strabo-worktree-route-');
  const root = path.join(base, 'app');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');

  const linked = path.join(base, 'app-feature');
  git(root, 'worktree', 'add', '-q', '-b', 'feature', linked);
  // The agent's edit lives only in the linked checkout; the main root stays clean.
  fs.appendFileSync(path.join(linked, 'a.ts'), '// agent edit\n');

  const config: StraboConfig = { workspaceRoot: root, scanCeiling: base };
  // An isolated settings store: the operator's real persisted scan ceiling must not leak in
  // and override this test's temp ceiling.
  const settings = createSettingsStore({ file: path.join(base, 'strabo-settings.json') });
  const host = express();
  host.use('/api/strabo', createStraboRouter(config, undefined, settings));
  const server = await listen(host);
  const repository = `repository=${encodeURIComponent(root)}`;

  const worktrees = (await (await fetch(`${server}/api/strabo/analysis/worktrees?${repository}`)).json()) as {
    available: boolean;
    worktrees: Array<{ path: string; main: boolean }>;
  };
  assert.equal(worktrees.available, true);
  assert.equal(worktrees.worktrees.length, 2);

  const mainReview = (await (await fetch(`${server}/api/strabo/analysis/review?${repository}`)).json()) as {
    files: Array<{ path: string }>;
  };
  assert.deepEqual(mainReview.files, [], 'the main root has no pending changes');

  const linkedQuery = `${repository}&worktree=${encodeURIComponent(linked)}`;
  const linkedReview = (await (await fetch(`${server}/api/strabo/analysis/review?${linkedQuery}`)).json()) as {
    kind: string;
    files: Array<{ path: string }>;
    worktree?: { path: string; branch: string | null };
  };
  assert.equal(linkedReview.kind, 'working-tree');
  assert.deepEqual(linkedReview.files.map((file) => file.path), ['a.ts']);
  assert.equal(linkedReview.worktree?.branch, 'feature');

  const rejected = await fetch(
    `${server}/api/strabo/analysis/review?${repository}&worktree=${encodeURIComponent(base)}`,
  );
  assert.equal(rejected.status, 400);
});
