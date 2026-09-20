import assert from 'node:assert/strict';
import { test } from 'node:test';

import { symbolExtractorFor } from '../../src/index.ts';
import { extractTypeScriptSymbols } from '../../src/index.ts';

test('symbolExtractorFor covers JavaScript module extensions', () => {
  assert.equal(symbolExtractorFor('a.js')?.language, 'javascript');
  assert.equal(symbolExtractorFor('a.jsx')?.language, 'javascript');
  assert.equal(symbolExtractorFor('a.mjs')?.language, 'javascript');
  assert.equal(symbolExtractorFor('a.cjs')?.language, 'javascript');
  assert.equal(symbolExtractorFor('a.JS')?.language, 'javascript');
});

test('JavaScript is reported as its own language, not as TypeScript', () => {
  assert.equal(symbolExtractorFor('a.ts')?.language, 'typescript');
  assert.notEqual(symbolExtractorFor('a.js')?.language, symbolExtractorFor('a.ts')?.language);
});

test('extractTypeScriptSymbols records classes, fields, and methods from a .js file', async () => {
  const source = [
    'export class Counter {',
    '  #secret = 1;',
    '  static label = "counter";',
    '',
    '  constructor(dep) { this.dep = dep; }',
    '',
    '  increment(delta) { this.#secret += delta; }',
    '}',
    '',
    'export function helper(x) { return x; }',
    'const MAX = 10;',
  ].join('\n');

  const { symbols, diagnostics } = await extractTypeScriptSymbols('ui/counter.js', source);

  assert.deepEqual(diagnostics, []);
  assert.equal(symbols.find((symbol) => symbol.name === 'Counter')?.kind, 'type');
  assert.equal(symbols.find((symbol) => symbol.name === '#secret')?.owner, 'Counter');
  assert.equal(symbols.find((symbol) => symbol.name === 'increment')?.parameters, 1);
  // Top-level declarations are grouped under the module's base name.
  assert.equal(symbols.find((symbol) => symbol.name === 'helper')?.owner, 'counter');
  assert.equal(symbols.find((symbol) => symbol.name === 'MAX')?.owner, 'counter');
});

test('a .js file containing JSX parses without diagnostics', async () => {
  // The TypeScript grammar reads a leading `<` as a type assertion and fails here; the
  // TSX grammar reads it as JSX, which is the only correct reading for JavaScript.
  const source = [
    'export function Badge({ count }) {',
    '  return <span className="badge">{count}</span>;',
    '}',
  ].join('\n');

  const { symbols, diagnostics } = await extractTypeScriptSymbols('ui/Badge.js', source);

  assert.deepEqual(diagnostics, []);
  assert.equal(symbols.find((symbol) => symbol.name === 'Badge')?.kind, 'method');
});

test('extractTypeScriptSymbols records member access and calls in a .js file', async () => {
  const source = [
    'class Store {',
    '  value = 0;',
    '  read() { return this.value; }',
    '  write(next) { this.value = next; return this.read(); }',
    '}',
  ].join('\n');

  const { accesses, calls } = await extractTypeScriptSymbols('ui/store.js', source);

  assert.ok(accesses?.some((a) => a.field === 'value' && a.method === 'read' && a.mode === 'read'));
  assert.ok(accesses?.some((a) => a.field === 'value' && a.method === 'write' && a.mode === 'write'));
  assert.ok(calls?.some((call) => call.method === 'write' && call.callee === 'read' && call.kind === 'self'));
});

test('CommonJS and ESM script extensions extract the same way', async () => {
  const source = 'function only(a, b) { return a + b; }';

  for (const file of ['lib/tool.mjs', 'lib/tool.cjs', 'lib/tool.jsx']) {
    const { symbols, diagnostics } = await extractTypeScriptSymbols(file, source);
    assert.deepEqual(diagnostics, [], file);
    assert.equal(symbols.find((symbol) => symbol.name === 'only')?.owner, 'tool', file);
  }
});
