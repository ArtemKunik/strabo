import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ISLAND_LAYOUT_PREFIX,
  islandLayoutKey,
  readIslandLayout,
  writeIslandLayout,
} from '../../ui/strabo-island-layout.js';

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = String(value);
    },
    removeItem: (key) => {
      delete data[key];
    },
    _data: data,
  };
}

test('the layout key names the repository, falling back to a default bucket', () => {
  assert.equal(islandLayoutKey('D:/repo'), `${ISLAND_LAYOUT_PREFIX}D:/repo`);
  assert.equal(islandLayoutKey(null), `${ISLAND_LAYOUT_PREFIX}default`);
});

test('readIslandLayout returns an empty map when nothing is stored or the value is corrupt', () => {
  assert.deepEqual(readIslandLayout('D:/repo', fakeStorage()), {});
  assert.deepEqual(readIslandLayout('D:/repo', fakeStorage({ [islandLayoutKey('D:/repo')]: '{not json' })), {});
  assert.deepEqual(readIslandLayout('D:/repo', undefined), {});
});

test('writeIslandLayout round-trips a sanitized set of moves', () => {
  const storage = fakeStorage();
  const written = writeIslandLayout('D:/repo', { src: { dx: 96, dy: -48 }, bad: { dx: 'x' } }, storage);
  assert.deepEqual(written, { src: { dx: 96, dy: -48 } });
  assert.deepEqual(readIslandLayout('D:/repo', storage), { src: { dx: 96, dy: -48 } });
});

test('writeIslandLayout removes the key when nothing is left moved', () => {
  const storage = fakeStorage({ [islandLayoutKey('D:/repo')]: JSON.stringify({ src: { dx: 1, dy: 1 } }) });
  writeIslandLayout('D:/repo', {}, storage);
  assert.equal(storage._data[islandLayoutKey('D:/repo')], undefined);
  assert.deepEqual(readIslandLayout('D:/repo', storage), {});
});

test('a repository only sees its own moves', () => {
  const storage = fakeStorage();
  writeIslandLayout('D:/one', { src: { dx: 10, dy: 0 } }, storage);
  assert.deepEqual(readIslandLayout('D:/two', storage), {});
});
