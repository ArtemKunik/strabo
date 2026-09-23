import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { computeClones, normaliseTokens } from '../../src/analysis/clones.ts';
import { scanRepository } from '../../src/index.ts';
import type { Graph } from '../../src/index.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(directory);
  return directory;
}

test('normaliseTokens collapses renamed identifiers and literals', () => {
  const first = normaliseTokens('function add(x, y) { return x + 1; }', 'typescript');
  const second = normaliseTokens('function sum(first, second) { return first + 99; }', 'typescript');

  assert.deepEqual(first, second);
  assert.deepEqual(first, [
    'function', '$id', '(', '$id', ',', '$id', ')', '{',
    'return', '$id', '+', '$num', ';', '}',
  ]);
});

test('normaliseTokens keeps structurally different snippets apart', () => {
  const addition = normaliseTokens('function add(x, y) { return x + y; }', 'typescript');
  const multiplication = normaliseTokens('function add(x, y) { return x * y; }', 'typescript');

  assert.notDeepEqual(addition, multiplication);
  assert.notEqual(addition.join(' '), multiplication.join(' '));
});

test('computeClones clusters renamed copies of the same function', async () => {
  const root = tempDir('strabo-clones-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(
    path.join(root, 'src', 'a.ts'),
    [
      'export function computeTotal(values: number[]): number {',
      '  let total = 0;',
      '  for (const value of values) {',
      '    if (value > 0) {',
      '      total += value * 2;',
      '    }',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'src', 'b.ts'),
    [
      'export function sumAll(items: number[]): number {',
      '  let running = 0;',
      '  for (const item of items) {',
      '    if (item > 0) {',
      '      running += item * 2;',
      '    }',
      '  }',
      '  return running;',
      '}',
      '',
    ].join('\n'),
  );

  const scan = await scanRepository(root);
  const report = await computeClones(root, scan.graph);

  assert.equal(report.available, true);
  assert.equal(report.clusters.length, 1);
  const cluster = report.clusters[0];
  assert.ok(cluster);
  assert.equal(cluster.members.length, 2);
  assert.deepEqual(
    cluster.members.map((member) => member.file),
    ['src/a.ts', 'src/b.ts'],
  );
  assert.ok(cluster.sharedTokens >= 30);
});

test('computeClones is unavailable when the graph has no extractable functions', async () => {
  const graph: Graph = {
    nodes: [{ id: 'README.md', kind: 'module', directory: '.' }],
    edges: [],
    diagnostics: [],
    excluded: [],
  };

  const report = await computeClones(process.cwd(), graph);

  assert.equal(report.available, false);
  assert.match(report.reason ?? '', /no functions were extracted/);
  assert.equal(report.clusters.length, 0);
  assert.equal(report.functionsHashed, 0);
});
