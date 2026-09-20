import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractCSharpSymbols } from '../../src/scan/languages/csharp.ts';
import { extractJavaSymbols } from '../../src/scan/languages/java.ts';
import { extractRustSymbols } from '../../src/scan/languages/rust.ts';
import type { CodeSymbol } from '../../src/scan/languages/symbols.ts';

function byName(symbols: CodeSymbol[]): Map<string, CodeSymbol> {
  return new Map(symbols.map((symbol) => [symbol.name, symbol]));
}

test('extractJavaSymbols records types, fields, and methods with visibility', async () => {
  const source = [
    'package com.acme;',
    'public class Main {',
    '  private int count = 0;',
    '  public static final String NAME = "x";',
    '  protected String greet(int n) { return "x"; }',
    '  void internalMethod() {}',
    '}',
  ].join('\n');

  const { symbols } = await extractJavaSymbols('Main.java', source);
  const map = byName(symbols);

  assert.equal(map.get('Main')?.kind, 'type');
  assert.equal(map.get('count')?.visibility, 'private');
  assert.equal(map.get('count')?.type, 'int');
  assert.equal(map.get('count')?.mutable, true);
  assert.equal(map.get('NAME')?.visibility, 'public');
  assert.equal(map.get('NAME')?.mutable, false);
  assert.equal(map.get('greet')?.visibility, 'protected');
  assert.equal(map.get('greet')?.parameters, 1);
  assert.equal(map.get('internalMethod')?.visibility, 'package');
});

test('extractRustSymbols records struct fields and impl methods', async () => {
  const source = [
    'pub struct Config { pub name: String, count: u32 }',
    'impl Config {',
    '    pub fn new(name: String) -> Config { Config { } }',
    '    fn helper(&self) {}',
    '}',
  ].join('\n');

  const { symbols } = await extractRustSymbols('config.rs', source);
  const map = byName(symbols);

  assert.equal(map.get('Config')?.kind, 'type');
  assert.equal(map.get('Config')?.visibility, 'public');
  assert.equal(map.get('name')?.visibility, 'public');
  assert.equal(map.get('name')?.owner, 'Config');
  assert.equal(map.get('name')?.type, 'String');
  assert.equal(map.get('count')?.visibility, 'private');
  assert.equal(map.get('new')?.owner, 'Config');
  assert.equal(map.get('new')?.type, 'Config');
  assert.equal(map.get('helper')?.visibility, 'private');
});

test('extractCSharpSymbols records fields, properties, and methods', async () => {
  const source = [
    'namespace Acme {',
    '  public class Main {',
    '    private int count;',
    '    public string Name { get; set; }',
    '    protected string Greet(int n) { return "x"; }',
    '    void Internal() {}',
    '  }',
    '}',
  ].join('\n');

  const { symbols } = await extractCSharpSymbols('Main.cs', source);
  const map = byName(symbols);

  assert.equal(map.get('Main')?.kind, 'type');
  assert.equal(map.get('Main')?.visibility, 'public');
  assert.equal(map.get('count')?.visibility, 'private');
  assert.equal(map.get('count')?.type, 'int');
  assert.equal(map.get('Name')?.kind, 'property');
  assert.equal(map.get('Name')?.mutable, true);
  assert.equal(map.get('Greet')?.visibility, 'protected');
  assert.equal(map.get('Greet')?.type, 'string');
  assert.equal(map.get('Greet')?.parameters, 1);
  assert.equal(map.get('Internal')?.visibility, 'private');
});

test('extractJavaSymbols records field reads and writes inside method bodies', async () => {
  const source = [
    'package com.acme;',
    'public class Main {',
    '  private int count = 0;',
    '  private String name = "x";',
    '  public int greet(int n) {',
    '    this.count = n;',
    '    return count + name.length();',
    '  }',
    '  public void reset() { count = 0; }',
    '  public void shadow(int count) { count = count + 1; }',
    '}',
  ].join('\n');

  const { accesses } = await extractJavaSymbols('Main.java', source);
  const greet = (accesses ?? []).filter((entry) => entry.method === 'greet');

  const countWrite = greet.find((entry) => entry.field === 'count' && entry.mode === 'write');
  assert.equal(countWrite?.qualified, true);
  const countRead = greet.find((entry) => entry.field === 'count' && entry.mode === 'read');
  assert.equal(countRead?.qualified, false);
  assert.ok(greet.some((entry) => entry.field === 'name' && entry.mode === 'read'));

  assert.equal(
    (accesses ?? []).some((entry) => entry.method === 'shadow'),
    false,
    'a parameter shadows the field, so no access is recorded',
  );
});

test('extractCSharpSymbols records reads and writes through this and a property', async () => {
  const source = [
    'namespace Acme {',
    '  public class Main {',
    '    private int count;',
    '    public string Name { get; set; }',
    '    public void Set(int value) {',
    '      this.count = value;',
    '      Name = this.count.ToString();',
    '    }',
    '  }',
    '}',
  ].join('\n');

  const { accesses } = await extractCSharpSymbols('Main.cs', source);
  const write = (accesses ?? []).find((entry) => entry.field === 'count' && entry.mode === 'write');
  assert.equal(write?.qualified, true);
  assert.ok((accesses ?? []).some((entry) => entry.field === 'count' && entry.mode === 'read'));
  assert.ok((accesses ?? []).some((entry) => entry.field === 'Name' && entry.mode === 'write'));
});

test('extractRustSymbols records self.field reads and writes', async () => {
  const source = [
    'pub struct Config { pub count: u32 }',
    'impl Config {',
    '    pub fn bump(&mut self) {',
    '        self.count = self.count + 1;',
    '    }',
    '}',
  ].join('\n');

  const { accesses } = await extractRustSymbols('config.rs', source);
  assert.ok((accesses ?? []).some((entry) => entry.field === 'count' && entry.mode === 'write'));
  assert.ok((accesses ?? []).some((entry) => entry.field === 'count' && entry.mode === 'read'));
});

