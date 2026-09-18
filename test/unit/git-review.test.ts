import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  getCommit,
  parseNameStatus,
  parseNumstat,
  reviewCommit,
  reviewWorkingTree,
} from '../../src/analysis/review.ts';
import { scanRepository } from '../../src/scan/scan.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-gitreview-'));
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

test('parseNameStatus reads add, modify, delete, and rename entries', () => {
  const separator = '\0';
  const stdout = [
    'M',
    'a.ts',
    'A',
    'b.ts',
    'D',
    'c.ts',
    'R100',
    'old.ts',
    'new.ts',
    '',
  ].join(separator);

  assert.deepEqual(parseNameStatus(stdout), [
    { path: 'a.ts', status: 'modified' },
    { path: 'b.ts', status: 'added' },
    { path: 'c.ts', status: 'deleted' },
    { path: 'new.ts', previousPath: 'old.ts', status: 'renamed' },
  ]);
});

test('parseNumstat reads counts and rename paths, and marks binary as null', () => {
  const separator = '\0';
  const stdout = ['3\t1\ta.ts', '-\t-\tlogo.png', '2\t0\t', 'old.ts', 'new.ts', ''].join(separator);

  const counts = parseNumstat(stdout);
  assert.deepEqual(counts.get('a.ts'), { insertions: 3, deletions: 1 });
  assert.deepEqual(counts.get('logo.png'), { insertions: null, deletions: null });
  assert.deepEqual(counts.get('new.ts'), { insertions: 2, deletions: 0 });
});

test('reviewCommit reports that commit own changes and their impact', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), "import { b } from './b.ts';\nexport const a = b;\n");
  fs.writeFileSync(path.join(root, 'b.ts'), 'export const b = 1;\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');

  fs.appendFileSync(path.join(root, 'b.ts'), '// edit b\nexport const extra = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'edit b');
  const ref = git(root, 'rev-parse', 'HEAD').trim();

  const report = await scanRepository(root);
  const result = await reviewCommit(root, report.graph, ref);

  assert.equal(result.available, true);
  if (result.available) {
    assert.equal(result.kind, 'commit');
    assert.equal(result.commit?.subject, 'edit b');
    assert.deepEqual(result.files.map((file) => [file.path, file.status, file.group]), [
      ['b.ts', 'modified', 'commit'],
    ]);
    assert.equal(result.files[0]?.insertions, 2);
    assert.equal(result.files[0]?.deletions, 0);
    assert.equal(result.files[0]?.inGraph, true);
    assert.equal(result.totals.files, 1);
    assert.equal(result.totals.insertions, 2);
    // a.ts imports b.ts, so editing b.ts can reach a.ts.
    assert.deepEqual(result.impact.affected, [
      { id: 'b.ts', distance: 0 },
      { id: 'a.ts', distance: 1 },
    ]);
  }
});

test('reviewCommit excludes later working-tree edits', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 2;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'second');
  const ref = git(root, 'rev-parse', 'HEAD').trim();

  // An uncommitted edit must not appear in the commit review.
  fs.appendFileSync(path.join(root, 'a.ts'), '// uncommitted\n');

  const report = await scanRepository(root);
  const result = await reviewCommit(root, report.graph, ref);

  assert.equal(result.available, true);
  if (result.available) {
    assert.deepEqual(result.files.map((file) => file.path), ['a.ts']);
    assert.equal(result.files[0]?.insertions, 1);
  }
});

test('reviewCommit resolves the root commit, which has no parent', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'root');
  const ref = git(root, 'rev-parse', 'HEAD').trim();

  const report = await scanRepository(root);
  const result = await reviewCommit(root, report.graph, ref);

  assert.equal(result.available, true);
  if (result.available) {
    assert.deepEqual(result.files.map((file) => [file.path, file.status]), [['a.ts', 'added']]);
    assert.equal(result.files[0]?.insertions, 1);
  }
});

test('reviewCommit reports an unknown revision without inventing changes', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');

  const report = await scanRepository(root);
  const result = await reviewCommit(root, report.graph, 'deadbeef');

  assert.equal(result.available, false);
  if (!result.available) {
    assert.equal(result.reason, 'unknown-revision');
  }
});

test('reviewWorkingTree splits staged, unstaged, and untracked', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), "import { b } from './b.ts';\nexport const a = b;\n");
  fs.writeFileSync(path.join(root, 'b.ts'), 'export const b = 1;\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');

  fs.appendFileSync(path.join(root, 'a.ts'), '// staged\n');
  git(root, 'add', 'a.ts');
  fs.appendFileSync(path.join(root, 'b.ts'), '// unstaged\n');
  fs.writeFileSync(path.join(root, 'fresh.ts'), 'export const fresh = 1;\n');

  const report = await scanRepository(root);
  const result = await reviewWorkingTree(root, report.graph);

  assert.equal(result.available, true);
  if (result.available) {
    assert.equal(result.kind, 'working-tree');
    assert.deepEqual(
      result.files.map((file) => [file.path, file.group, file.status]),
      [
        ['a.ts', 'staged', 'modified'],
        ['b.ts', 'unstaged', 'modified'],
        ['fresh.ts', 'untracked', 'untracked'],
      ],
    );
    const fresh = result.files.find((file) => file.path === 'fresh.ts');
    assert.equal(fresh?.insertions, 1);
    assert.equal(fresh?.deletions, 0);
    assert.equal(result.totals.files, 3);
    assert.equal(result.totals.uncounted, 0);
  }
});

test('reviewWorkingTree reports unavailable without Git', async () => {
  const root = tempDir();
  const report = await scanRepository(root);
  const result = await reviewWorkingTree(root, report.graph);

  assert.equal(result.available, false);
  if (!result.available) {
    assert.equal(result.reason, 'no-git');
  }
});

test('getCommit returns null for a revision that does not resolve', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');

  assert.equal(await getCommit(root, 'nope'), null);
  const head = git(root, 'rev-parse', 'HEAD').trim();
  assert.equal((await getCommit(root, head))?.subject, 'init');
});
