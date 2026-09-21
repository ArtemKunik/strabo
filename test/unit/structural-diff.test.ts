import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  clearStructuralDiffCache,
  computeStructuralDiff,
  diffGraphs,
  type StructuralContext,
} from '../../src/analysis/structural-diff.ts';
import { scanRepository } from '../../src/scan/scan.ts';
import type { Graph } from '../../src/types.ts';

after(() => {
  clearStructuralDiffCache();
});

function node(id: string): Graph['nodes'][number] {
  return { id, kind: 'module', directory: path.posix.dirname(id) };
}

function edge(
  source: string,
  target: string,
  overrides: Partial<Graph['edges'][number]> = {},
): Graph['edges'][number] {
  return {
    source,
    target,
    kind: 'import',
    evidence: { line: 1, specifier: target, resolution: 'exact' },
    ...overrides,
  };
}

function graph(nodes: string[], edges: Array<Graph['edges'][number]>): Graph {
  return { nodes: nodes.map(node), edges, diagnostics: [], excluded: [] };
}

function context(overrides: Partial<StructuralContext> = {}): StructuralContext {
  return { tierEdges: [], entryPoints: [], reached: [], ...overrides };
}

test('diffGraphs reports dependency edges added and removed', () => {
  const before = graph(['a.ts', 'b.ts', 'c.ts'], [edge('a.ts', 'b.ts')]);
  const after = graph(['a.ts', 'b.ts', 'c.ts'], [edge('b.ts', 'c.ts')]);

  const diff = diffGraphs(before, after, context(), context());

  assert.deepEqual(diff.edgesAdded, [{ source: 'b.ts', target: 'c.ts', kind: 'import' }]);
  assert.deepEqual(diff.edgesRemoved, [{ source: 'a.ts', target: 'b.ts', kind: 'import' }]);
});

test('diffGraphs leaves declare edges out of the dependency diff', () => {
  const before = graph(['a.ts', 'b.ts'], []);
  const after = graph(['a.ts', 'b.ts'], [edge('a.ts', 'b.ts', { role: 'declare' })]);

  const diff = diffGraphs(before, after, context(), context());

  assert.deepEqual(diff.edgesAdded, []);
});

test('diffGraphs reports a cycle introduced and a cycle resolved', () => {
  const before = graph(['a.ts', 'b.ts', 'c.ts', 'd.ts'], [edge('c.ts', 'd.ts'), edge('d.ts', 'c.ts')]);
  const after = graph(['a.ts', 'b.ts', 'c.ts', 'd.ts'], [edge('a.ts', 'b.ts'), edge('b.ts', 'a.ts')]);

  const diff = diffGraphs(before, after, context(), context());

  assert.deepEqual(diff.cyclesIntroduced, [{ id: 'a.ts', members: ['a.ts', 'b.ts'] }]);
  assert.deepEqual(diff.cyclesResolved, [{ id: 'c.ts', members: ['c.ts', 'd.ts'] }]);
});

test('diffGraphs reports a wrong-way tier edge added', () => {
  const before = graph(['src/data/x.ts', 'src/api/y.ts'], []);
  const after = graph(['src/data/x.ts', 'src/api/y.ts'], []);
  const tierEdge = { unit: '.', source: 'src/data/x.ts', target: 'src/api/y.ts', kind: 'upward' as const };

  const diff = diffGraphs(before, after, context(), context({ tierEdges: [tierEdge] }));

  assert.deepEqual(diff.tierEdgesAdded, [tierEdge]);
});

test('diffGraphs reports an entry point added', () => {
  const before = graph(['src/index.ts', 'src/cli.ts'], []);
  const after = graph(['src/index.ts', 'src/cli.ts'], []);

  const diff = diffGraphs(
    before,
    after,
    context({ entryPoints: ['src/index.ts'] }),
    context({ entryPoints: ['src/index.ts', 'src/cli.ts'] }),
  );

  assert.deepEqual(diff.entryPointsAdded, ['src/cli.ts']);
});

test('diffGraphs reports a newly unreached file but not one that was deleted', () => {
  const before = graph(['src/app.ts', 'src/lib.ts', 'src/gone.ts'], []);
  const after = graph(['src/app.ts', 'src/lib.ts'], []);

  const diff = diffGraphs(
    before,
    after,
    context({ reached: ['src/app.ts', 'src/lib.ts', 'src/gone.ts'] }),
    context({ reached: ['src/app.ts'] }),
  );

  assert.deepEqual(diff.newlyUnreached, ['src/lib.ts']);
  assert.equal(diff.counts.newlyUnreached, 1);
});

/* ------------------------------------------------------------------ Caller */

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
}

function tempDir(prefix = 'strabo-structural-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('computeStructuralDiff scans the base from a worktree and removes it', async () => {
  const root = tempDir();
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Tester');
  git(root, 'config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), "import './b.ts';\n");
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import './a.ts';\nexport const b = 1;\n");
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'add cycle');

  try {
    const headGraph = (await scanRepository(root)).graph;
    const result = await computeStructuralDiff(root, 'HEAD~1', { headGraph, repository: 'fixture' });

    assert.equal(result.available, true);
    if (!result.available) return;
    assert.equal(result.diff.cyclesIntroduced.length, 1);
    assert.deepEqual(result.diff.cyclesIntroduced[0]?.members, ['src/a.ts', 'src/b.ts']);
    assert.equal(result.diff.edgesAdded.some((entry) => entry.source === 'src/b.ts'), true);
  } finally {
    const worktrees = git(root, 'worktree', 'list', '--porcelain');
    assert.equal(/strabo-base-/.test(worktrees), false);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('computeStructuralDiff reports an unknown base as unavailable', async () => {
  const root = tempDir();
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Tester');
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');

  try {
    const result = await computeStructuralDiff(root, 'does-not-exist');
    assert.equal(result.available, false);
    assert.equal(result.available === false && result.reason, 'unknown-revision');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
