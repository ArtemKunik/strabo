import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  buildAdjacency,
  computeGraphMetrics,
  computeImpact,
  relationshipOf,
  scanRepository,
} from '../../src/index.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-reexport-'));
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

test('a barrel re-export keeps the dependency path from a change to a file two hops away', async () => {
  const root = tempDir();
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  // A imports the barrel; the barrel re-exports B; B is what changes.
  fs.writeFileSync(path.join(src, 'a.ts'), "import { b } from './index.ts';\nexport const a = b;\n");
  fs.writeFileSync(path.join(src, 'index.ts'), "export { b } from './b.ts';\n");
  fs.writeFileSync(path.join(src, 'b.ts'), 'export const b = 1;\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');

  const report = await scanRepository(root);
  const reExport = report.graph.edges.find(
    (edge) => edge.source === 'src/index.ts' && edge.target === 'src/b.ts',
  );
  assert.equal(reExport?.kind, 're-export');
  assert.equal(reExport?.role, 'declare', 'a barrel re-export is drawn as a declaration');
  assert.equal(relationshipOf(reExport!), 're-export', 'the relationship is named explicitly');

  fs.appendFileSync(path.join(src, 'b.ts'), '// changed\n');
  const impact = await computeImpact(root, report.graph);

  assert.deepEqual(impact.changed.map((change) => change.path), ['src/b.ts']);
  assert.deepEqual(
    impact.affected.map((entry) => [entry.id, entry.distance]),
    [
      ['src/b.ts', 0],
      ['src/index.ts', 1],
      ['src/a.ts', 2],
    ],
  );
});

test('relationship kinds are explicit, with a fallback for an older recorded graph', () => {
  const evidence = { line: 1, specifier: 'x', resolution: 'exact' as const };
  assert.equal(relationshipOf({ source: 'a', target: 'b', kind: 'import', evidence }), 'import');
  assert.equal(
    relationshipOf({ source: 'a', target: 'b', kind: 're-export', role: 'declare', evidence }),
    're-export',
  );
  assert.equal(
    relationshipOf({ source: 'a', target: 'b', kind: 'namespace', role: 'declare', evidence }),
    'module-declaration',
  );
  assert.equal(
    relationshipOf({ source: 'a', target: 'b', kind: 'import', role: 'declare', evidence }),
    'executable-module',
  );
});

test('fan-out still excludes a barrel re-export while traversal can opt in', async () => {
  const root = tempDir();
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'a.ts'), "import { b } from './index.ts';\nexport const a = b;\n");
  fs.writeFileSync(path.join(src, 'index.ts'), "export { b } from './b.ts';\n");
  fs.writeFileSync(path.join(src, 'b.ts'), 'export const b = 1;\n');

  const report = await scanRepository(root);

  const counted = computeGraphMetrics(report.graph, buildAdjacency(report.graph));
  assert.equal(counted.fanOut.get('src/index.ts'), 0, 'direct fan-out leaves a declaration out');

  const followed = buildAdjacency(report.graph, { includeReExports: true });
  assert.ok(
    (followed.forward.get('src/index.ts') ?? []).includes('src/b.ts'),
    'impact traversal follows the re-export',
  );
  const every = buildAdjacency(report.graph, { includeDeclare: true });
  assert.ok((every.forward.get('src/index.ts') ?? []).includes('src/b.ts'));
});
