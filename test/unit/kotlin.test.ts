import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractKotlinFacts, extractKotlinSymbols, resolveKotlin } from '../../src/scan/languages/kotlin.ts';
import { scanRepository } from '../../src/scan/scan.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'kotlin-repo');

function pairs(edges: Array<{ source: string; target: string }>): Set<string> {
  return new Set(edges.map((edge) => `${edge.source}->${edge.target}`));
}

test('extractKotlinFacts reads the package, imports, aliases, and nested types', async () => {
  const source = [
    'package com.acme.app',
    '',
    'import com.acme.util.Helper',
    'import com.acme.util.*',
    'import com.acme.util.Widget as W',
    'import com.acme.missing.Gone',
    '',
    'class Main {',
    '    class Inner',
    '}',
  ].join('\n');

  const { facts } = await extractKotlinFacts('Main.kt', source);

  assert.equal(facts.package, 'com.acme.app');
  assert.deepEqual(
    facts.imports.map((entry) => [entry.name, entry.wildcard, entry.alias]),
    [
      ['com.acme.util.Helper', false, undefined],
      ['com.acme.util', true, undefined],
      ['com.acme.util.Widget', false, 'W'],
      ['com.acme.missing.Gone', false, undefined],
    ],
  );
  assert.deepEqual(facts.types, [
    { name: 'Main', line: 8 },
    { name: 'Main.Inner', line: 9 },
  ]);
});

test('resolveKotlin reports an unresolved internal import but not external ones', () => {
  const { edges, diagnostics } = resolveKotlin([
    {
      file: 'app/Main.kt',
      package: 'com.acme.app',
      imports: [
        { name: 'com.acme.util.Helper', wildcard: false, line: 3 },
        { name: 'com.acme.util', wildcard: true, line: 4 },
        { name: 'com.acme.missing.Gone', wildcard: false, line: 5 },
        { name: 'java.util.Date', wildcard: false, line: 6 },
      ],
      types: [{ name: 'Main', line: 8 }],
      typeReferences: [{ name: 'Sibling', line: 9 }],
    },
    {
      file: 'app/Sibling.kt',
      package: 'com.acme.app',
      imports: [],
      types: [{ name: 'Sibling', line: 1 }],
      typeReferences: [],
    },
    {
      file: 'util/Helper.kt',
      package: 'com.acme.util',
      imports: [],
      types: [{ name: 'Helper', line: 1 }],
      typeReferences: [],
    },
  ]);

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.specifier, 'com.acme.missing.Gone');
  // Import + wildcard + same-package reference all land on a repository file.
  assert.ok(pairs(edges).has('app/Main.kt->util/Helper.kt'));
  assert.ok(pairs(edges).has('app/Main.kt->app/Sibling.kt'));
  assert.ok(!edges.some((edge) => edge.target.includes('java/util')));
});

test('scanRepository resolves Kotlin imports, aliases, and same-package references', async () => {
  const report = await scanRepository(fixture);
  const resolved = pairs(report.graph.edges);
  const main = 'src/main/kotlin/com/acme/app/Main.kt';

  assert.ok(resolved.has(`${main}->src/main/kotlin/com/acme/util/Helper.kt`));
  assert.ok(resolved.has(`${main}->src/main/kotlin/com/acme/util/Widget.kt`));
  assert.ok(resolved.has(`${main}->src/main/kotlin/com/acme/app/Sibling.kt`));
});

test('scanRepository resolves a Kotlin nested-type import', async () => {
  const report = await scanRepository(fixture);
  const resolved = pairs(report.graph.edges);

  assert.ok(
    resolved.has(
      'src/main/kotlin/com/acme/app/Outer.kt->src/main/kotlin/com/acme/util/Helper.kt',
    ),
  );
});

test('Kotlin unresolved imports are diagnostics; JDK imports are ignored', async () => {
  const report = await scanRepository(fixture);
  const mainDiagnostics = report.graph.diagnostics.filter((item) => item.file.endsWith('Main.kt'));

  assert.ok(mainDiagnostics.some((item) => item.specifier === 'com.acme.missing.Gone'));
  assert.ok(!mainDiagnostics.some((item) => item.specifier === 'java.util.Date'));
});

