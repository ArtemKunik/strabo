/**
 * Places one floating window: its initial spot (config `center`, `position`, or the saved
 * one), the first free slot in the right-hand rail, and the on-screen clamp that drag and
 * resize reuse.
 *
 * Needs only the window element and the live controller list, so it stays free of the
 * controller API.
 */

import {
  clamp,
  firstFreeSlotTop,
  HEADER_HEIGHT,
  MIN_HEIGHT,
  GAP,
  RAIL_RIGHT,
  RAIL_TOP,
} from './strabo-float-geometry.js';

export function createPlacement({ win, controllers, width, fallbackHeight, config, saved }) {
  /** Whether `win` has a position worth persisting; an unplaced window gets a rail slot. */
  let hasPosition = false;

  const place = (x, y) => {
    win.style.left = `${clamp(x, 0, Math.max(0, window.innerWidth - 60))}px`;
    win.style.top = `${clamp(y, 0, Math.max(0, window.innerHeight - HEADER_HEIGHT - 4))}px`;
    hasPosition = true;
  };

  /** The first y in the rail where this window does not overlap an open one. */
  const firstFreeRailTop = () => {
    const height = win.offsetHeight || fallbackHeight;
    const occupied = [];
    for (const other of controllers) {
      if (other.window === win || other.window.hidden || other.isCollapsed()) {
        continue;
      }
      const rect = other.window.getBoundingClientRect();
      if (rect.height > 0) {
        occupied.push(rect);
      }
    }
    occupied.sort((a, b) => a.top - b.top);
    return firstFreeSlotTop(occupied, height);
  };

  const placeInRail = () => {
    const railWidth = win.offsetWidth || width;
    const height = win.offsetHeight || fallbackHeight;
    const top = firstFreeRailTop();
    // When the rail is full and the next slot would fall past the bottom edge, reuse the
    // top slot instead: the window just opened is raised, so it is usable on top rather
    // than opening off-screen with its controls unreachable.
    const placedTop = top + height <= window.innerHeight ? top : RAIL_TOP;
    // Keep the window on screen: a tall panel opened below another (e.g. Settings below
    // the Legend) would otherwise run past the bottom edge. The body scrolls within
    // whatever height is left.
    const available = Math.max(MIN_HEIGHT, window.innerHeight - placedTop - GAP);
    win.style.maxHeight = `${available}px`;
    place(window.innerWidth - railWidth - RAIL_RIGHT, placedTop);
  };

  // Panels used to share one anchor and stack exactly on top of each other. A window now
  // opens in the first free slot of a right-hand rail, unless a config positions it.
  const position = saved.position ?? config.position ?? {};
  if (config.center) {
    place(
      (window.innerWidth - width) / 2,
      Math.max(56, (window.innerHeight - fallbackHeight) / 2),
    );
  } else if (Object.keys(position).length > 0) {
    const left = typeof position.left === 'number'
      ? position.left
      : window.innerWidth - width - (typeof position.right === 'number' ? position.right : RAIL_RIGHT);
    const top = typeof position.top === 'number'
      ? position.top
      : window.innerHeight - fallbackHeight - (typeof position.bottom === 'number' ? position.bottom : 0);
    place(left, top);
  }

  return { place, placeInRail, hasPosition: () => hasPosition };
}