test('extractJavaSymbols records body metrics and leaves a signature without them', async () => {
  const source = [
    'class A {',
    '  int f(int[] xs) {',
    '    int t = 0;',
    '    for (int x : xs) {',
    '      if (x > 0 && x % 2 == 0) {',
    '        t += x;',
    '      }',
    '    }',
    '    return t > 0 ? t : 0;',
    '  }',
    '  int sig(int x);',
    '}',
  ].join('\n');

  const { symbols } = await extractJavaSymbols('A.java', source);
  const map = byName(symbols);
  assert.equal(map.get('f')?.metrics?.endLine, 10);
  assert.equal(map.get('f')?.metrics?.lines, 9);
  assert.equal(map.get('f')?.metrics?.loops, 1);
  assert.equal(map.get('f')?.metrics?.maxNestingDepth, 2);
  assert.equal(map.get('f')?.metrics?.decisionPoints, 5);
  assert.equal(map.get('sig')?.metrics, undefined);
});

test('extractRustSymbols records body metrics from loops, branches, and operators', async () => {
  const source = [
    'impl A {',
    '  fn f(xs: &[i32]) -> i32 {',
    '    let mut t = 0;',
    '    for x in xs {',
    '      if *x > 0 && x % 2 == 0 {',
    '        t += x;',
    '      }',
    '    }',
    '    if t > 0 { t } else { 0 }',
    '  }',
    '}',
  ].join('\n');

  const { symbols } = await extractRustSymbols('a.rs', source);
  const map = byName(symbols);
  assert.equal(map.get('f')?.metrics?.endLine, 10);
  assert.equal(map.get('f')?.metrics?.lines, 9);
  assert.equal(map.get('f')?.metrics?.loops, 1);
  assert.equal(map.get('f')?.metrics?.maxNestingDepth, 2);
  assert.equal(map.get('f')?.metrics?.decisionPoints, 5);
});

test('extractCSharpSymbols records body metrics and leaves a signature without them', async () => {
  const source = [
    'class A {',
    '  int F(int[] xs) {',
    '    int t = 0;',
    '    foreach (var x in xs) {',
    '      if (x > 0 && x % 2 == 0) {',
    '        t += x;',
    '      }',
    '    }',
    '    return t > 0 ? t : 0;',
    '  }',
    '  int Sig(int x);',
    '}',
  ].join('\n');

  const { symbols } = await extractCSharpSymbols('A.cs', source);
  const map = byName(symbols);
  assert.equal(map.get('F')?.metrics?.endLine, 10);
  assert.equal(map.get('F')?.metrics?.lines, 9);
  assert.equal(map.get('F')?.metrics?.loops, 1);
  assert.equal(map.get('F')?.metrics?.maxNestingDepth, 2);
  assert.equal(map.get('F')?.metrics?.decisionPoints, 5);
  assert.equal(map.get('Sig')?.metrics, undefined);
});

test('extractJavaSymbols records intra-file calls, skips a member call on a value, and flags recursion', async () => {
  const source = [
    'class A {',
    '  void run() { helper(); this.two(); A.three(); x.four(); }',
    '  void helper() {}',
    '  void two() {}',
    '  static void three() {}',
    '  void rec() { rec(); }',
    '}',
  ].join('\n');

  const { symbols, calls = [] } = await extractJavaSymbols('A.java', source);
  const run = calls.filter((call) => call.method === 'run').map((call) => `${call.callee}:${call.kind}`);
  assert.deepEqual(run.sort(), ['helper:bare', 'three:type-qualified', 'two:self']);
  assert.equal(calls.some((call) => call.callee === 'four'), false);
  assert.equal(byName(symbols).get('rec')?.metrics?.recursive, true);
  assert.equal(byName(symbols).get('run')?.metrics?.recursive, false);
});

test('extractRustSymbols records bare, self, and type-qualified calls', async () => {
  const source = [
    'fn helper() {}',
    'impl A {',
    '  fn run(&self) { helper(); self.two(); A::three(); x.four(); }',
    '  fn two(&self) {}',
    '  fn three() {}',
    '  fn rec(&self) { self.rec(); }',
    '}',
  ].join('\n');

  const { symbols, calls = [] } = await extractRustSymbols('a.rs', source);
  const run = calls.filter((call) => call.method === 'run').map((call) => `${call.callee}:${call.kind}`);
  assert.deepEqual(run.sort(), ['helper:bare', 'three:type-qualified', 'two:self']);
  assert.equal(calls.some((call) => call.callee === 'four'), false);
  assert.equal(byName(symbols).get('rec')?.metrics?.recursive, true);
});

test('extractCSharpSymbols records intra-file calls and flags recursion', async () => {
  const source = [
    'class A {',
    '  void Run() { Helper(); this.Two(); A.Three(); x.Four(); }',
    '  void Helper() {}',
    '  void Two() {}',
    '  static void Three() {}',
    '  void Rec() { Rec(); }',
    '}',
  ].join('\n');

  const { symbols, calls = [] } = await extractCSharpSymbols('A.cs', source);
  const run = calls.filter((call) => call.method === 'Run').map((call) => `${call.callee}:${call.kind}`);
  assert.deepEqual(run.sort(), ['Helper:bare', 'Three:type-qualified', 'Two:self']);
  assert.equal(calls.some((call) => call.callee === 'Four'), false);
  assert.equal(byName(symbols).get('Rec')?.metrics?.recursive, true);
});
