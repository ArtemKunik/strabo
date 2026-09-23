import assert from 'node:assert/strict';
import { test } from 'node:test';

import { firstFreeSlotTop, sanitizeSize } from '../../ui/strabo-float.js';
import { clampMenuLeft, clampToolbarPosition } from '../../ui/strabo-float-toolbar.js';

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

test('firstFreeSlotTop returns the start when the rail is empty', () => {
  assert.equal(firstFreeSlotTop([], 300, { startTop: 96 }), 96);
});

test('firstFreeSlotTop stacks below an occupied slot instead of overlapping it', () => {
  assert.equal(firstFreeSlotTop([{ top: 96, bottom: 356 }], 260, { startTop: 96, gap: 12 }), 368);
});

test('firstFreeSlotTop takes the first gap that fits between occupied slots', () => {
  // A small window fits in the 60px gap before the first box, not just below both.
  const occupied = [
    { top: 300, bottom: 500 },
    { top: 600, bottom: 800 },
  ];
  assert.equal(firstFreeSlotTop(occupied, 40, { startTop: 96, gap: 0 }), 96);
  assert.equal(firstFreeSlotTop(occupied, 260, { startTop: 96, gap: 12 }), 812);
});

test('firstFreeSlotTop resumes below the tallest overlapping run', () => {
  const occupied = [
    { top: 96, bottom: 356 },
    { top: 100, bottom: 500 },
  ];
  assert.equal(firstFreeSlotTop(occupied, 100, { startTop: 96, gap: 12 }), 512);
});

test('clampToolbarPosition keeps a floating toolbar inside its container', () => {
  assert.deepEqual(
    clampToolbarPosition(500, 400, { width: 300, height: 40, boundWidth: 800, boundHeight: 500 }),
    { left: 500, top: 400 },
  );
  assert.deepEqual(
    clampToolbarPosition(700, 490, { width: 300, height: 40, boundWidth: 800, boundHeight: 500 }),
    { left: 500, top: 460 },
  );
  assert.deepEqual(
    clampToolbarPosition(-40, -10, { width: 300, height: 40, boundWidth: 800, boundHeight: 500 }),
    { left: 0, top: 0 },
  );
});

test('clampToolbarPosition pins to the origin when the bar is larger than the container', () => {
  assert.deepEqual(
    clampToolbarPosition(50, 50, { width: 900, height: 700, boundWidth: 800, boundHeight: 500 }),
    { left: 0, top: 0 },
  );
});

test('clampMenuLeft keeps the overflow menu inside the viewport', () => {
  // Room to spare: the menu stays right-aligned to its trigger.
  assert.equal(clampMenuLeft(600, 190, 800), 410);
  // Near the left edge: the menu is pushed right, keeping the margin.
  assert.equal(clampMenuLeft(120, 260, 445), 4);
  // Near the right edge: the menu is pulled back inside.
  assert.equal(clampMenuLeft(800, 190, 800), 606);
});

test('clampMenuLeft pins to the margin when the menu is wider than the viewport', () => {
  assert.equal(clampMenuLeft(200, 900, 445), 4);
});
