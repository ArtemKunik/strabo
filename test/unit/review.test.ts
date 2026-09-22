import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { computeCoverage } from '../../src/index.ts';
import { analyzeModuleDepth } from '../../src/index.ts';
import { computeImpact, getChangedFiles } from '../../src/index.ts';
import { computeOwnership, getFileAuthorHistory } from '../../src/index.ts';
import { reviewCommit } from '../../src/index.ts';
import { scanRepository } from '../../src/index.ts';
import type { Graph } from '../../src/index.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-review-'));
  created.push(directory);
  return directory;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
}

function initRepo(root: string, author = 'One'): void {
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', `${author.toLowerCase()}@example.com`);
  git(root, 'config', 'user.name', author);
}

test('computeCoverage reports used-but-untested modules, not orphans', () => {
  const graph: Graph = {
    nodes: ['test.ts', 'a.ts', 'b.ts', 'c.ts', 'd.ts', 'orphan.ts'].map((id) => ({
      id,
      kind: id === 'test.ts' ? ('test' as const) : ('module' as const),
      directory: '.',
    })),
    edges: [
      { source: 'test.ts', target: 'a.ts', kind: 'import', evidence: { line: 1, specifier: 'a', resolution: 'exact' } },
      { source: 'a.ts', target: 'b.ts', kind: 'import', evidence: { line: 1, specifier: 'b', resolution: 'exact' } },
      // c depends on d, and neither is reachable from a test.
      { source: 'c.ts', target: 'd.ts', kind: 'import', evidence: { line: 1, specifier: 'd', resolution: 'exact' } },
    ],
    diagnostics: [],
    excluded: [],
  };

  const result = computeCoverage(graph);

  assert.deepEqual(result.testFiles, ['test.ts']);
  assert.deepEqual(result.reached, ['a.ts', 'b.ts']);
  // d is used by c but unreached; orphan is unreached with nothing depending on it.
  assert.deepEqual(result.unreachedWithDependents, ['d.ts']);
});

test('computeImpact walks reverse edges and reports distance from the change', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), "import { b } from './b.ts';\nexport const a = b;\n");
  fs.writeFileSync(path.join(root, 'b.ts'), "import { c } from './c.ts';\nexport const b = c;\n");
  fs.writeFileSync(path.join(root, 'c.ts'), 'export const c = 1;\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');

  fs.appendFileSync(path.join(root, 'c.ts'), '// changed\n');
  const report = await scanRepository(root);
  const impact = await computeImpact(root, report.graph);

  assert.deepEqual(impact.changed.map((change) => change.path), ['c.ts']);
  assert.deepEqual(
    impact.affected.map((entry) => [entry.id, entry.distance]),
    [
      ['c.ts', 0],
      ['b.ts', 1],
      ['a.ts', 2],
    ],
  );
});

test('a commit that only rebuilds a generated bundle reviews empty and names the exclusion', async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'public/app.bundle.js'), 'window.app = 1;\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');

  fs.writeFileSync(path.join(root, 'public/app.bundle.js'), 'window.app = 2;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'rebuild');

  const report = await scanRepository(root);
  const review = await reviewCommit(root, report.graph, 'HEAD');

  assert.ok(review.available);
  assert.deepEqual(review.files, []);
  assert.equal(review.totals.files, 0);
  const named = (review.excluded ?? []).find((entry) => entry.path === 'public/app.bundle.js');
  assert.equal(named?.reason, 'generated');
  assert.equal(named?.detail, '.bundle.js');
});

test('a lockfile change is out of the review and names the lockfile exclusion', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'src.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');

  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'lock');

  const report = await scanRepository(root);
  const review = await reviewCommit(root, report.graph, 'HEAD');

  assert.ok(review.available);
  assert.deepEqual(review.files, []);
  const named = (review.excluded ?? []).find((entry) => entry.path === 'package-lock.json');
  assert.equal(named?.reason, 'lockfile');
  assert.equal(named?.detail, 'package-lock.json');
});

/**
 * `git diff` accepts `--output=<path>` as a self-contained flag, so an unvalidated
 * `baseRef` reaching the raw argv can make the process write a file anywhere it has
 * access to — proved against the real git binary before this test existed:
 * `git diff --name-status --output=pwned.txt` really does create `pwned.txt`, even
 * outside the repository the scan ceiling would otherwise bound. Reported as an empty
 * change list, matching how any other bad `baseRef` already degrades — not a distinct
 * "rejected" shape a caller could probe for.
 */
test('getChangedFiles rejects a baseRef shaped like a git flag rather than passing it to git', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');

  const target = path.join(root, 'pwned.txt');
  const changed = await getChangedFiles(root, `--output=${target}`);

  assert.deepEqual(changed, []);
  assert.equal(fs.existsSync(target), false, 'the flag-shaped baseRef must not reach git as an argument');
});

test('analyzeModuleDepth flags wide and pass-through modules', () => {
  const root = tempDir();
  fs.writeFileSync(
    path.join(root, 'wide.ts'),
    ['export function a(x, y, z) { return x; }', 'export function b(p, q, r) { return p; }', 'export function c() { return 1; }', 'export const d = 1;'].join('\n'),
  );
  fs.writeFileSync(path.join(root, 'thin.ts'), 'export const value = 1;\n');

  const signals = analyzeModuleDepth(root, ['wide.ts', 'thin.ts']);
  const wide = signals.find((signal) => signal.file === 'wide.ts');
  const thin = signals.find((signal) => signal.file === 'thin.ts');

  assert.ok(wide);
  assert.ok(thin);
  assert.ok(wide.interfaceWidth > 0);
  assert.equal(thin.signal, 'pass-through');
});

test('computeOwnership combines authorship with dependency reach', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), "import { b } from './b.ts';\nexport const a = b;\n");
  fs.writeFileSync(path.join(root, 'b.ts'), 'export const b = 1;\n');
  initRepo(root, 'One');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');

  // A second author edits b.ts.
  git(root, 'config', 'user.email', 'two@example.com');
  git(root, 'config', 'user.name', 'Two');
  fs.appendFileSync(path.join(root, 'b.ts'), '// two\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'edit');

  const report = await scanRepository(root);
  const history = await getFileAuthorHistory(root, report.graph.nodes.map((node) => node.id));
  const ownership = computeOwnership(history, report.graph);
  const b = ownership.find((entry) => entry.file === 'b.ts');

  assert.ok(b);
  assert.equal(b.distinctAuthors, 2);
  assert.equal(b.transitiveDependents, 1);
});
