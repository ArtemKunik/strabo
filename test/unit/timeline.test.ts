import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { computeImpact } from '../../src/index.ts';
import { getTimeline, parseTimeline } from '../../src/index.ts';
import { scanRepository } from '../../src/index.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-timeline-'));
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

test('parseTimeline reads the git log field format', () => {
  const separator = '\u001f';
  const stdout = [
    `abc123${separator}abc123${separator}Ada${separator}2026-09-01T10:00:00+00:00${separator}Add feature`,
    `def456${separator}def456${separator}Grace${separator}2026-08-30T09:00:00+00:00${separator}Fix bug`,
  ].join('\n');

  assert.deepEqual(parseTimeline(stdout), [
    { hash: 'abc123', shortHash: 'abc123', author: 'Ada', date: '2026-09-01T10:00:00+00:00', subject: 'Add feature' },
    { hash: 'def456', shortHash: 'def456', author: 'Grace', date: '2026-08-30T09:00:00+00:00', subject: 'Fix bug' },
  ]);
});

test('getTimeline returns commits newest first', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  fs.appendFileSync(path.join(root, 'a.ts'), '// second\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'second');

  const result = await getTimeline(root);
  assert.equal(result.available, true);
  if (result.available) {
    assert.equal(result.commits.length, 2);
    assert.equal(result.commits[0]?.subject, 'second');
    assert.equal(result.commits[1]?.subject, 'first');
  }
});

test('getTimeline reports unavailable history without Git', async () => {
  const root = tempDir();
  const result = await getTimeline(root);

  assert.equal(result.available, false);
  if (!result.available) {
    assert.equal(result.reason, 'no-git');
  }
});

test('computeImpact compares the working tree against a base revision', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), "import { b } from './b.ts';\nexport const a = b;\n");
  fs.writeFileSync(path.join(root, 'b.ts'), 'export const b = 1;\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  const base = git(root, 'rev-parse', 'HEAD').trim();

  fs.appendFileSync(path.join(root, 'b.ts'), '// changed in second commit\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'second');

  const report = await scanRepository(root);
  const impact = await computeImpact(root, report.graph, base);

  assert.deepEqual(impact.changed.map((change) => change.path), ['b.ts']);
  assert.ok(impact.affected.some((entry) => entry.id === 'a.ts' && entry.distance === 1));
});
