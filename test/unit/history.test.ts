import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { clearHistoryCache, collectHistory, parseHistory } from '../../src/analysis/history.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-history-'));
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
  git(root, 'config', 'commit.gpgsign', 'false');
}

const separator = '\u001f';
const record = '\u001e';

test('parseHistory counts churn, authors, and co-change partners', () => {
  const stdout = [
    `${record}aaa${separator}Ada\n\n1\t0\tsrc/a.ts\n1\t0\tsrc/b.ts\n`,
    `${record}bbb${separator}Grace\n\n2\t1\tsrc/a.ts\n`,
  ].join('\n');

  const summary = parseHistory(stdout, new Set(['src/a.ts', 'src/b.ts']), 90, 50);

  assert.equal(summary.available, true);
  assert.equal(summary.commitsScanned, 2);
  assert.equal(summary.windowDays, 90);
  assert.equal(summary.churn.get('src/a.ts'), 2);
  assert.equal(summary.churn.get('src/b.ts'), 1);
  assert.deepEqual(summary.authors.get('src/a.ts'), { authors: ['Ada', 'Grace'], commits: 2 });
  assert.deepEqual(summary.authors.get('src/b.ts'), { authors: ['Ada'], commits: 1 });
  assert.deepEqual([...(summary.coChange.get('src/a.ts') ?? [])], ['src/b.ts']);
  assert.deepEqual([...(summary.coChange.get('src/b.ts') ?? [])], ['src/a.ts']);
  assert.deepEqual(summary.skippedCommits, []);
});

test('parseHistory skips a mass commit from co-change but still counts churn', () => {
  const stdout = `${record}ccc${separator}Ada\n\n1\t0\tsrc/a.ts\n1\t0\tsrc/b.ts\n1\t0\tsrc/c.ts\n`;
  const summary = parseHistory(stdout, new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']), 90, 2);

  assert.equal(summary.churn.get('src/a.ts'), 1);
  assert.equal(summary.coChange.size, 0);
  assert.deepEqual(summary.skippedCommits, [{ hash: 'ccc', files: 3 }]);
});

test('collectHistory reads churn, authors, and co-change from a repository', async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'src/b.ts'), 'export const b = 2;\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  fs.appendFileSync(path.join(root, 'src/a.ts'), '// second\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'second');

  clearHistoryCache();
  const summary = await collectHistory(root, ['src/a.ts', 'src/b.ts'], { windowDays: 3650 });

  assert.equal(summary.available, true);
  assert.equal(summary.churn.get('src/a.ts'), 2);
  assert.equal(summary.churn.get('src/b.ts'), 1);
  assert.equal(summary.authors.get('src/a.ts')?.commits, 2);
  assert.deepEqual([...(summary.coChange.get('src/a.ts') ?? [])], ['src/b.ts']);

  // A second read for the same HEAD and file set is served from the cache.
  const again = await collectHistory(root, ['src/a.ts', 'src/b.ts'], { windowDays: 3650 });
  assert.equal(again, summary);
});

test('collectHistory reports unavailable history without Git', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  clearHistoryCache();

  const summary = await collectHistory(root, ['a.ts']);
  assert.equal(summary.available, false);
  assert.equal(summary.churn.size, 0);
  assert.deepEqual(summary.skippedCommits, []);
});
