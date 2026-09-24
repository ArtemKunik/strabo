import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractControl, parseControlLine } from '../../ui/strabo-terminal-control.js';

test('parseControlLine accepts whitelisted verbs and rejects everything else', () => {
  assert.deepEqual(parseControlLine('::strabo::focus src/a.ts'), { verb: 'focus', args: ['src/a.ts'] });
  assert.deepEqual(parseControlLine('::strabo::open src/a.ts 42'), {
    verb: 'open',
    args: ['src/a.ts', '42'],
  });
  assert.deepEqual(parseControlLine('::strabo::review'), { verb: 'review', args: [] });
  assert.deepEqual(parseControlLine('::strabo::note build failed'), {
    verb: 'note',
    args: ['build', 'failed'],
  });
  assert.equal(parseControlLine('::strabo::rm -rf /'), null);
  assert.equal(parseControlLine('::strabo::'), null);
  assert.equal(parseControlLine('plain output'), null);
  assert.equal(parseControlLine(''), null);
});

test('parseControlLine caps the number and length of arguments', () => {
  const many = parseControlLine(`::strabo::highlight ${Array.from({ length: 100 }, (_, i) => `n${i}`).join(' ')}`);
  assert.equal(many.args.length, 64);
  const long = parseControlLine(`::strabo::note ${'x'.repeat(9000)}`);
  assert.equal(long.args[0].length, 4096);
});

test('extractControl passes ordinary output through untouched', () => {
  assert.deepEqual(extractControl('', 'hello world\n'), {
    text: 'hello world\n',
    directives: [],
    carry: '',
  });
  // A prompt has no trailing newline and must not be held back.
  assert.deepEqual(extractControl('', 'PS D:\\repo>'), {
    text: 'PS D:\\repo>',
    directives: [],
    carry: '',
  });
});

test('extractControl removes a marker line and returns the directive', () => {
  const result = extractControl('', 'before\n::strabo::focus src/a.ts\nafter\n');
  assert.equal(result.text, 'before\nafter\n');
  assert.deepEqual(result.directives, [{ verb: 'focus', args: ['src/a.ts'] }]);
  assert.equal(result.carry, '');
});

test('extractControl swallows an unknown marker without dispatching it', () => {
  const result = extractControl('', '::strabo::launch-missiles now\n');
  assert.equal(result.text, '');
  assert.deepEqual(result.directives, []);
});

test('extractControl reassembles a marker split across chunks', () => {
  const first = extractControl('', 'output\n::str');
  assert.equal(first.text, 'output\n');
  assert.deepEqual(first.directives, []);
  assert.equal(first.carry, '::str');

  const second = extractControl(first.carry, 'abo::note all good\nrest\n');
  assert.equal(second.text, 'rest\n');
  assert.deepEqual(second.directives, [{ verb: 'note', args: ['all', 'good'] }]);
  assert.equal(second.carry, '');
});

test('extractControl handles a marker with a carriage return from the PTY', () => {
  const result = extractControl('', '::strabo::screen graph\r\n');
  assert.equal(result.text, '');
  assert.deepEqual(result.directives, [{ verb: 'screen', args: ['graph'] }]);
});
