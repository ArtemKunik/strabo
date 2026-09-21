import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scanJsTsCalls } from '../../src/index.ts';

function content(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files));
}

function pairs(edges: Array<{ source: string; target: string; kind: string }>): string[] {
  return edges.filter((edge) => edge.kind === 'call').map((edge) => `${edge.source}->${edge.target}`);
}

test('a named import plus a bare call becomes a call edge', async () => {
  const result = await scanJsTsCalls(
    ['src/a.ts', 'src/b.ts'],
    content({
      'src/a.ts': 'export function foo(): void {}\n',
      'src/b.ts': "import { foo } from './a';\nfoo();\n",
    }),
  );

  assert.deepEqual(pairs(result.edges), ['src/b.ts->src/a.ts']);
  assert.equal(result.edges[0]?.evidence.specifier, 'foo');
});

test('an aliased import resolves to the imported name', async () => {
  const result = await scanJsTsCalls(
    ['src/a.ts', 'src/b.ts'],
    content({
      'src/a.ts': 'export function foo(): void {}\n',
      'src/b.ts': "import { foo as bar } from './a';\nbar();\n",
    }),
  );

  assert.deepEqual(pairs(result.edges), ['src/b.ts->src/a.ts']);
});

test('a namespace import plus a member call resolves through the namespace', async () => {
  const result = await scanJsTsCalls(
    ['src/a.ts', 'src/b.ts'],
    content({
      'src/a.ts': 'export function foo(): void {}\nexport function baz(): void {}\n',
      'src/b.ts': "import * as a from './a';\na.foo();\n",
    }),
  );

  assert.deepEqual(pairs(result.edges), ['src/b.ts->src/a.ts']);
  assert.equal(result.edges[0]?.evidence.specifier, 'a.foo');
});

test('a default import plus a bare call becomes a call edge', async () => {
  const result = await scanJsTsCalls(
    ['src/a.ts', 'src/b.ts'],
    content({
      'src/a.ts': 'export default function foo(): void {}\n',
      'src/b.ts': "import foo from './a';\nfoo();\n",
    }),
  );

  assert.deepEqual(pairs(result.edges), ['src/b.ts->src/a.ts']);
});

test('a call to a value receiver is not claimed', async () => {
  const result = await scanJsTsCalls(
    ['src/a.ts', 'src/b.ts'],
    content({
      'src/a.ts': 'export function foo(): void {}\n',
      'src/b.ts': "import { thing } from './a';\nthing.foo();\n",
    }),
  );

  assert.deepEqual(pairs(result.edges), []);
});

test('a call to a function the target does not export is not claimed', async () => {
  const result = await scanJsTsCalls(
    ['src/a.ts', 'src/b.ts'],
    content({
      'src/a.ts': 'export function foo(): void {}\n',
      'src/b.ts': "import { missing } from './a';\nmissing();\n",
    }),
  );

  assert.deepEqual(pairs(result.edges), []);
});

test('a type-only import call is not claimed', async () => {
  const result = await scanJsTsCalls(
    ['src/a.ts', 'src/b.ts'],
    content({
      'src/a.ts': 'export function foo(): void {}\n',
      'src/b.ts': "import type { foo } from './a';\nfoo();\n",
    }),
  );

  assert.deepEqual(pairs(result.edges), []);
});

test('a call to an external package function is not an internal edge', async () => {
  const result = await scanJsTsCalls(
    ['src/b.ts'],
    content({
      'src/b.ts': "import { foo } from 'some-package';\nfoo();\n",
    }),
  );

  assert.deepEqual(pairs(result.edges), []);
});

test('a re-exported name is not a call target in the forwarder', async () => {
  const result = await scanJsTsCalls(
    ['src/a.ts', 'src/barrel.ts', 'src/b.ts'],
    content({
      'src/a.ts': 'export function foo(): void {}\n',
      'src/barrel.ts': "export { foo } from './a';\n",
      'src/b.ts': "import { foo } from './barrel';\nfoo();\n",
    }),
  );

  assert.deepEqual(pairs(result.edges), []);
});

test('a call edge always parallels an import edge for the same pair', async () => {
  const { scanRepository } = await import('../../src/index.ts');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-calls-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function foo(): void {}\n');
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { foo } from './a';\nfoo();\n");

    const report = await scanRepository(root);
    const call = report.graph.edges.find((edge) => edge.kind === 'call');
    const importEdge = report.graph.edges.find((edge) => edge.kind === 'import');

    assert.ok(call, 'records a call edge');
    assert.ok(importEdge, 'records the matching import edge');
    assert.equal(call?.source, importEdge?.source);
    assert.equal(call?.target, importEdge?.target);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
