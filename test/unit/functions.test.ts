import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildFunctions } from '../../src/analysis/functions.ts';
import { extractTypeScriptSymbols } from '../../src/scan/languages/typescript.ts';

test('buildFunctions orders by complexity and records callees and callers', async () => {
  const source = [
    'class A {',
    '  run(): void {',
    '    this.helper();',
    '    util();',
    '    this.branchy(1);',
    '  }',
    '  helper(): void {}',
    '  branchy(n: number): void {',
    '    if (n > 0) {',
    '      this.helper();',
    '    }',
    '  }',
    '}',
    'function util(n: number): void {',
    '  if (n > 0) {}',
    '  if (n < 0) {}',
    '}',
  ].join('\n');

  const { symbols, calls = [] } = await extractTypeScriptSymbols('functions-fixture.ts', source);
  const report = buildFunctions('functions-fixture.ts', symbols, calls);

  assert.equal(report.available, true);
  assert.deepEqual(
    report.functions.map((fn) => `${fn.owner}.${fn.name}`),
    ['functions-fixture.util', 'A.branchy', 'A.run', 'A.helper'],
  );

  const run = report.functions.find((fn) => fn.name === 'run');
  assert.deepEqual(
    run?.calls.map((call) => `${call.name}:${call.kind}`),
    ['helper:self', 'util:bare', 'branchy:self'],
  );

  const helper = report.functions.find((fn) => fn.name === 'helper');
  assert.deepEqual(helper?.callers, ['A.branchy', 'A.run']);

  const util = report.functions.find((fn) => fn.name === 'util');
  assert.deepEqual(util?.callers, ['A.run']);
});

test('buildFunctions sorts a signature without a body last', async () => {
  const source = ['interface Api {', '  call(x: number): void;', '}'].join('\n');
  const { symbols, calls = [] } = await extractTypeScriptSymbols('api.ts', source);

  const report = buildFunctions('api.ts', symbols, calls);
  assert.equal(report.functions.length, 1);
  assert.equal(report.functions[0]?.name, 'call');
  assert.equal(report.functions[0]?.metrics, undefined);
  assert.deepEqual(report.functions[0]?.calls, []);
});

test('buildFunctions returns an empty list for a file with no functions', async () => {
  const { symbols, calls = [] } = await extractTypeScriptSymbols('consts.ts', 'const MAX = 10;\n');
  assert.deepEqual(buildFunctions('consts.ts', symbols, calls), {
    file: 'consts.ts',
    available: true,
    functions: [],
  });
});
