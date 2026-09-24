import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Create a Git-backed fixture for timeline/compare scenarios.
 *
 * It lives under `test/fixtures/timeline-repo`, which is gitignored by the outer
 * repository, so committing and then dirtying files here never touches Strabo's own tree.
 */
export function ensureTimelineRepo(root = path.resolve('test/fixtures/timeline-repo')) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), "import { b } from './b.ts';\nexport const a = b;\n");
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 1;\n');

  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  if (!fs.existsSync(path.join(root, '.git'))) {
    git('init', '-q');
    git('config', 'user.email', 'acceptance@example.com');
    git('config', 'user.name', 'Acceptance');
  }
  git('add', '.');
  try {
    git('commit', '-q', '-m', 'initial import');
  } catch {
    // Nothing to commit on a re-run; the history already exists.
  }

  // A branch with its own work for the Branches panel. Created before the working tree is
  // dirtied, and left unchecked-out so the scenario reviews a branch the map is not showing.
  let hasFeature = true;
  try {
    git('rev-parse', '--verify', '-q', 'refs/heads/feature/acceptance');
  } catch {
    hasFeature = false;
  }
  if (!hasFeature) {
    git('checkout', '-q', '-b', 'feature/acceptance');
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), "import { b } from './b.ts';\nexport const a = b + 1;\n");
    git('commit', '-q', '-am', 'feature work');
    git('checkout', '-q', '-');
  }

  // Leave an uncommitted change so comparing a revision with the working tree has impact.
  const file = path.join(root, 'src', 'b.ts');
  const content = fs.readFileSync(file, 'utf8');
  if (!content.includes('// acceptance change')) {
    fs.appendFileSync(file, '// acceptance change\n');
  }
}

/**
 * A Git-backed Kotlin fixture for the Change passport.
 *
 * The committed Counter has two clusters (cohesion 67); the uncommitted `tag` change reads
 * `value`, joining them (cohesion 100). It lives under `test/fixtures/change-repo`, which is
 * gitignored, so the nested repository never touches Strabo's own tree.
 */
export function ensureChangeRepo(root = path.resolve('test/fixtures/change-repo')) {
  const file = path.join(root, 'src', 'main', 'kotlin', 'com', 'acme', 'app', 'Counter.kt');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const baseline = `package com.acme.app

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
  const modified = baseline.replace(
    'fun tag() {\n        println(label)\n    }',
    'fun tag() {\n        println(label)\n        value = value + 1\n    }',
  );

  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  if (!fs.existsSync(path.join(root, '.git'))) {
    fs.writeFileSync(file, baseline);
    git('init', '-q');
    git('config', 'user.email', 'acceptance@example.com');
    git('config', 'user.name', 'Acceptance');
    git('add', '.');
    git('commit', '-q', '-m', 'baseline');
  }
  // Leave the cohesion-raising edit uncommitted so the working-tree review compares to HEAD.
  fs.writeFileSync(file, modified);
}

/**
 * Prepare the timeline fixture with a stable history and its one uncommitted change.
 *
 * The directory is gitignored, so it can be left in any state by an interrupted run: a
 * missing/extra `b.ts` edit or an EMPTY_INDEX from a crash. Commit whatever is present to make
 * the recorded history deterministic, rebuild the working tree to the baseline files, then
 * re-apply the single uncommitted change the review scenarios compare against HEAD. That keeps
 * the pending change set at exactly `src/b.ts` regardless of how the fixture was left.
 */
export function prepareTimelineRepo(root = path.resolve('test/fixtures/timeline-repo')) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), "import { b } from './b.ts';\nexport const a = b;\n");
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 1;\n');

  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  if (!fs.existsSync(path.join(root, '.git'))) {
    git('init', '-q');
    git('config', 'user.email', 'acceptance@example.com');
    git('config', 'user.name', 'Acceptance');
  }
  // A crash can leave an index that blocks every later Git call; start from a sound one.
  fs.rmSync(path.join(root, '.git', 'index.lock'), { force: true });
  git('add', '.');
  try {
    git('commit', '-q', '-m', 'initial import');
  } catch {
    // Nothing to commit on a re-run; the history already exists.
  }
  git('reset', '-q', '--hard', 'HEAD');

  // A branch with its own work for the Branches panel. Created after the baseline commit and
  // left unchecked-out so the scenario reviews a branch the map is not showing.
  let hasFeature = true;
  try {
    git('rev-parse', '--verify', '-q', 'refs/heads/feature/acceptance');
  } catch {
    hasFeature = false;
  }
  if (!hasFeature) {
    git('checkout', '-q', '-b', 'feature/acceptance');
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), "import { b } from './b.ts';\nexport const a = b + 1;\n");
    git('commit', '-q', '-am', 'feature work');
    git('checkout', '-q', '-');
  }

  // Leave exactly one uncommitted change so comparing a revision with the working tree has
  // impact, and the pending change set is the one file the scenarios name.
  fs.appendFileSync(path.join(root, 'src', 'b.ts'), '// acceptance change\n');
}
