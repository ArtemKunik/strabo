/**
 * Pure geometry and sizing for Strabo's floating windows: the layout constants, the clamp
 * used by drag and resize, the saved-size sanitiser, and the rail slot finder.
 *
 * Pure functions only: no DOM, no storage, no fetch, so the placement rules stay testable
 * from Node.
 */

/**
 * Right-hand rail defaults: windows open here unless a config positions them. The panel
 * rail (the dock) is a column on the graph's right edge, so windows open just left of it.
 */
export const DOCK_RAIL_WIDTH = 64;
export const GAP = 12;
export const DEFAULT_WIDTH = 384;
export const HEADER_HEIGHT = 34;
export const MIN_WIDTH = 240;
export const MIN_HEIGHT = 160;

export const RAIL_RIGHT = DOCK_RAIL_WIDTH + GAP;
export const RAIL_TOP = 64;

/**
 * The highest a window's top may sit: the header's bottom edge. The header stacks above the
 * floating-panel layer and wraps to a second row when its controls do not fit, so a window
 * above this line has its title bar (the drag handle) hidden and unreachable.
 */
export function topFloor(headerBottom) {
  return Number.isFinite(headerBottom) && headerBottom > 0 ? Math.ceil(headerBottom) : 0;
}

/** Where the rail starts: `RAIL_TOP` under a one-row header, one gap below a taller one. */
export function railTopBelow(headerBottom) {
  return Math.max(RAIL_TOP, topFloor(headerBottom) + GAP);
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * The largest size a window may be resized to, given the usable edges of the canvas.
 *
 * `right` and `bottom` are where the app chrome that stacks above the floating layer
 * begins: the dock rail's left edge and the status bar's top edge. The bottom-right grip
 * is the window's only resize affordance, so a window allowed to grow under that chrome
 * can never be grabbed again — not to grow and not to shrink.
 */
export function resizeLimits({ left, top, right, bottom, gap = GAP }) {
  return {
    maxWidth: Math.max(MIN_WIDTH, right - left - gap),
    maxHeight: Math.max(MIN_HEIGHT, bottom - top - gap),
  };
}

/**
 * The saved size of a window, or null per axis when it is not a usable box.
 *
 * A hidden (`display: none`) or collapsed window has no real rect, and earlier builds
 * persisted that 0-wide / header-tall box. Reading it back gave a hairline window, so
 * anything non-finite or below the resize minimum is ignored and the default applies.
 */
export function sanitizeSize(size) {
  const width = Number(size?.width);
  const height = Number(size?.height);
  return {
    width: Number.isFinite(width) && width >= MIN_WIDTH ? width : null,
    height: Number.isFinite(height) && height >= MIN_HEIGHT ? height : null,
  };
}

/**
 * The first top at or below `startTop` where a `height`-tall box clears every occupied box.
 *
 * Occupied boxes are the open windows in the rail; a new window takes the highest gap that
 * fits, so panels open beside each other instead of on the same fixed point. Boxes are
 * half-open intervals: a box ending exactly where the next starts does not overlap.
 */
export function firstFreeSlotTop(occupied, height, { startTop = RAIL_TOP, gap = GAP } = {}) {
  const sorted = [...occupied].sort((a, b) => a.top - b.top);
  let candidate = startTop;
  for (const rect of sorted) {
    if (candidate + height <= rect.top) {
      break;
    }
    candidate = Math.max(candidate, rect.bottom + gap);
  }
  return candidate;
}

/** How close to the canvas's right edge a window must sit to count as docked there. */
export const RIGHT_ANCHOR_SNAP = 24;

/**
 * The left a window takes when the canvas's right edge moves from `previousRight` to `right`.
 *
 * A window that sat against the right edge (a rail slot, or one dragged there) keeps its gap
 * to it, so widening the viewport carries it back to the side instead of leaving it adrift
 * mid-canvas over the map; any other window keeps its left. The result is clamped on screen.
 */
export function followRightEdge({ left, width, previousRight, right }) {
  const gap = Number.isFinite(previousRight) ? previousRight - (left + width) : Infinity;
  const next = gap >= -1 && gap <= RIGHT_ANCHOR_SNAP ? right - width - Math.max(0, gap) : left;
  return clamp(next, 0, Math.max(0, right - width));
}

/**
 * The top a window keeps when the usable area shrinks to `floor`..`bottom`.
 *
 * The window shortens before it moves: it rises only when less than `MIN_HEIGHT` would be
 * left below its top, so a shorter viewport does not slide the lower rail window up over
 * the one above it.
 */
export function keptTop({ top, height, floor, bottom }) {
  return clamp(top, floor, Math.max(floor, bottom - Math.min(height, MIN_HEIGHT)));
}

/**
 * Push `top` below any box in `above` that shares the window's column and starts above it.
 *
 * Re-fitting can move an upper window down (the header wrapping to two rows raises the
 * floor), and the window below it must not stay underneath. The nudge is skipped when it
 * would leave less than `MIN_HEIGHT` above `bottom`; an overlap beats an unusable sliver.
 */
export function clearOfAbove({ top, left, width, above, bottom, gap = GAP }) {
  let next = top;
  for (const box of [...above].sort((a, b) => a.top - b.top)) {
    const sharesColumn = box.left < left + width && left < box.right;
    if (sharesColumn && box.top <= next && next < box.bottom + gap) {
      next = box.bottom + gap;
    }
  }
  return bottom - next >= MIN_HEIGHT ? next : top;
}
