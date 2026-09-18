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
