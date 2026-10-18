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
  railTopBelow,
  topFloor,
} from './strabo-float-geometry.js';

/** The app header's bottom edge in viewport pixels; 0 when there is no header. */
export function appHeaderBottom() {
  return document.querySelector('header.toolbar')?.getBoundingClientRect().bottom ?? 0;
}

/**
 * The canvas's usable right edge: the dock rail's left edge.
 *
 * The rail stacks above the floating layer, so a window that crosses it loses its header
 * controls and its resize grip to the rail. The viewport edge is the fallback when the
 * rail is not on screen (the terminal and review screens hide it along with the windows).
 */
export function appDockLeft() {
  const dock = document.getElementById('float-dock');
  if (!dock) return window.innerWidth;
  const rect = dock.getBoundingClientRect();
  return rect.width > 0 ? rect.left : window.innerWidth;
}

/** The canvas's usable bottom edge: the status bar's top edge, which also stacks above windows. */
export function appBottom() {
  const bar = document.getElementById('bottom-bar');
  if (!bar) return window.innerHeight;
  const rect = bar.getBoundingClientRect();
  return rect.height > 0 ? rect.top : window.innerHeight;
}

export function createPlacement({ win, controllers, width, fallbackHeight, config, saved }) {
  /** Whether `win` has a position worth persisting; an unplaced window gets a rail slot. */
  let hasPosition = false;

  const place = (x, y) => {
    // Never above the app header: it stacks over the panels, so the title bar would be lost.
    // Never under the dock rail or the status bar either: both stack over the panels and
    // would swallow the header controls and the resize grip.
    const floor = topFloor(appHeaderBottom());
    const right = Math.max(0, appDockLeft() - GAP);
    const bottom = Math.max(floor, appBottom() - GAP);
    const boxWidth = win.offsetWidth || width;
    const top = clamp(y, floor, Math.max(floor, bottom - HEADER_HEIGHT));
    win.style.left = `${clamp(x, 0, Math.max(0, right - boxWidth))}px`;
    win.style.top = `${top}px`;
    // Cap the body to the space that is actually usable, so a saved size from a larger
    // viewport cannot run its footprint (and its grip) under the chrome below.
    win.style.maxHeight = `${Math.max(MIN_HEIGHT, bottom - top)}px`;
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
    return firstFreeSlotTop(occupied, height, { startTop: railTopBelow(appHeaderBottom()) });
  };

  const placeInRail = () => {
    const railWidth = win.offsetWidth || width;
    const height = win.offsetHeight || fallbackHeight;
    const top = firstFreeRailTop();
    const bottom = appBottom();
    // When the rail is full and the next slot would fall past the bottom edge, reuse the
    // top slot instead: the window just opened is raised, so it is usable on top rather
    // than opening off-screen with its controls unreachable.
    const placedTop = top + height <= bottom ? top : railTopBelow(appHeaderBottom());
    // `place` also caps the body to whatever height is left below the status bar.
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
