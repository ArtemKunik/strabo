import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Create a Git-backed fixture for timeline/compare scenarios.
 *
 * It lives under `test/fixtures/timeline-repo`, which is gitignored by the outer
 * repository, so committing and then dirtying files here never touches Strabo's own tree.
 */
export function ensureTimelineRepo() {
  const root = path.resolve('test/fixtures/timeline-repo');
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
export function ensureChangeRepo() {
  const root = path.resolve('test/fixtures/change-repo');
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
