import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildFunctions } from '../../src/index.ts';
import { extractCSharpSymbols } from '../../src/index.ts';
import { extractJavaSymbols } from '../../src/index.ts';
import { extractKotlinSymbols } from '../../src/index.ts';
import { extractPythonSymbols } from '../../src/index.ts';
import { extractRustSymbols } from '../../src/index.ts';
import { extractTypeScriptSymbols } from '../../src/index.ts';
import {
  functionCallers,
  functionEntryBadge,
  functionSummary,
  orderFunctions,
} from '../../ui/strabo-functions.js';

// F1: free-function bodies record calls in Rust, from free functions and from methods.
test('Rust free functions record calls from free functions and from methods', async () => {
  const source = [
    'fn sample_html() -> String {',
    '    String::from("<p>hi</p>")',
    '}',
    '',
    '#[test]',
    'fn renders_clipboard() {',
    '    let html = sample_html();',
    '    assert!(html.contains("hi"));',
    '}',
    '',
    'struct Clipboard {',
    '    last: String,',
    '}',
    '',
    'impl Clipboard {',
    '    fn build() -> Clipboard {',
    '        Clipboard { last: sample_html() }',
    '    }',
    '    pub fn read(&self) -> String {',
    '        sample_html()',
    '    }',
    '}',
  ].join('\n');

  const { symbols, calls = [] } = await extractRustSymbols('tests_clipboard.rs', source);
  const report = buildFunctions('tests_clipboard.rs', symbols, calls);
  const helper = report.functions.find((fn) => fn.name === 'sample_html');

  assert.ok(helper, 'expected the free helper to be recorded');
  assert.equal(helper.owner, '');
  assert.deepEqual(helper.callers, ['Clipboard.build', 'Clipboard.read', 'renders_clipboard']);
  assert.deepEqual(helper.calls, []);

  const testFn = report.functions.find((fn) => fn.name === 'renders_clipboard');
  assert.deepEqual(testFn?.entry, { kind: 'test', evidence: '#[test]' });
  assert.deepEqual(
    testFn?.calls.map((call) => call.name),
    ['sample_html'],
  );
});

// F1: free-function bodies record calls in Kotlin.
test('Kotlin top-level functions record calls from siblings and methods', async () => {
  const source = [
    'package com.acme.app',
    '',
    'fun helper(): String {',
    '    return "hi"',
    '}',
    '',
    'fun main() {',
    '    println(helper())',
    '}',
    '',
    'class Store {',
    '    @Test',
    '    fun loadsItems() {',
    '        val h = helper()',
    '    }',
    '}',
  ].join('\n');

  const { symbols, calls = [] } = await extractKotlinSymbols('Store.kt', source);
  const report = buildFunctions('Store.kt', symbols, calls);
  const helper = report.functions.find((fn) => fn.name === 'helper');

  assert.ok(helper, 'expected the top-level helper to be recorded');
  assert.deepEqual(helper.callers, ['Store.loadsItems', 'main']);

  const testFn = report.functions.find((fn) => fn.name === 'loadsItems');
  assert.deepEqual(testFn?.entry, { kind: 'test', evidence: '@Test' });
  const main = report.functions.find((fn) => fn.name === 'main');
  assert.deepEqual(main?.entry, { kind: 'main', evidence: 'named main' });
});

// F2: functions passed by reference are entries with the passing line as evidence.
test('Rust handlers passed to a router are entries, not dead code', async () => {
  const source = [
    'fn handler() -> String {',
    '    String::from("ok")',
    '}',
    '',
    'fn main() {',
    '    let app = Router::new().route("/x", get(handler));',
    '}',
  ].join('\n');

  const { symbols, calls = [] } = await extractRustSymbols('server.rs', source);
  const report = buildFunctions('server.rs', symbols, calls);
  const handler = report.functions.find((fn) => fn.name === 'handler');

  assert.deepEqual(handler?.entry, { kind: 'handler', evidence: 'passed to get at L6' });
  assert.deepEqual(handler?.callers, []);
});

// F2: Kotlin function references are entries.
test('Kotlin ::references are entries with the passing line as evidence', async () => {
  const source = [
    'package com.acme.app',
    '',
    'fun save(): String {',
    '    return "ok"',
    '}',
    '',
    'fun screen() {',
    '    val action = ::save',
    '    println(action)',
    '}',
  ].join('\n');

  const { symbols, calls = [] } = await extractKotlinSymbols('Screen.kt', source);
  const report = buildFunctions('Screen.kt', symbols, calls);
  const save = report.functions.find((fn) => fn.name === 'save');

  assert.deepEqual(save?.entry, { kind: 'passed-as-value', evidence: 'passed as value at L8' });
});

// F2: Python test names and main are entries.
test('Python test_* and main functions are entries', async () => {
  const source = [
    'def helper():',
    '    return 1',
    '',
    'def test_helper():',
    '    assert helper() == 1',
    '',
    'def main():',
    '    print(helper())',
  ].join('\n');

  const { symbols, calls = [] } = await extractPythonSymbols('test_store.py', source);
  const report = buildFunctions('test_store.py', symbols, calls);
  const helper = report.functions.find((fn) => fn.name === 'helper');

  assert.deepEqual(helper?.callers, ['test_store.main', 'test_store.test_helper']);
  assert.deepEqual(report.functions.find((fn) => fn.name === 'test_helper')?.entry, {
    kind: 'test',
    evidence: 'named test_*',
  });
  assert.deepEqual(report.functions.find((fn) => fn.name === 'main')?.entry, {
    kind: 'main',
    evidence: 'named main',
  });
});

