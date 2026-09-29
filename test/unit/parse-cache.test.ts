import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PARSE_CACHE_VERSION,
  clearParseCache,
  parseCacheKey,
  parseCacheStats,
  withParseCache,
} from '../../src/scan/parse-cache.ts';

test('withParseCache runs produce once per content and serves the second call from cache (P5)', async () => {
  clearParseCache();
  let calls = 0;
  const produce = async () => {
    calls += 1;
    return { edges: calls };
  };

  const first = await withParseCache(parseCacheKey('python', 'x = 1'), produce);
  const second = await withParseCache(parseCacheKey('python', 'x = 1'), produce);
  assert.equal(calls, 1, 'the extractor runs once for identical content');
  assert.equal(first, second, 'the cached value is returned, not rebuilt');
  assert.deepEqual(parseCacheStats(), { size: 1, hits: 1, misses: 1 });
});

test('a changed content is a different key, and the language is part of it (P5)', async () => {
  clearParseCache();
  let calls = 0;
  const produce = async () => {
    calls += 1;
    return calls;
  };
  await withParseCache(parseCacheKey('python', 'a = 1'), produce);
  await withParseCache(parseCacheKey('python', 'a = 2'), produce);
  await withParseCache(parseCacheKey('rust', 'a = 1'), produce);
  assert.equal(calls, 3, 'a changed byte or a different language is a fresh extraction');
  assert.match(parseCacheKey('python', 'a = 1'), new RegExp(`^${PARSE_CACHE_VERSION}:python:`));
});

test('the version is part of the key, so a grammar bump invalidates every entry (P5)', () => {
  const key = parseCacheKey('java', 'class A {}');
  assert.match(key, new RegExp(`^${PARSE_CACHE_VERSION}:java:[0-9a-f]{64}$`));
});

test('clearParseCache resets the store and its counters (P5)', async () => {
  clearParseCache();
  await withParseCache(parseCacheKey('cpp', 'int main() {}'), () => 1);
  assert.equal(parseCacheStats().size, 1);
  clearParseCache();
  assert.deepEqual(parseCacheStats(), { size: 0, hits: 0, misses: 0 });
});
