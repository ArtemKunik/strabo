import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  CHANGE_RISK_THRESHOLDS,
  CHANGE_RISK_WEIGHTS,
  computeChangePassport,
  computeMeasuredCoverage,
  computeStructuralDiff,
  reviewCommit,
  reviewWorkingTree,
  rollUpImpactPassports,
  scanRepository,
} from '../../src/index.ts';

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

test('computeChangePassport reports a test-imported 0% file as measured 0% (U2)', async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/lib.ts'), 'export function exported(): number {\n  return 1;\n}\n');
  fs.writeFileSync(path.join(root, 'src/lib.test.ts'), "import { exported } from './lib';\nexport const t = exported();\n");
  fs.mkdirSync(path.join(root, 'coverage'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'coverage/lcov.info'),
    'SF:src/lib.ts\nDA:1,0\nDA:2,0\nLF:2\nLH:0\nend_of_record\n',
  );
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'baseline');
  fs.writeFileSync(
    path.join(root, 'src/lib.ts'),
    'export function exported(): number {\n  if (Math.random() > 0.5) {\n    return 2;\n  }\n  return 1;\n}\n',
  );

  const report = await scanRepository(root);
  const measured = await computeMeasuredCoverage(root, report.graph, {
    modifiedAt: () => '2024-06-01T00:00:00.000Z',
    lastCommitAt: async () => '2024-01-01T00:00:00.000Z',
  });
  const review = await reviewWorkingTree(root, report.graph);
  assert.equal(review.available, true);
  if (!review.available) {
    return;
  }

  const passport = await computeChangePassport(root, review.files, 'HEAD', report.graph, undefined, measured);
  const change = passport.files.find((entry) => entry.path === 'src/lib.ts');
  assert.ok(change, 'the changed file is in the passport');
  assert.equal(change.coverage?.basis, 'measured');
  assert.equal(change.coverage?.value, 0, 'measured 0%, not the reachable fallback');
  assert.equal(change.untestedBasis, 'measured');
  assert.equal(change.impactPassport.coverage?.value, 0);

  // With no report the figure is the labelled reach fallback, and the file is reached.
  const fallback = await computeChangePassport(root, review.files, 'HEAD', report.graph);
  const fallbackChange = fallback.files.find((entry) => entry.path === 'src/lib.ts');
  assert.equal(fallbackChange?.coverage?.basis, 'reachable');
  assert.equal(fallbackChange?.coverage?.value, null);
  assert.equal(fallbackChange?.coverage?.reached, true);
  assert.equal(fallbackChange?.untestedBasis, 'reachable');
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

test('tiered impact labels a recorded reference and never says definite', async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/lib.py'), 'def exported_func():\n    pass\n');
  fs.writeFileSync(path.join(root, 'src/app.py'), 'from src.lib import exported_func\n\ndef run():\n    return exported_func()\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'baseline');
  fs.writeFileSync(path.join(root, 'src/lib.py'), 'def exported_func():\n    return 42\n');

  const report = await scanRepository(root);
  const review = await reviewWorkingTree(root, report.graph);
  assert.equal(review.available, true);
  if (!review.available) return;

  const passport = await computeChangePassport(root, review.files, 'HEAD', report.graph);
  const change = passport.files.find((entry) => entry.path === 'src/lib.py');
  assert.ok(change?.impact, 'the changed file has tiered impact');
  const labels = change!.impact!.labels;
  assert.equal(labels.recordedReference, 'recorded reference to a changed symbol');
  assert.equal(labels.otherDirectImporter, 'other direct importer');
  assert.doesNotMatch(JSON.stringify(labels), /definite/i, 'no user-facing label says "definite"');
});

