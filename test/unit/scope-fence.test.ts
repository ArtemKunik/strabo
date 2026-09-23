import assert from 'node:assert/strict';
import { test } from 'node:test';

import { globToRegExp, matchesGlob } from '../../src/analysis/glob.ts';
import { computeScopeFence } from '../../src/analysis/scope-fence.ts';

test('a change outside the zone is listed in outside with its sorted importers', () => {
  const fence = computeScopeFence({
    changed: [{ path: 'lib/a.ts' }],
    expected: ['src/**'],
    importers: new Map([['lib/a.ts', ['src/user.ts', 'app/main.ts', 'src/user.ts']]]),
  });

  assert.equal(fence.available, true);
  assert.equal(fence.inside, 0);
  assert.equal(fence.total, 1);
  assert.deepEqual(
    fence.outside.map((entry) => entry.path),
    ['lib/a.ts'],
  );
  assert.deepEqual(fence.outside[0]?.importers, ['app/main.ts', 'src/user.ts']);
  assert.deepEqual(fence.crossing, []);
});

test('an inside change with an outside importer crosses the fence, an inside-only one does not', () => {
  const fence = computeScopeFence({
    changed: [{ path: 'src/leaf.ts' }, { path: 'src/api.ts' }],
    expected: ['src/**'],
    importers: new Map([
      ['src/api.ts', ['lib/consumer.ts', 'src/other.ts']],
      ['src/leaf.ts', ['src/internal.ts']],
    ]),
  });

  assert.equal(fence.inside, 2);
  assert.equal(fence.total, 2);
  assert.deepEqual(fence.outside, []);
  assert.deepEqual(
    fence.crossing.map((entry) => entry.path),
    ['src/api.ts'],
  );
  // Only the importer outside the zone is kept on the crossing entry.
  assert.deepEqual(fence.crossing[0]?.importers, ['lib/consumer.ts']);
});

test('no expected zone makes the fence unavailable and says so', () => {
  const fence = computeScopeFence({
    changed: [{ path: 'src/a.ts' }],
    expected: [],
    importers: new Map(),
  });

  assert.equal(fence.available, false);
  assert.equal(fence.reason, 'no expected zone declared');
  assert.deepEqual(fence.expected, []);
  assert.equal(fence.inside, 0);
  assert.equal(fence.total, 1);
  assert.deepEqual(fence.outside, []);
  assert.deepEqual(fence.crossing, []);
});

test('a rename whose previous path is in the zone counts as inside', () => {
  const fence = computeScopeFence({
    changed: [{ path: 'lib/renamed.ts', previousPath: 'src/original.ts' }],
    expected: ['src/**'],
    importers: new Map([['lib/renamed.ts', ['src/other.ts']]]),
  });

  assert.equal(fence.inside, 1);
  assert.equal(fence.total, 1);
  assert.deepEqual(fence.outside, []);
  // The only importer is itself inside the zone, so nothing crosses.
  assert.deepEqual(fence.crossing, []);
});

test('glob patterns match directories, segments, and zero-depth prefixes', () => {
  assert.equal(matchesGlob('src/a.ts', 'src/**'), true);
  assert.equal(matchesGlob('src', 'src/**'), false);
  assert.equal(matchesGlob('lib/a.ts', 'src/**'), false);
  assert.equal(matchesGlob('a/test/b.ts', '**/test/**'), true);
  assert.equal(matchesGlob('test/b.ts', '**/test/**'), true);
  assert.equal(matchesGlob('a/b/c.ts', '**/test/**'), false);
});

test('globToRegExp anchors and escapes its input', () => {
  const pattern = globToRegExp('a.ts');
  assert.ok(pattern instanceof RegExp);
  assert.equal(pattern.test('a.ts'), true);
  // The dot is literal, not a wildcard, and the expression is anchored.
  assert.equal(pattern.test('ats'), false);
  assert.equal(pattern.test('src/a.ts'), false);

  assert.equal(matchesGlob('a+b.ts', 'a+b.ts'), true);
  assert.equal(matchesGlob('axb.ts', 'a+b.ts'), false);
  assert.equal(matchesGlob('file(1).ts', 'file(1).ts'), true);
});

test('glob wildcards respect segment boundaries', () => {
  assert.equal(matchesGlob('src/a.ts', 'src/*.ts'), true);
  assert.equal(matchesGlob('src/nested/a.ts', 'src/*.ts'), false);
  assert.equal(matchesGlob('a.ts', '?.ts'), true);
  assert.equal(matchesGlob('ab.ts', '?.ts'), false);
  assert.equal(matchesGlob('a/b.ts', '?.b.ts'), false);
  assert.equal(matchesGlob('a/b/c', '**'), true);
  assert.equal(matchesGlob('a/c', 'a/**/c'), true);
  assert.equal(matchesGlob('a/b/c', 'a/**/c'), true);
});

test('backslashes are normalised to forward slashes in both file and glob', () => {
  assert.equal(matchesGlob('src\\a.ts', 'src/**'), true);
  assert.equal(matchesGlob('src/a.ts', 'src\\**'), true);
});
