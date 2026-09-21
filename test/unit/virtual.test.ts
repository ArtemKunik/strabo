import assert from 'node:assert/strict';
import { test } from 'node:test';

import { virtualRange } from '../../ui/strabo-virtual.js';

test('virtualRange renders the visible rows plus overscan on each side', () => {
  assert.deepEqual(virtualRange(0, 100, 20, 1000, 4), { start: 0, end: 9 });
  assert.deepEqual(virtualRange(200, 100, 20, 1000, 4), { start: 6, end: 19 });
});

test('virtualRange clamps at the first and last row', () => {
  assert.deepEqual(virtualRange(0, 100, 20, 3, 4), { start: 0, end: 3 });
  assert.deepEqual(virtualRange(99999, 100, 20, 40, 4), { start: 35, end: 40 });
});

test('virtualRange still covers the overscan when the viewport has no height', () => {
  assert.deepEqual(virtualRange(0, 0, 20, 100, 4), { start: 0, end: 4 });
  assert.deepEqual(virtualRange(400, 0, 20, 100, 4), { start: 16, end: 24 });
});

test('virtualRange tolerates a zero overscan and a negative scroll', () => {
  assert.deepEqual(virtualRange(100, 100, 20, 100, 0), { start: 5, end: 10 });
  assert.deepEqual(virtualRange(-50, 100, 20, 100, 4), { start: 0, end: 9 });
});

test('virtualRange is empty for an empty list or a bad row height', () => {
  assert.deepEqual(virtualRange(0, 100, 20, 0, 4), { start: 0, end: 0 });
  assert.deepEqual(virtualRange(0, 100, 0, 10, 4), { start: 0, end: 0 });
  assert.deepEqual(virtualRange(0, 100, -5, 10, 4), { start: 0, end: 0 });
  assert.deepEqual(virtualRange(0, 100, Number.NaN, 10, 4), { start: 0, end: 0 });
});

test('virtualRange defaults the overscan to four rows', () => {
  assert.deepEqual(virtualRange(200, 100, 20, 1000), { start: 6, end: 19 });
});
