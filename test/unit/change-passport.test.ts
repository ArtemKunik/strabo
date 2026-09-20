import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { computeChangePassport } from '../../src/analysis/change-passport.ts';
import { reviewWorkingTree } from '../../src/analysis/review.ts';
import { scanRepository } from '../../src/scan/scan.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-passport-'));
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

const BASELINE = `package com.acme.app

class Counter {
    private var value: Int = 0
    private var label: String = "counter"

    fun bump() {
        value = value + 1
    }

    fun tag() {
        println(label)
    }
}
`;

/** `tag` starts touching `value`, joining the two clusters and raising cohesion. */
const MODIFIED = BASELINE.replace(
  'fun tag() {\n        println(label)\n    }',
  'fun tag() {\n        println(label)\n        value = value + 1\n    }',
);

test('computeChangePassport reports cohesion before and after a working-tree change', async () => {
  const root = tempDir();
  const file = path.join(root, 'src/main/kotlin/com/acme/app/Counter.kt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, BASELINE);
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'baseline');

  fs.writeFileSync(file, MODIFIED);

  const report = await scanRepository(root);
  const review = await reviewWorkingTree(root, report.graph);
  assert.equal(review.available, true);
  if (!review.available) {
    return;
  }

  const passport = await computeChangePassport(root, review.files, 'HEAD');
  assert.equal(passport.baseline, 'HEAD');
  assert.equal(passport.capped, false);
  const change = passport.files.find((entry) => entry.path.endsWith('Counter.kt'));
  assert.ok(change, 'the changed Kotlin file should be in the passport');
  assert.equal(change.before, 67);
  assert.equal(change.after, 100);
  assert.match(change.note, /compared with HEAD/);
});

test('computeChangePassport names an unavailable side instead of inventing a score', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'baseline');
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 2;\n');

  const report = await scanRepository(root);
  const review = await reviewWorkingTree(root, report.graph);
  assert.equal(review.available, true);
  if (!review.available) {
    return;
  }

  const passport = await computeChangePassport(root, review.files, 'HEAD');
  const change = passport.files.find((entry) => entry.path === 'a.ts');
  assert.ok(change);
  assert.equal(change.before, null);
  assert.equal(change.after, null);
  assert.match(change.note, /no symbol extractor/);
});
