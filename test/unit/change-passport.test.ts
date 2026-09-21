import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { computeChangePassport } from '../../src/index.ts';
import { reviewWorkingTree } from '../../src/index.ts';
import { scanRepository } from '../../src/index.ts';

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

const passport = await computeChangePassport(root, review.files, 'HEAD', report.graph);
   assert.equal(passport.baseline, 'HEAD');
  assert.equal(passport.capped, false);
  const change = passport.files.find((entry) => entry.path.endsWith('Counter.kt'));
  assert.ok(change, 'the changed Kotlin file should be in the passport');
  assert.equal(change.before, 67);
  assert.equal(change.after, 100);
  assert.match(change.note, /compared with HEAD/);
});

test('computeChangePassport includes function-level changes for Kotlin files', async () => {
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

const passport = await computeChangePassport(root, review.files, 'HEAD', report.graph);
   const change = passport.files.find((entry) => entry.path.endsWith('Counter.kt'));
  assert.ok(change, 'the changed Kotlin file should be in the passport');
  assert.ok(change.functions.length > 0, 'the change should include function-level changes');
  for (const fn of change.functions) {
    assert.ok(fn.name.length > 0, 'each function change should have a name');
    assert.ok(fn.signalsBefore.length >= 0, 'signalsBefore should be an array');
    assert.ok(fn.signalsAfter.length >= 0, 'signalsAfter should be an array');
  }
  const tagFn = change.functions.find((f) => f.name === 'tag');
  assert.ok(tagFn, 'the tag function should be in the function changes');
});

test('computeChangePassport names an unavailable side instead of inventing a score', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.go'), 'int a = 1;\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'baseline');
  fs.writeFileSync(path.join(root, 'a.go'), 'int a = 2;\n');

  const report = await scanRepository(root);
  const review = await reviewWorkingTree(root, report.graph);
  assert.equal(review.available, true);
  if (!review.available) {
    return;
  }

const passport = await computeChangePassport(root, review.files, 'HEAD', report.graph);
   const change = passport.files.find((entry) => entry.path === 'a.go');
  assert.ok(change);
  assert.equal(change.before, null);
  assert.equal(change.after, null);
  assert.match(change.note, /no symbol extractor/);
});

test('computeChangePassport does not score SQL columns, which have no member access', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'schema.sql'), 'CREATE TABLE t (id INT);\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'baseline');
  fs.writeFileSync(path.join(root, 'schema.sql'), 'CREATE TABLE t (id INT, name TEXT, note TEXT);\n');

  const report = await scanRepository(root);
  const review = await reviewWorkingTree(root, report.graph);
  assert.equal(review.available, true);
  if (!review.available) {
    return;
  }

const passport = await computeChangePassport(root, review.files, 'HEAD', report.graph);
   const change = passport.files.find((entry) => entry.path === 'schema.sql');
   assert.ok(change);
   assert.equal(change.before, null);
   assert.equal(change.after, null);
   assert.match(change.note, /records no member access/);
 });

test('computeChangePassport includes public-surface diff for Python files', async () => {
   const root = tempDir();
   const file = path.join(root, 'src/main.py');
   fs.mkdirSync(path.dirname(file), { recursive: true });
   fs.writeFileSync(file, 'def public_func():\n    pass\n\ndef _private_func():\n    pass\n');
   initRepo(root);
   git(root, 'add', '.');
   git(root, 'commit', '-q', '-m', 'baseline');

   fs.writeFileSync(file, 'def public_func():\n    return 1\n\ndef _private_func():\n    pass\n\ndef new_public():\n    pass\n');

   const report = await scanRepository(root);
   const review = await reviewWorkingTree(root, report.graph);
   assert.equal(review.available, true);
   if (!review.available) {
     return;
   }

   const passport = await computeChangePassport(root, review.files, 'HEAD', report.graph);
   const change = passport.files.find((entry) => entry.path === 'src/main.py');
   assert.ok(change);
   assert.ok(change.publicSurface.length > 0, 'should have public-surface changes');
   const surface = change.publicSurface[0];
   assert.equal(surface.language, 'python');
   const symbolNames = surface.symbols.map((s) => s.name);
   assert.ok(symbolNames.includes('public_func'), 'should detect changed public_func');
   assert.ok(symbolNames.includes('new_public'), 'should detect added new_public');
   const publicFunc = surface.symbols.find((s) => s.name === 'public_func');
   assert.ok(publicFunc, 'public_func should be in symbols');
   const newPublic = surface.symbols.find((s) => s.name === 'new_public');
   assert.ok(newPublic, 'new_public should be in symbols');
   assert.equal(newPublic.change, 'added');
 });

test('computeChangePassport lists the tests to run, untested dependents, and the risk', async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/lib.ts'), 'export function exported(): number {\n  return 1;\n}\n');
  fs.writeFileSync(path.join(root, 'src/lib.test.ts'), "import { exported } from './lib';\nexport const t = exported();\n");
  fs.writeFileSync(path.join(root, 'src/other.ts'), "import { exported } from './lib';\nexport const o = exported();\n");
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'baseline');
  fs.writeFileSync(
    path.join(root, 'src/lib.ts'),
    'export function exported(): number {\n  if (Math.random() > 0.5) {\n    return 2;\n  }\n  return 1;\n}\n',
  );

  const report = await scanRepository(root);
  const review = await reviewWorkingTree(root, report.graph);
  assert.equal(review.available, true);
  if (!review.available) {
    return;
  }

  const passport = await computeChangePassport(root, review.files, 'HEAD', report.graph);
  const change = passport.files.find((entry) => entry.path === 'src/lib.ts');
  assert.ok(change);
  assert.ok(change.testsToRun.includes('src/lib.test.ts'), 'the importing test is listed');
  assert.ok(change.untestedDependents.includes('src/other.ts'), 'other.ts is not reached by a test');
  assert.ok(change.risk, 'a touched function carries a pending-change risk');
  assert.ok((change.risk?.inputs.linesTouched ?? 0) > 0);
  assert.equal(typeof change.risk?.score, 'number');
});

test('computeChangePassport includes tiered impact for importers', async () => {
   const root = tempDir();
   fs.mkdirSync(path.join(root, 'src'), { recursive: true });
   fs.writeFileSync(path.join(root, 'src/lib.py'), 'def exported_func():\n    pass\n\ndef internal_func():\n    pass\n');
   fs.writeFileSync(path.join(root, 'src/app.py'), 'from src.lib import exported_func\n\ndef run():\n    return exported_func()\n');
   initRepo(root);
   git(root, 'add', '.');
   git(root, 'commit', '-q', '-m', 'baseline');

   fs.writeFileSync(path.join(root, 'src/lib.py'), 'def exported_func():\n    return 42\n\ndef internal_func():\n    pass\n');

   const report = await scanRepository(root);
   const review = await reviewWorkingTree(root, report.graph);
   assert.equal(review.available, true);
   if (!review.available) {
     return;
   }

   const passport = await computeChangePassport(root, review.files, 'HEAD', report.graph);
   const change = passport.files.find((entry) => entry.path === 'src/lib.py');
   assert.ok(change);
   assert.ok(change.impact, 'should have tiered impact');
   assert.ok(change.impact!.definite.includes('src/app.py') || change.impact!.possible.includes('src/app.py'), 'app.py should be in impact');
   assert.ok(change.impact!.reachable.includes('src/app.py'), 'app.py should be reachable');
 });
