import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildMemberMap } from '../../src/index.ts';
import type { CodeSymbol, MemberAccess } from '../../src/index.ts';

function symbol(partial: Partial<CodeSymbol> & Pick<CodeSymbol, 'name' | 'kind'>): CodeSymbol {
  return { visibility: 'public', owner: '', line: 1, ...partial };
}

function access(
  partial: Partial<MemberAccess> & Pick<MemberAccess, 'field' | 'method' | 'mode'>,
): MemberAccess {
  return { owner: 'Main', qualified: false, line: 1, ...partial };
}

test('buildMemberMap groups fields and methods by owner and counts references', () => {
  const symbols: CodeSymbol[] = [
    symbol({ name: 'Main', kind: 'type' }),
    symbol({ name: 'count', kind: 'field', owner: 'Main', type: 'int' }),
    symbol({ name: 'name', kind: 'field', owner: 'Main', type: 'String' }),
    symbol({ name: 'temp', kind: 'field', owner: 'Main', type: 'int' }),
    symbol({ name: 'greet', kind: 'method', owner: 'Main', parameters: 1 }),
    symbol({ name: 'reset', kind: 'method', owner: 'Main' }),
    symbol({ name: 'compute', kind: 'method', owner: 'Main' }),
  ];
  const accesses: MemberAccess[] = [
    access({ field: 'count', method: 'greet', mode: 'read' }),
    access({ field: 'count', method: 'greet', mode: 'write' }),
    access({ field: 'name', method: 'greet', mode: 'read' }),
    access({ field: 'count', method: 'reset', mode: 'write' }),
    access({ field: 'name', method: 'compute', mode: 'read' }),
    access({ field: 'temp', method: 'compute', mode: 'write' }),
  ];

  const map = buildMemberMap('Main.java', symbols, accesses);
  assert.equal(map.available, true);
  assert.equal(map.types.length, 1);

  const type = map.types[0]!;
  assert.equal(type.name, 'Main');
  const count = type.fields.find((field) => field.name === 'count');
  assert.equal(count?.reads, 1);
  assert.equal(count?.writes, 2);

  const greet = type.methods.find((method) => method.name === 'greet');
  assert.deepEqual(greet?.reads.sort(), ['count', 'name']);
  assert.deepEqual(greet?.writes, ['count']);
});

test('buildMemberMap classifies data-flow panels from recorded references', () => {
  const symbols: CodeSymbol[] = [
    symbol({ name: 'Main', kind: 'type' }),
    symbol({ name: 'count', kind: 'field', owner: 'Main' }),
    symbol({ name: 'name', kind: 'field', owner: 'Main' }),
    symbol({ name: 'temp', kind: 'field', owner: 'Main' }),
    symbol({ name: 'greet', kind: 'method', owner: 'Main' }),
    symbol({ name: 'reset', kind: 'method', owner: 'Main' }),
    symbol({ name: 'compute', kind: 'method', owner: 'Main' }),
  ];
  const accesses: MemberAccess[] = [
    access({ field: 'count', method: 'greet', mode: 'read' }),
    access({ field: 'count', method: 'greet', mode: 'write' }),
    access({ field: 'name', method: 'greet', mode: 'read' }),
    access({ field: 'count', method: 'reset', mode: 'write' }),
    access({ field: 'name', method: 'compute', mode: 'read' }),
    access({ field: 'temp', method: 'compute', mode: 'write' }),
  ];

  const { dataFlow } = buildMemberMap('Main.java', symbols, accesses);
  assert.equal(dataFlow.available, true);
  assert.deepEqual(dataFlow.sources, ['name']);
  assert.deepEqual(dataFlow.resources, ['count']);
  assert.deepEqual(dataFlow.sinks, ['temp']);
  assert.deepEqual(dataFlow.transforms, ['Main.compute', 'Main.greet']);
  assert.match(dataFlow.caveat ?? '', /recorded in this file/);
});

test('buildMemberMap carries the names a barrel re-exports, sorted by line', () => {
  const map = buildMemberMap('src/index.ts', [], [], [
    { name: 'beta', from: './b.ts', typeOnly: false, line: 2 },
    { name: 'alpha', from: './a.ts', typeOnly: true, line: 1 },
  ]);

  assert.equal(map.available, true);
  assert.equal(map.types.length, 0);
  assert.deepEqual(
    map.reExports.map((entry) => [entry.name, entry.from, entry.typeOnly]),
    [
      ['alpha', './a.ts', true],
      ['beta', './b.ts', false],
    ],
  );
});

test('buildMemberMap reports no re-exports for a file that forwards nothing', () => {
  const map = buildMemberMap('Main.java', [], []);
  assert.deepEqual(map.reExports, []);
});

test('buildMemberMap reports unavailable data flow when no reference was recorded', () => {
  const symbols: CodeSymbol[] = [
    symbol({ name: 'Main', kind: 'type' }),
    symbol({ name: 'count', kind: 'field', owner: 'Main' }),
  ];

  const { dataFlow } = buildMemberMap('Main.java', symbols, []);
  assert.equal(dataFlow.available, false);
  assert.equal(dataFlow.reason, 'no-field-access');
  assert.deepEqual(dataFlow.sources, []);
});
