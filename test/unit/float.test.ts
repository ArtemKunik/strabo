import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clearOfAbove,
  firstFreeSlotTop,
  followRightEdge,
  keptTop,
  MIN_HEIGHT,
  railTopBelow,
  RAIL_TOP,
  resizeLimits,
  sanitizeSize,
  topFloor,
} from '../../ui/strabo-float-geometry.js';
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

test('resizeLimits stops the bottom-right grip at the dock rail and status bar', () => {
  // A 720-wide window at (484, 65) on a 1280x800 canvas whose usable area ends at the
  // dock rail (x 1216) and the status bar (y 769): the grip keeps a GAP clear of both.
  assert.deepEqual(
    resizeLimits({ left: 484, top: 65, right: 1216, bottom: 769 }),
    { maxWidth: 720, maxHeight: 692 },
  );
});

test('resizeLimits never shrinks a window below its minimum size', () => {
  // A window already at the far edge has no room to grow, but the grip still resizes it
  // back up to the minimum rather than to a negative box.
  assert.deepEqual(
    resizeLimits({ left: 1200, top: 780, right: 1216, bottom: 769 }),
    { maxWidth: 240, maxHeight: 160 },
  );
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

test('railTopBelow keeps the default rail top under a one-row header', () => {
  assert.equal(railTopBelow(52), RAIL_TOP);
  assert.equal(railTopBelow(0), RAIL_TOP);
});

test('railTopBelow opens the rail below a header that wrapped to two rows', () => {
  // The header sits above the panel layer, so a window under it has an unreachable title bar.
  assert.equal(railTopBelow(86), 98);
  assert.equal(railTopBelow(85.4), 98);
});

test('topFloor keeps a dragged window title bar below the header', () => {
  assert.equal(topFloor(86), 86);
  assert.equal(topFloor(85.2), 86);
  assert.equal(topFloor(undefined), 0);
  assert.equal(topFloor(NaN), 0);
});

test('followRightEdge carries a right-docked window back to the side when the canvas widens', () => {
  // Flush against the edge at 1000, then the edge moves to 1500: the window follows it.
  assert.equal(followRightEdge({ left: 600, width: 400, previousRight: 1000, right: 1500 }), 1100);
  // A small gap to the edge is kept, not closed.
  assert.equal(followRightEdge({ left: 590, width: 400, previousRight: 1000, right: 1500 }), 1090);
});

test('followRightEdge leaves a window placed mid-canvas where it is', () => {
  assert.equal(followRightEdge({ left: 200, width: 400, previousRight: 1000, right: 1500 }), 200);
  // With no earlier edge to compare against, nothing counts as docked.
  assert.equal(followRightEdge({ left: 600, width: 400, previousRight: null, right: 1500 }), 600);
});

test('followRightEdge still clamps a window on screen when the canvas narrows', () => {
  assert.equal(followRightEdge({ left: 200, width: 400, previousRight: 1000, right: 500 }), 100);
  assert.equal(followRightEdge({ left: 600, width: 400, previousRight: 1000, right: 700 }), 300);
});

test('keptTop shortens a window before sliding it up over the one above', () => {
  // A 600-tall window at 330 in a viewport now ending at 750: it keeps its top and shrinks.
  assert.equal(keptTop({ top: 330, height: 600, floor: 52, bottom: 750 }), 330);
  // Only when less than MIN_HEIGHT would remain does it rise.
  assert.equal(keptTop({ top: 700, height: 600, floor: 52, bottom: 750 }), 750 - MIN_HEIGHT);
  assert.equal(keptTop({ top: 20, height: 100, floor: 52, bottom: 750 }), 52);
});

test('clearOfAbove moves a window down off the one above it in the same column', () => {
  const above = [{ left: 584, right: 924, top: 93, bottom: 344 }];
  assert.equal(clearOfAbove({ top: 328, left: 464, width: 460, above, bottom: 757 }), 356);
  // A window in another column is left alone.
  assert.equal(clearOfAbove({ top: 328, left: 40, width: 300, above, bottom: 757 }), 328);
  // So is one that would be left shorter than MIN_HEIGHT.
  assert.equal(clearOfAbove({ top: 328, left: 464, width: 460, above, bottom: 400 }), 328);
});

test('clampToolbarPosition keeps a margin from the edges when asked to', () => {
  const box = { width: 300, height: 40, boundWidth: 800, boundHeight: 500, margin: 8 };
  assert.deepEqual(clampToolbarPosition(-40, -10, box), { left: 8, top: 8 });
  assert.deepEqual(clampToolbarPosition(900, 900, box), { left: 492, top: 452 });
  // A bar too wide for the margin still pins on screen rather than going negative.
  assert.deepEqual(
    clampToolbarPosition(50, 50, { ...box, width: 795, boundWidth: 800 }),
    { left: 5, top: 50 },
  );
});