test('change risk sums contributing signals so a zero signal does not erase the score', async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/solo.ts'), 'export function solo(x: number): number {\n  return x;\n}\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'baseline');
  fs.writeFileSync(
    path.join(root, 'src/solo.ts'),
    'export function solo(x: number): number {\n  if (x > 0) {\n    return x;\n  }\n  return 0;\n}\n',
  );

  const report = await scanRepository(root);
  const review = await reviewWorkingTree(root, report.graph);
  assert.equal(review.available, true);
  if (!review.available) return;

  const passport = await computeChangePassport(root, review.files, 'HEAD', report.graph);
  const change = passport.files.find((entry) => entry.path === 'src/solo.ts');
  assert.ok(change?.risk, 'a touched function carries a risk even with no recorded reference');
  assert.equal(change!.risk!.inputs.recordedReferences, 0, 'no importer names the changed symbol');
  assert.ok(change!.risk!.score > 0, 'the other signals still sum to a positive score');
  assert.equal(change!.risk!.signals.length, 4);
  const references = change!.risk!.signals.find((signal) => signal.kind === 'recorded-references');
  assert.ok(references, 'the zero signal is still shown');
  assert.equal(references!.value, 0);
  assert.equal(references!.threshold, CHANGE_RISK_THRESHOLDS.recordedReferences);
  assert.equal(references!.contribution, 0);
  for (const signal of change!.risk!.signals) {
    assert.ok(signal.label.length > 0, 'every signal names itself');
    assert.ok(signal.threshold > 0, 'every signal names its threshold');
  }
  // The score is exactly the weighted sum of the components it is shown with.
  const [lines, complexity, references2, untested] = change!.risk!.signals;
  const expected = Math.round(
    100 *
      (CHANGE_RISK_WEIGHTS.linesTouched * lines!.contribution +
        CHANGE_RISK_WEIGHTS.touchedComplexity * complexity!.contribution +
        CHANGE_RISK_WEIGHTS.recordedReferences * references2!.contribution +
        CHANGE_RISK_WEIGHTS.untestedShare * untested!.contribution),
  );
  assert.equal(change!.risk!.score, expected);
});

test('function changes carry added, removed, and changed with both sides metrics', async () => {
  const root = tempDir();
  const file = path.join(root, 'src/fns.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      'export function keep(): number {',
      '  return 1;',
      '}',
      '',
      'export function grow(x: number): number {',
      '  return x;',
      '}',
      '',
      'export function gone(): number {',
      '  return 3;',
      '}',
      '',
    ].join('\n'),
  );
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'baseline');
  fs.writeFileSync(
    file,
    [
      'export function keep(): number {',
      '  return 1;',
      '}',
      '',
      'export function grow(x: number): number {',
      '  if (x > 0) {',
      '    return x;',
      '  }',
      '  return 0;',
      '}',
      '',
      'export function fresh(): number {',
      '  return 4;',
      '}',
      '',
    ].join('\n'),
  );

  const report = await scanRepository(root);
  const review = await reviewWorkingTree(root, report.graph);
  assert.equal(review.available, true);
  if (!review.available) return;

  const passport = await computeChangePassport(root, review.files, 'HEAD', report.graph);
  const change = passport.files.find((entry) => entry.path === 'src/fns.ts');
  assert.ok(change);
  const byName = new Map(change.functions.map((fn) => [fn.name, fn]));
  assert.equal(byName.has('keep'), false, 'an untouched function is not reported');

  const grow = byName.get('grow');
  assert.ok(grow);
  assert.equal(grow!.change, 'changed');
  assert.equal(grow!.decisionPointsBefore, 1);
  assert.equal(grow!.decisionPointsAfter, 2);
  assert.ok((grow!.linesBefore ?? 0) > 0 && (grow!.linesAfter ?? 0) > 0);

  const gone = byName.get('gone');
  assert.ok(gone);
  assert.equal(gone!.change, 'removed');
  assert.equal(gone!.decisionPointsBefore, 1);
  assert.equal(gone!.decisionPointsAfter, null, 'a removed function has no reviewed side');
  assert.equal(gone!.linesAfter, null);

  const fresh = byName.get('fresh');
  assert.ok(fresh);
  assert.equal(fresh!.change, 'added');
  assert.equal(fresh!.decisionPointsBefore, null, 'an added function has no base side');
  assert.equal(fresh!.decisionPointsAfter, 1);
  assert.equal(fresh!.linesBefore, null);
});

