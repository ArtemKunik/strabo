import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sanitizeSize } from '../../ui/strabo-float.js';

test('sanitizeSize keeps a size the user could have resized to', () => {
  assert.deepEqual(sanitizeSize({ width: 420, height: 300 }), { width: 420, height: 300 });
});

test('sanitizeSize drops the 0x0 box a hidden panel used to persist, so it reopens at its default', () => {
  assert.deepEqual(sanitizeSize({ width: 0, height: 0 }), { width: null, height: null });
});

test('sanitizeSize drops a collapsed header-height box but keeps a valid width', () => {
  assert.deepEqual(sanitizeSize({ width: 420, height: 34 }), { width: 420, height: null });
});

test('sanitizeSize tolerates missing, null, and non-numeric values', () => {
  const none = { width: null, height: null };
  assert.deepEqual(sanitizeSize(undefined), none);
  assert.deepEqual(sanitizeSize(null), none);
  assert.deepEqual(sanitizeSize({}), none);
  assert.deepEqual(sanitizeSize({ width: 'wide', height: NaN }), none);
  assert.deepEqual(sanitizeSize({ width: Infinity, height: -5 }), none);
});