// F2: TypeScript it/test bodies and main are entries.
test('TypeScript test-framework bodies and main are entries', async () => {
  const source = [
    "export function helper(): string {",
    "  return 'hi';",
    '}',
    'export function main(): void {',
    '  helper();',
    '}',
    "describe('app', () => {",
    '  function setup(): void {',
    '    helper();',
    '  }',
    "  it('works', () => {",
    '    setup();',
    '  });',
    '});',
  ].join('\n');

  const { symbols, calls = [] } = await extractTypeScriptSymbols('sample.ts', source);
  const report = buildFunctions('sample.ts', symbols, calls);

  const setup = report.functions.find((fn) => fn.name === 'setup');
  assert.equal(setup?.entry?.kind, 'test');
  assert.match(setup?.entry?.evidence ?? '', /describe body at L\d+/);

  assert.deepEqual(report.functions.find((fn) => fn.name === 'main')?.entry, {
    kind: 'main',
    evidence: 'named main',
  });

  const helper = report.functions.find((fn) => fn.name === 'helper');
  assert.ok(helper?.callers.includes('sample.setup'), `callers were ${helper?.callers}`);
});

// F2: Java @Test and main are entries.
test('Java @Test and main methods are entries', async () => {
  const source = [
    'package com.acme;',
    'import org.junit.Test;',
    'public class Store {',
    '    @Test',
    '    public void loadsItems() {',
    '        helper();',
    '    }',
    '    public static void main(String[] args) {',
    '        helper();',
    '    }',
    '    static void helper() {}',
    '}',
  ].join('\n');

  const { symbols, calls = [] } = await extractJavaSymbols('Store.java', source);
  const report = buildFunctions('Store.java', symbols, calls);

  assert.deepEqual(report.functions.find((fn) => fn.name === 'loadsItems')?.entry, {
    kind: 'test',
    evidence: '@Test',
  });
  assert.deepEqual(report.functions.find((fn) => fn.name === 'main')?.entry, {
    kind: 'main',
    evidence: 'named main',
  });
  assert.deepEqual(report.functions.find((fn) => fn.name === 'helper')?.callers, [
    'Store.loadsItems',
    'Store.main',
  ]);
});

// F2: C# [Fact] and Main are entries.
test('C# [Fact] and Main methods are entries', async () => {
  const source = [
    'using Xunit;',
    'public class Store {',
    '    [Fact]',
    '    public void LoadsItems() {',
    '        Helper();',
    '    }',
    '    public static void Main(string[] args) {',
    '        Helper();',
    '    }',
    '    static void Helper() {}',
    '}',
  ].join('\n');

  const { symbols, calls = [] } = await extractCSharpSymbols('Store.cs', source);
  const report = buildFunctions('Store.cs', symbols, calls);

  assert.deepEqual(report.functions.find((fn) => fn.name === 'LoadsItems')?.entry, {
    kind: 'test',
    evidence: '[Fact]',
  });
  assert.deepEqual(report.functions.find((fn) => fn.name === 'Main')?.entry, {
    kind: 'main',
    evidence: 'named main',
  });
});

// F2/F3: entry-aware captions reserve "no callers" for functions with no entry,
// and name the intra-file scope for public functions.
test('functionCallers prefers the entry badge and names the intra-file scope', () => {
  assert.equal(
    functionCallers({ callers: [], entry: { kind: 'test', evidence: '#[test]' } }),
    'entry: test (#[test])',
  );
  assert.equal(
    functionCallers({ callers: ['A.run'], entry: { kind: 'main', evidence: 'named main' } }),
    'A.run · entry: main (named main)',
  );
  assert.equal(
    functionCallers({ callers: [], visibility: 'public' }),
    'no callers in this file (cross-file not resolved)',
  );
  assert.equal(
    functionCallers({ callers: [], visibility: 'private' }),
    'no callers recorded in this file',
  );
  assert.equal(functionEntryBadge({ entry: { kind: 'handler', evidence: 'passed to get at L6' } }), 'entry: handler (passed to get at L6)');
  assert.equal(functionEntryBadge({}), '');
});

// F4: the default order is signal count, then complexity.
test('buildFunctions orders by signal count before complexity', async () => {
  const source = [
    'function plain(a: number): number {',
    '  if (a > 0) { return 1; }',
    '  if (a < 0) { return -1; }',
    '  if (a === 0) { return 0; }',
    '  return a;',
    '}',
    'function loopy(rows: number[][]): number {',
    '  let hits = 0;',
    '  for (const row of rows) {',
    '    for (const cell of row) {',
    '      if (cell > 0) { hits += 1; }',
    '    }',
    '  }',
    '  return hits;',
    '}',
  ].join('\n');

  const { symbols, calls = [] } = await extractTypeScriptSymbols('order.ts', source);
  const report = buildFunctions('order.ts', symbols, calls);

  assert.deepEqual(
    report.functions.map((fn) => fn.name),
    ['loopy', 'plain'],
  );
  assert.deepEqual(
    orderFunctions(report.functions).map((fn) => fn.name),
    ['loopy', 'plain'],
  );
});

// F4: the summary row counts functions, complexity, nesting, and signals.
test('functionSummary reports counts, complexity, nesting, and signals', () => {
  assert.equal(
    functionSummary({
      functions: [
        { metrics: { decisionPoints: 3, maxNestingDepth: 2 }, signals: [{ kind: 'nested-loops' }] },
        { metrics: { decisionPoints: 1, maxNestingDepth: 0 }, signals: [] },
        {},
      ],
    }),
    '3 functions · total complexity 4 · max complexity 3 · max nesting 2 · 1 signal',
  );
  assert.equal(functionSummary({ functions: [] }), '0 functions · total complexity 0 · max complexity 0 · max nesting 0 · 0 signals');
});