test('a commit that removes an import shows the edge removed and drops the former importer', async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src/lib.ts'),
    ['export function libFn(x: number): number {', '  return x;', '}'].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'src/app.ts'),
    ["import { libFn } from './lib';", '', 'export function run(x: number): number {', '  return libFn(x);', '}'].join('\n'),
  );
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'baseline');

  fs.writeFileSync(
    path.join(root, 'src/app.ts'),
    ['export function run(x: number): number {', '  return x;', '}'].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'src/lib.ts'),
    ['export function libFn(x: number): number {', '  if (x > 0) {', '    return x;', '  }', '  return 0;', '}'].join('\n'),
  );
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'remove import');

  const report = await scanRepository(root);
  const review = await reviewCommit(root, report.graph, 'HEAD');
  assert.equal(review.available, true);
  if (!review.available) return;
  assert.ok(review.files.some((file) => file.path === 'src/app.ts'), 'the former importer is a changed file');

  const structural = await computeStructuralDiff(root, 'HEAD^', {
    headGraph: report.graph,
    repository: 'fixture',
  });
  assert.equal(structural.available, true);
  if (!structural.available) return;
  assert.ok(
    structural.diff.edgesRemoved.some((edge) => edge.source === 'src/app.ts' && edge.target === 'src/lib.ts'),
    'the removed import is a removed edge in the two-graph diff',
  );

  const passport = await computeChangePassport(root, review.files, 'HEAD^', report.graph, structural.diff);
  const lib = passport.files.find((entry) => entry.path === 'src/lib.ts');
  assert.ok(lib, 'the imported file is in the passport');
  assert.ok(
    lib!.edgesRemoved.some((edge) => edge.source === 'src/app.ts' && edge.target === 'src/lib.ts'),
    'the passport reports the edge removed from both graphs',
  );
  assert.deepEqual(lib!.edgesAdded, []);
  const importers = [...(lib!.impact?.definite ?? []), ...(lib!.impact?.possible ?? [])];
  assert.equal(importers.includes('src/app.ts'), false, 'the former importer is not listed as impacted');

  const affected = review.impact.affected.filter((entry) => entry.distance > 0).map((entry) => entry.id);
  assert.equal(affected.includes('src/app.ts'), false, 'the former importer is not listed as affected');
});

test('a recorded reference is counted once and the count has one meaning (T2)', async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/lib.ts'), 'export function libFn(x: number): number {\n  return x;\n}\n');
  fs.writeFileSync(
    path.join(root, 'src/app.ts'),
    "import { libFn } from './lib';\n\nexport function run(x: number): number {\n  return libFn(x);\n}\n",
  );
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'baseline');
  fs.writeFileSync(
    path.join(root, 'src/lib.ts'),
    'export function libFn(x: number): number {\n  if (x > 0) {\n    return x;\n  }\n  return 0;\n}\n',
  );

  const report = await scanRepository(root);
  const review = await reviewWorkingTree(root, report.graph);
  assert.equal(review.available, true);
  if (!review.available) return;

  const passport = await computeChangePassport(root, review.files, 'HEAD', report.graph);
  const change = passport.files.find((entry) => entry.path === 'src/lib.ts');
  assert.ok(change?.impact, 'the changed file has tiered impact');
  assert.ok(change!.impact!.definite.includes('src/app.ts'), 'app.ts names the changed symbol');
  assert.ok(change!.impact!.referenceCount >= 1, 'a recorded reference is counted');
  assert.deepEqual(
    change!.impactPassport.symbolReferences,
    { total: change!.impact!.referenceCount, files: change!.impact!.definite.length },
    'the card row and the tier count agree',
  );
  assert.equal(
    change!.risk!.inputs.recordedReferences,
    change!.impact!.referenceCount,
    'the risk signal uses the same reference count as the row',
  );

  const totals = rollUpImpactPassports(
    report.graph,
    passport.files.map((entry) => entry.impactPassport),
    'change-set',
    'HEAD',
    false,
  ).totals;
  assert.deepEqual(totals.symbolReferences, { total: change!.impact!.referenceCount, files: 1 });
});
