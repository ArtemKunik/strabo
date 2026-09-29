import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildMemberMap,
  extractJavaFacts,
  extractJavaSymbols,
  extractTypeScriptSymbols,
  resolveJava,
  scanJsTsCalls,
  scanRepository,
} from '../../src/index.ts';

function content(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files));
}

function inheritancePairs(edges: Array<{ source: string; target: string; kind: string }>): string[] {
  return edges
    .filter((edge) => edge.kind === 'inheritance')
    .map((edge) => `${edge.source}->${edge.target}`);
}

/* ---------------------------------------------------------------- TypeScript */

test('extractTypeScriptSymbols records extends and implements on the type', async () => {
  const source = [
    "import { Base } from './base';",
    'export class Circle extends Base implements Drawable, Serializable {}',
    'interface Shape extends Comparable, Cloneable {}',
    'class Generic<T> extends Map<T, string> {}',
  ].join('\n');

  const { symbols } = await extractTypeScriptSymbols('shapes.ts', source);

  const circle = symbols.find((symbol) => symbol.name === 'Circle');
  assert.deepEqual(circle?.superTypes, [
    { name: 'Base', relation: 'extends', line: 2 },
    { name: 'Drawable', relation: 'implements', line: 2 },
    { name: 'Serializable', relation: 'implements', line: 2 },
  ]);

  const shape = symbols.find((symbol) => symbol.name === 'Shape');
  assert.deepEqual(shape?.superTypes, [
    { name: 'Comparable', relation: 'extends', line: 3 },
    { name: 'Cloneable', relation: 'extends', line: 3 },
  ]);

  const generic = symbols.find((symbol) => symbol.name === 'Generic');
  assert.deepEqual(generic?.superTypes, [{ name: 'Map', relation: 'extends', line: 4 }]);
});

test('buildMemberMap exposes the supertypes of a type', () => {
  const map = buildMemberMap('shapes.ts', [
    {
      name: 'Circle',
      kind: 'type',
      visibility: 'public',
      owner: '',
      line: 1,
      superTypes: [{ name: 'Shape', relation: 'implements', line: 1 }],
    },
  ], []);
  assert.deepEqual(map.types[0]?.superTypes, [
    { name: 'Shape', relation: 'implements', line: 1 },
  ]);
});

/* ---------------------------------------------------------------- JS/TS edges */

test('a value import and an extends clause become an inheritance edge', async () => {
  const result = await scanJsTsCalls(
    ['src/a.ts', 'src/b.ts'],
    content({
      'src/a.ts': 'export class Base {}\n',
      'src/b.ts': "import { Base } from './a';\nexport class Derived extends Base {}\n",
    }),
  );

  const edge = result.edges.find((entry) => entry.kind === 'inheritance');
  assert.deepEqual(inheritancePairs(result.edges), ['src/b.ts->src/a.ts']);
  assert.equal(edge?.evidence.specifier, 'extends Base');
  assert.equal(edge?.relationship, 'inheritance');
});

test('a type-only import still resolves an extends target', async () => {
  const result = await scanJsTsCalls(
    ['src/a.ts', 'src/b.ts'],
    content({
      'src/a.ts': 'export interface Base {}\n',
      'src/b.ts': "import type { Base } from './a';\nexport interface Derived extends Base {}\n",
    }),
  );

  assert.deepEqual(inheritancePairs(result.edges), ['src/b.ts->src/a.ts']);
});

test('a default-exported type resolves through a default import', async () => {
  const result = await scanJsTsCalls(
    ['src/a.ts', 'src/b.ts'],
    content({
      'src/a.ts': 'export default class Base {}\n',
      'src/b.ts': "import Base from './a';\nexport class Derived extends Base {}\n",
    }),
  );

  assert.deepEqual(inheritancePairs(result.edges), ['src/b.ts->src/a.ts']);
});

test('a supertype declared in the same file draws no edge', async () => {
  const result = await scanJsTsCalls(
    ['src/b.ts'],
    content({
      'src/b.ts': 'class Base {}\nexport class Derived extends Base {}\n',
    }),
  );

  assert.deepEqual(inheritancePairs(result.edges), []);
});

test('a target that does not export a type of that name draws no edge', async () => {
  const result = await scanJsTsCalls(
    ['src/a.ts', 'src/b.ts'],
    content({
      'src/a.ts': 'export const value = 1;\n',
      'src/b.ts': "import { Base } from './a';\nexport class Derived extends Base {}\n",
    }),
  );

  assert.deepEqual(inheritancePairs(result.edges), []);
});

test('an external supertype draws no edge', async () => {
  const result = await scanJsTsCalls(
    ['src/b.ts'],
    content({
      'src/b.ts': "import { Base } from 'external-lib';\nexport class Derived extends Base {}\n",
    }),
  );

  assert.deepEqual(inheritancePairs(result.edges), []);
});

