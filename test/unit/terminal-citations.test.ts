import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { findCitations, linkifyCitations } from '../../src/terminal/citations.ts';

test('matches POSIX path:line and path:line:col', () => {
  const citations = findCitations('src/app.ts:12 and src/lib/util.js:3:7');
  assert.deepEqual(
    citations.map((entry) => ({ file: entry.file, line: entry.line, col: entry.col })),
    [
      { file: 'src/app.ts', line: 12, col: undefined },
      { file: 'src/lib/util.js', line: 3, col: 7 },
    ],
  );
});

test('matches Windows drive paths and normalises separators', () => {
  const citations = findCitations(String.raw`error at C:\repo\src\main.ts:42:5`);
  assert.equal(citations.length, 1);
  assert.equal(citations[0]?.file, 'C:/repo/src/main.ts');
  assert.equal(citations[0]?.line, 42);
  assert.equal(citations[0]?.col, 5);
});

test('matches Node stack frames with and without a function name', () => {
  const stack = [
    'Error: boom',
    '    at run (src/scan/scan.ts:88:13)',
    '    at src/index.ts:5:1',
  ].join('\n');
  const citations = findCitations(stack);
  assert.deepEqual(
    citations.map((entry) => entry.file),
    ['src/scan/scan.ts', 'src/index.ts'],
  );
  assert.equal(citations[0]?.line, 88);
  assert.equal(citations[1]?.col, 1);
});

test('dedupes by file:line:col while preserving first-seen order', () => {
  const citations = findCitations('a.ts:1:1 b.ts:2:2 a.ts:1:1 a.ts:1:1');
  assert.deepEqual(
    citations.map((entry) => `${entry.file}:${entry.line}:${entry.col}`),
    ['a.ts:1:1', 'b.ts:2:2'],
  );
});

test('drops URLs and node_modules noise', () => {
  const citations = findCitations(
    [
      'see https://example.com/app.ts:10 for details',
      'also node_modules/dep/index.js:4:2 could be the culprit',
      'and vendor/pkg/file.go:7',
      'but src/real.ts:9 is ours',
    ].join('\n'),
  );
  assert.deepEqual(
    citations.map((entry) => entry.file),
    ['src/real.ts'],
  );
});

test('resolves raw against the supplied root but returns the matched file as-is', () => {
  const root = path.join(path.sep, 'repo', 'app');
  const [citation] = findCitations('src/app.ts:12', { root });
  assert.equal(citation?.file, 'src/app.ts');
  assert.equal(citation?.raw, path.resolve(root, 'src', 'app.ts'));
});

test('caps results at 200 in first-seen order', () => {
  const lines = Array.from({ length: 260 }, (_value, index) => `src/f${index}.ts:${index + 1}`);
  const citations = findCitations(lines.join('\n'));
  assert.equal(citations.length, 200);
  assert.equal(citations[0]?.file, 'src/f0.ts');
  assert.equal(citations[199]?.file, 'src/f199.ts');
});

test('ignores timestamps and bare numbers', () => {
  assert.deepEqual(findCitations('12:30:45 started, 100:200 elapsed'), []);
});

test('linkifyCitations splits text and attaches citations in order', () => {
  const segments = linkifyCitations('open src/app.ts:3:1 now');
  assert.deepEqual(segments, [
    { text: 'open ' },
    { text: 'src/app.ts:3:1', citation: { file: 'src/app.ts', line: 3, col: 1, raw: path.normalize('src/app.ts') } },
    { text: ' now' },
  ]);
  assert.deepEqual(linkifyCitations('nothing here'), [{ text: 'nothing here' }]);
});
