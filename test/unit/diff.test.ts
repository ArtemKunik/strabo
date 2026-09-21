import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import express from 'express';

import { diffFile, parseHunkHeader, parseUnifiedDiff } from '../../src/analysis/diff.ts';
import { createRepositoryStore, createStraboRouter } from '../../src/index.ts';
import type { StraboConfig } from '../../src/index.ts';
import { createSettingsStore } from '../../src/state/settings-store.ts';

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

function tempDir(prefix = 'strabo-diff-'): string {
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
  git(root, 'config', 'core.autocrlf', 'false');
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

const CHANGE = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@ function outer() {',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' export { a, b };',
  '',
].join('\n');

test('parseUnifiedDiff numbers each line on both sides of the change', () => {
  const diff = parseUnifiedDiff(CHANGE, 'src/a.ts');

  assert.equal(diff.file, 'src/a.ts');
  assert.equal(diff.binary, false);
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 1);
  assert.equal(diff.hunks.length, 1);

  const hunk = diff.hunks[0];
  assert.equal(hunk.header, '@@ -1,3 +1,4 @@ function outer() {');
  assert.deepEqual(
    hunk.lines.map((line) => [line.kind, line.oldLine, line.newLine, line.text]),
    [
      ['context', 1, 1, 'const a = 1;'],
      ['del', 2, null, 'const b = 2;'],
      ['add', null, 2, 'const b = 3;'],
      ['add', null, 3, 'const c = 4;'],
      ['context', 3, 4, 'export { a, b };'],
    ],
  );
});

test('parseUnifiedDiff keeps the file header out of the changes', () => {
  const diff = parseUnifiedDiff(CHANGE, 'src/a.ts');
  assert.deepEqual(diff.header, [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
  ]);
});

test('parseUnifiedDiff reports equal sides as no hunks and binary as a marker', () => {
  assert.deepEqual(parseUnifiedDiff('', 'a.bin').hunks, []);
  const binary = parseUnifiedDiff('diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n', 'logo.png');
  assert.equal(binary.binary, true);
  assert.deepEqual(binary.hunks, []);
  assert.equal(binary.added, 0);
});

test('parseUnifiedDiff drops the no-newline marker and a single added line', () => {
  const diff = parseUnifiedDiff(
    ['@@ -1 +1 @@', '-old', '+new', '\\ No newline at end of file', ''].join('\n'),
    'a.txt',
  );
  assert.deepEqual(
    diff.hunks[0].lines.map((line) => [line.kind, line.oldLine, line.newLine]),
    [
      ['del', 1, null],
      ['add', null, 1],
    ],
  );
});

test('parseHunkHeader reads a count of zero and defaults an omitted count to one', () => {
  assert.deepEqual(parseHunkHeader('@@ -0,0 +1,12 @@'), { oldStart: 0, oldLines: 0, newStart: 1, newLines: 12 });
  assert.deepEqual(parseHunkHeader('@@ -5 +5 @@'), { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 });
  assert.equal(parseHunkHeader('not a hunk'), null);
});

test('diffFile reads one commit own change against its first parent', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), ['one', 'two', 'three', ''].join('\n'));
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(root, 'a.ts'), ['one', 'two', 'three', 'four', ''].join('\n'));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'add four');

  const result = await diffFile(root, { file: 'a.ts', ref: 'HEAD' });
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.side, 'commit');
  assert.equal(result.diff.added, 1);
  assert.equal(result.diff.removed, 0);
  assert.deepEqual(result.diff.hunks.at(-1)?.lines.at(-1), { kind: 'add', text: 'four', oldLine: null, newLine: 4 });
});

test('diffFile separates staged from unstaged and reads an untracked file whole', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), 'one\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');

  fs.writeFileSync(path.join(root, 'a.ts'), 'one\nstaged\n');
  git(root, 'add', 'a.ts');
  fs.writeFileSync(path.join(root, 'a.ts'), 'one\nstaged\nunstaged\n');
  fs.writeFileSync(path.join(root, 'new.ts'), 'alpha\nbeta\n');

  const staged = await diffFile(root, { file: 'a.ts', staged: true });
  const unstaged = await diffFile(root, { file: 'a.ts' });
  const untracked = await diffFile(root, { file: 'new.ts', untracked: true });

  assert.equal(staged.available && staged.side, 'staged');
  assert.equal(unstaged.available && unstaged.side, 'unstaged');
  assert.equal(unstaged.available && unstaged.diff.added, 1);
  assert.equal(untracked.available && untracked.side, 'untracked');
  if (untracked.available) {
    assert.deepEqual(
      untracked.diff.hunks[0].lines.map((line) => [line.kind, line.newLine, line.text]),
      [
        ['add', 1, 'alpha'],
        ['add', 2, 'beta'],
      ],
    );
  }
});

test('diffFile diffs a range between two revisions', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), 'one\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(root, 'a.ts'), 'one\ntwo\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'two');

  const result = await diffFile(root, { file: 'a.ts', base: 'HEAD~1', head: 'HEAD' });
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.side, 'range');
  assert.equal(result.diff.added, 1);
});

test('diffFile names an unknown revision and a non-repository rather than an empty change', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), 'one\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');

  const unknown = await diffFile(root, { file: 'a.ts', ref: 'does-not-exist' });
  assert.equal(unknown.available, false);
  assert.equal(unknown.available === false && unknown.reason, 'unknown-revision');

  const plain = tempDir('strabo-nogit-');
  fs.writeFileSync(path.join(plain, 'a.ts'), 'one\n');
  const noGit = await diffFile(plain, { file: 'a.ts' });
  assert.equal(noGit.available, false);
  assert.equal(noGit.available === false && noGit.reason, 'no-git');
});

test('the file routes serve the working tree, a revision, and a change', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), ['one', 'two', ''].join('\n'));
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(root, 'a.ts'), ['one', 'two', 'three', ''].join('\n'));

  const config: StraboConfig = { workspaceRoot: root, scanCeiling: os.tmpdir() };
  const host = express();
  host.use(
    '/api/strabo',
    createStraboRouter(
      config,
      createRepositoryStore({ file: path.join(tempDir(), 'repositories.json') }),
      createSettingsStore({ file: path.join(tempDir(), 'settings.json') }),
    ),
  );
  const base = await listen(host);
  const repository = `repository=${encodeURIComponent(root)}`;

  const source = (await (await fetch(`${base}/api/strabo/source?${repository}&file=a.ts`)).json()) as {
    file: string;
    content: string;
  };
  assert.equal(source.file, 'a.ts');
  assert.match(source.content, /three/);

  const historic = (await (
    await fetch(`${base}/api/strabo/source?${repository}&file=a.ts&ref=HEAD`)
  ).json()) as { ref: string; content: string };
  assert.equal(historic.ref, 'HEAD');
  assert.doesNotMatch(historic.content, /three/);

  const diff = (await (await fetch(`${base}/api/strabo/diff?${repository}&file=a.ts`)).json()) as {
    available: boolean;
    side?: string;
    diff?: { added: number };
  };
  assert.equal(diff.available, true);
  assert.equal(diff.side, 'unstaged');
  assert.equal(diff.diff?.added, 1);

  const missing = await fetch(`${base}/api/strabo/diff?${repository}`);
  assert.equal(missing.status, 400);

  const escaped = await fetch(`${base}/api/strabo/diff?${repository}&file=${encodeURIComponent('../escape.ts')}`);
  assert.equal(escaped.status, 400);
});