/* ---------------------------------------------------------------- Java symbols */

test('extractJavaSymbols records extends and implements on each type', async () => {
  const source = [
    'package com.acme.app;',
    'import com.acme.util.Base;',
    'public class Circle extends Base implements Drawable, Serializable {}',
    'interface Shape extends Comparable, Cloneable {}',
    'record Point(int x) implements Runnable {}',
    'enum Color implements Runnable {}',
  ].join('\n');

  const { symbols } = await extractJavaSymbols('Circle.java', source);

  assert.deepEqual(symbols.find((symbol) => symbol.name === 'Circle')?.superTypes, [
    { name: 'Base', relation: 'extends', line: 3 },
    { name: 'Drawable', relation: 'implements', line: 3 },
    { name: 'Serializable', relation: 'implements', line: 3 },
  ]);
  assert.deepEqual(symbols.find((symbol) => symbol.name === 'Shape')?.superTypes, [
    { name: 'Comparable', relation: 'extends', line: 4 },
    { name: 'Cloneable', relation: 'extends', line: 4 },
  ]);
  assert.deepEqual(symbols.find((symbol) => symbol.name === 'Point')?.superTypes, [
    { name: 'Runnable', relation: 'implements', line: 5 },
  ]);
  assert.deepEqual(symbols.find((symbol) => symbol.name === 'Color')?.superTypes, [
    { name: 'Runnable', relation: 'implements', line: 6 },
  ]);
});

/* ---------------------------------------------------------------- Java edges */

test('extractJavaFacts records supertypes from the file', async () => {
  const source = [
    'package com.acme.app;',
    'import com.acme.util.Helper;',
    'public class Main extends Helper implements Runnable {}',
  ].join('\n');

  const { facts } = await extractJavaFacts('Main.java', source);
  assert.deepEqual(facts.supertypes, [
    { name: 'Helper', relation: 'extends', line: 3 },
    { name: 'Runnable', relation: 'implements', line: 3 },
  ]);
});

test('resolveJava joins a supertype to an imported file', () => {
  const { edges } = resolveJava([
    {
      file: 'app/Main.java',
      package: 'com.acme.app',
      imports: [{ name: 'com.acme.util.Helper', static: false, wildcard: false, line: 2 }],
      types: [{ name: 'Main', line: 3 }],
      typeReferences: [],
      methods: [],
      calls: [],
      supertypes: [{ name: 'Helper', relation: 'extends', line: 3 }],
    },
    {
      file: 'util/Helper.java',
      package: 'com.acme.util',
      imports: [],
      types: [{ name: 'Helper', line: 1 }],
      typeReferences: [],
      methods: [],
      calls: [],
      supertypes: [],
    },
  ]);

  const edge = edges.find((entry) => entry.kind === 'inheritance');
  assert.ok(edge);
  assert.equal(edge?.source, 'app/Main.java');
  assert.equal(edge?.target, 'util/Helper.java');
  assert.equal(edge?.evidence.specifier, 'extends Helper');
  assert.equal(edge?.relationship, 'inheritance');
});

test('resolveJava joins a same-package supertype and leaves an external one unclaimed', () => {
  const { edges } = resolveJava([
    {
      file: 'app/Main.java',
      package: 'com.acme.app',
      imports: [{ name: 'java.util.List', static: false, wildcard: false, line: 2 }],
      types: [{ name: 'Main', line: 3 }],
      typeReferences: [],
      methods: [],
      calls: [],
      supertypes: [
        { name: 'Local', relation: 'extends', line: 3 },
        { name: 'List', relation: 'implements', line: 3 },
      ],
    },
    {
      file: 'app/Local.java',
      package: 'com.acme.app',
      imports: [],
      types: [{ name: 'Local', line: 1 }],
      typeReferences: [],
      methods: [],
      calls: [],
      supertypes: [],
    },
  ]);

  assert.deepEqual(inheritancePairs(edges), ['app/Main.java->app/Local.java']);
});

/* ---------------------------------------------------------------- end to end */

test('scanRepository records inheritance as a first-class graph edge', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-inheritance-'));
  try {
    fs.writeFileSync(path.join(root, 'base.ts'), 'export class Base {}\n');
    fs.writeFileSync(
      path.join(root, 'derived.ts'),
      "import { Base } from './base';\nexport class Derived extends Base {}\n",
    );

    const report = await scanRepository(root);
    const edge = report.graph.edges.find((entry) => entry.kind === 'inheritance');

    assert.ok(edge, 'the inheritance edge is in the graph');
    assert.equal(edge?.source, 'derived.ts');
    assert.equal(edge?.target, 'base.ts');
    assert.equal(edge?.relationship, 'inheritance');
    assert.equal(edge?.role, 'use');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