test('extractKotlinSymbols records fields and methods with visibility and owner', async () => {
  const source = [
    'package com.acme.app',
    '',
    'class Main {',
    '    private val helper: Helper = Helper()',
    '    var count: Int = 0',
    '    internal fun doWork(count: Int): String = "x"',
    '    fun greet()',
    '    companion object {',
    '        val shared = 1',
    '    }',
    '}',
  ].join('\n');

  const { symbols } = await extractKotlinSymbols('Main.kt', source);

  assert.deepEqual(
    symbols.map((symbol) => [
      symbol.kind,
      symbol.visibility,
      symbol.owner,
      symbol.name,
      symbol.type ?? '',
      symbol.mutable ?? false,
      symbol.parameters ?? 0,
    ]),
    [
      ['field', 'private', 'Main', 'helper', 'Helper', false, 0],
      ['field', 'public', 'Main', 'count', 'Int', true, 0],
      ['method', 'internal', 'Main', 'doWork', 'String', false, 1],
      ['method', 'public', 'Main', 'greet', '', false, 0],
      ['field', 'public', 'Main', 'shared', '', false, 0],
    ],
  );
});

test('extractKotlinSymbols records field reads and writes inside function bodies', async () => {
  const source = [
    'package com.acme.app',
    '',
    'class Counter {',
    '    private var value: Int = 0',
    '    private val label: String = "x"',
    '    fun add(delta: Int) {',
    '        value = value + delta',
    '        println(label)',
    '    }',
    '    fun shadow(value: Int) {',
    '        println(value)',
    '    }',
    '}',
  ].join('\n');

  const { accesses } = await extractKotlinSymbols('Counter.kt', source);
  const add = (accesses ?? []).filter((entry) => entry.method === 'add');
  assert.ok(add.some((entry) => entry.field === 'value' && entry.mode === 'write'));
  assert.ok(add.some((entry) => entry.field === 'value' && entry.mode === 'read'));
  assert.ok(add.some((entry) => entry.field === 'label' && entry.mode === 'read'));
  assert.equal(
    (accesses ?? []).some((entry) => entry.method === 'shadow'),
    false,
    'a parameter shadows the property, so no access is recorded',
  );
});

test('extractKotlinSymbols records body metrics and leaves a declaration without them', async () => {
  const source = [
    'class A {',
    '  fun f(xs: List<Int>): Int {',
    '    var t = 0',
    '    for (x in xs) {',
    '      if (x > 0 && x % 2 == 0) {',
    '        t += x',
    '      }',
    '    }',
    '    return if (t > 0) t else 0',
    '  }',
    '  fun sig(x: Int): Int',
    '}',
  ].join('\n');

  const { symbols } = await extractKotlinSymbols('A.kt', source);
  const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
  assert.equal(byName.get('f')?.metrics?.endLine, 10);
  assert.equal(byName.get('f')?.metrics?.lines, 9);
  assert.equal(byName.get('f')?.metrics?.loops, 1);
  assert.equal(byName.get('f')?.metrics?.maxNestingDepth, 2);
  assert.equal(byName.get('f')?.metrics?.decisionPoints, 5);
  assert.equal(byName.get('sig')?.metrics, undefined);
});

test('extractKotlinSymbols records intra-file calls and flags recursion', async () => {
  const source = [
    'class A {',
    '  fun run() { helper(); this.two(); A.three(); x.four() }',
    '  fun helper() {}',
    '  fun two() {}',
    '  companion object { fun three() {} }',
    '  fun rec() { rec() }',
    '}',
  ].join('\n');

  const { symbols, calls = [] } = await extractKotlinSymbols('A.kt', source);
  const run = calls.filter((call) => call.method === 'run').map((call) => `${call.callee}:${call.kind}`);
  assert.deepEqual(run.sort(), ['helper:bare', 'three:type-qualified', 'two:self']);
  assert.equal(calls.some((call) => call.callee === 'four'), false);
  const rec = symbols.find((symbol) => symbol.name === 'rec');
  assert.equal(rec?.metrics?.recursive, true);
});

test('Kotlin edges are deterministic across scans', async () => {
  const first = await scanRepository(fixture);
  const second = await scanRepository(fixture);
  assert.deepEqual([...pairs(first.graph.edges)].sort(), [...pairs(second.graph.edges)].sort());
});
