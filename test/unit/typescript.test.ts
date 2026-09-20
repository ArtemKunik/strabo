import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildMemberMap } from '../../src/analysis/member-map.ts';
import { symbolExtractorFor } from '../../src/scan/languages/registry.ts';
import { extractTypeScriptSymbols } from '../../src/scan/languages/typescript.ts';
import type { CodeSymbol } from '../../src/scan/languages/symbols.ts';

function tuple(symbol: CodeSymbol): (string | number | boolean)[] {
  return [
    symbol.kind,
    symbol.visibility,
    symbol.owner,
    symbol.name,
    symbol.type ?? '',
    symbol.mutable ?? false,
    symbol.parameters ?? 0,
  ];
}

test('extractTypeScriptSymbols records types, fields, methods, and parameter properties', async () => {
  const source = [
    'class Counter {',
    '  private value: number = 0;',
    '  protected label?: string;',
    '  static count = 0;',
    '  #secret = 1;',
    '',
    '  constructor(private readonly dep: Dep) {}',
    '',
    '  get current(): number { return this.value; }',
    '  set current(next: number) { this.value = next; }',
    '',
    '  increment(delta: number): void { this.value += delta; }',
    '}',
    '',
    'function helper(x: number): number { return x; }',
    'const arrow = (a: number) => a + 1;',
    'const MAX = 10;',
  ].join('\n');

  const { symbols } = await extractTypeScriptSymbols('members.ts', source);

  assert.deepEqual(symbols.map(tuple), [
    ['type', 'public', '', 'Counter', '', false, 0],
    ['field', 'private', 'Counter', 'value', 'number', true, 0],
    ['field', 'protected', 'Counter', 'label', 'string', true, 0],
    ['field', 'public', 'Counter', 'count', '', true, 0],
    ['field', 'private', 'Counter', '#secret', '', true, 0],
    ['method', 'public', 'Counter', 'constructor', '', false, 1],
    ['field', 'private', 'Counter', 'dep', 'Dep', false, 0],
    ['method', 'public', 'Counter', 'current', 'number', false, 0],
    ['method', 'public', 'Counter', 'increment', 'void', false, 1],
    ['method', 'public', 'members', 'helper', 'number', false, 1],
    ['method', 'public', 'members', 'arrow', '', false, 1],
    ['field', 'public', 'members', 'MAX', '', false, 0],
  ]);
});

test('extractTypeScriptSymbols records field reads and writes inside method bodies', async () => {
  const source = [
    'class Counter {',
    '  private value: number = 0;',
    "  private label: string = 'x';",
    '',
    '  add(delta: number): void {',
    '    this.value = this.value + delta;',
    '    label;',
    '  }',
    '',
    '  shadow(value: number): void {',
    '    value;',
    '  }',
    '}',
  ].join('\n');

  const { accesses } = await extractTypeScriptSymbols('Counter.ts', source);
  const add = (accesses ?? []).filter((entry) => entry.method === 'add');

  assert.ok(add.some((entry) => entry.field === 'value' && entry.mode === 'write'));
  assert.ok(add.some((entry) => entry.field === 'value' && entry.mode === 'read'));
  assert.ok(add.some((entry) => entry.field === 'label' && entry.mode === 'read'));
  assert.equal(
    (accesses ?? []).some((entry) => entry.method === 'shadow'),
    false,
    'a parameter shadows the field, so no access is recorded',
  );
});

test('extractTypeScriptSymbols groups module declarations under the file base name', async () => {
  const source = [
    'export function scanRepository(root: string): Promise<void> { return Promise.resolve(); }',
    'const MAX = 10;',
  ].join('\n');

  const { symbols, accesses } = await extractTypeScriptSymbols('src/scan/scan.ts', source);

  assert.deepEqual(symbols.map(tuple), [
    ['method', 'public', 'scan', 'scanRepository', 'Promise<void>', false, 1],
    ['field', 'public', 'scan', 'MAX', '', false, 0],
  ]);

  const map = buildMemberMap('src/scan/scan.ts', symbols, accesses ?? []);
  assert.equal(map.types.length, 1);
  assert.equal(map.types[0]?.name, 'scan');
  assert.deepEqual(
    map.types[0]?.methods.map((method) => method.name),
    ['scanRepository'],
  );
});

test('extractTypeScriptSymbols parses interfaces and TSX with the TSX grammar', async () => {
  const source = [
    'interface Props { title: string }',
    'export function App(props: Props) {',
    '  return <div>{props.title}</div>;',
    '}',
  ].join('\n');

  const { symbols, diagnostics } = await extractTypeScriptSymbols('App.tsx', source);

  assert.deepEqual(diagnostics, []);
  assert.ok(symbols.some((symbol) => symbol.name === 'Props' && symbol.kind === 'type'));
  assert.ok(
    symbols.some((symbol) => symbol.name === 'title' && symbol.owner === 'Props' && symbol.kind === 'field'),
  );
  assert.ok(symbols.some((symbol) => symbol.name === 'App' && symbol.kind === 'method'));
});

test('symbolExtractorFor covers TypeScript module extensions', () => {
  assert.equal(symbolExtractorFor('a.ts')?.language, 'typescript');
  assert.equal(symbolExtractorFor('a.tsx')?.language, 'typescript');
  assert.equal(symbolExtractorFor('a.mts')?.language, 'typescript');
  assert.equal(symbolExtractorFor('a.cts')?.language, 'typescript');
  assert.equal(symbolExtractorFor('a.cpp'), null);
});
