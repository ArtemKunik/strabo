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

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
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
