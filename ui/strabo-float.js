/**
 * Floating, draggable, resizable, collapsible windows for Strabo's auxiliary panels.
 *
 * Panels keep their own ids and `hidden` semantics: the controller still toggles
 * `element.hidden`, and each window mirrors it through a MutationObserver. Position,
 * size, and collapsed state are remembered per panel in localStorage so a layout
 * survives reloads. Each window is mirrored by a chip in the dock, which restores a
 * closed or collapsed one.
 *
 * The logic lives in focused modules; this file keeps `initFloatingWindows` (which wires
 * the windows to the dock and persistence) and re-exports the public helpers so existing
 * importers and the unit tests keep a single entry point. New code should import from the
 * module that owns the concern.
 */

import { createDockRail } from './strabo-float-dock.js';
import { createFloatingWindow } from './strabo-float-window.js';
import { readStore, writeStore } from './strabo-float-store.js';
import { clamp, DEFAULT_WIDTH, HEADER_HEIGHT, MIN_HEIGHT, GAP, topFloor } from './strabo-float-geometry.js';
import { appBottom, appDockLeft, appHeaderBottom } from './strabo-float-placement.js';

export * from './strabo-float-geometry.js';

/**
 * Create one floating window per config and wire a dock chip to each.
 *
 * A config names the panel `element`, a `title`, and optional `position`, `width`,
 * `height`, `center`, `dockLabel`, `glyph`, `pinned`, `dock`, `titleFrom`, `canOpen`,
 * `blockedTitle`, `onOpen`, `onClose`, and `onBlocked`.
 * The dock is a vertical rail: `pinned` panels (a number orders them) always have a chip there, an open unpinned
 * panel joins them while it is open, and the rest sit in the rail's "More" list. `dock:
 * false` gives a panel no chip at all, for panels the header or a screen already opens.
 * `onClose` should run the app's own teardown so the panel state stays consistent; when
 * omitted the element is simply hidden. When `canOpen()` is false the dock chip is
 * disabled with `blockedTitle` as its tooltip, and `onBlocked` runs if open is
 * attempted programmatically. Call the returned `controllers.refresh()` after app
 * state (selection, overlay, …) changes so disabled chips stay in sync.
 */
export function initFloatingWindows({ dock, panels = [] } = {}) {
  const store = readStore();
  const controllers = [];
  let topZ = 60;

  const nextZ = () => {
    topZ += 1;
    return topZ;
  };

  const persist = () => {
    const next = {};
    for (const controller of controllers) {
      next[controller.key] = controller.snapshot();
    }
    writeStore(next);
  };

  const dockRail = createDockRail({ dock, controllers });

  for (const config of panels) {
    if (!config.element) continue;
    const saved = store[config.key] ?? {};
    // The factory registers its controller before its first sync, so the dock sees it.
    createFloatingWindow({ config, saved, controllers, dockRail, nextZ, persist });
  }

  /**
   * Pull every open window back on screen and below the app header. Runs when the viewport
   * resizes and when the header changes height: it wraps to a second row when its controls
   * do not fit, which can happen after the windows were placed (a repository chip arriving).
   */
  const keepOnScreen = () => {
    const floor = topFloor(appHeaderBottom());
    // The dock rail and status bar stack above the floating layer, so the usable canvas
    // stops where they begin. A window under them loses its header controls and, worse,
    // its bottom-right resize grip.
    const right = Math.max(0, appDockLeft() - GAP);
    const bottom = Math.max(floor, appBottom() - GAP);
    for (const controller of controllers) {
      const win = controller.window;
      // A hidden window has no position yet; it takes a rail slot when it opens.
      if (win.hidden) continue;
      // Keep the header on screen first, then size the body to what is left. The inline
      // max-height was computed from the viewport at open time and, being inline, overrides
      // the stylesheet's `calc(100vh - 116px)`: left stale it lets a shrunk viewport keep
      // the old, taller cap, so the panel hangs off the bottom with its controls unreachable.
      const width = Math.min(win.offsetWidth || DEFAULT_WIDTH, Math.max(right, 0));
      const height = Math.min(win.offsetHeight || HEADER_HEIGHT, Math.max(bottom - floor, HEADER_HEIGHT));
      const left = parseFloat(win.style.left) || 0;
      const top = clamp(parseFloat(win.style.top) || 0, floor, Math.max(floor, bottom - height));
      // Shrink a window that is wider than the canvas (moved in from a larger viewport) so
      // its grip stays on this side of the rail; the max-height below does the same for the
      // status bar.
      if (win.offsetWidth > right) win.style.width = `${Math.max(MIN_WIDTH, right)}px`;
      win.style.left = `${clamp(left, 0, Math.max(0, right - width))}px`;
      win.style.top = `${top}px`;
      win.style.maxHeight = `${Math.max(MIN_HEIGHT, bottom - top)}px`;
    }
  };

  window.addEventListener('resize', keepOnScreen);
  if (typeof ResizeObserver === 'function') {
    // The status bar and the dock rail both size themselves after the first render (the
    // status text arrives late), which moves the edges the windows must clear. Follow them
    // so an open window re-fits instead of keeping a cap measured against the empty shell.
    const chromeObserver = new ResizeObserver(keepOnScreen);
    const header = document.querySelector('header.toolbar');
    if (header) chromeObserver.observe(header);
    const bottomBar = document.getElementById('bottom-bar');
    if (bottomBar) chromeObserver.observe(bottomBar);
    const dockRailElement = document.getElementById('float-dock');
    if (dockRailElement) chromeObserver.observe(dockRailElement);
  }

  dockRail.render();
  // The array doubles as a handle: callers refresh disabled/active chips after
  // selection, overlay, or member-map state changes (which don't touch `hidden`).
  controllers.refresh = dockRail.render;
  return controllers;
}
