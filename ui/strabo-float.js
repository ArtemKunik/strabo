/**
 * Floating, draggable, resizable, collapsible windows for Strabo's auxiliary panels.
 *
 * Panels keep their own ids and `hidden` semantics: the controller still toggles
 * `element.hidden`, and each window mirrors it through a MutationObserver. Position,
 * size, and collapsed state are remembered per panel in localStorage so a layout
 * survives reloads. Each window is mirrored by a chip in the dock, which restores a
 * closed or collapsed one.
 */

import { rovingIndex } from './strabo-core.js';

const STORAGE_KEY = 'strabo.float.windows.v2';
const GAP = 12;
const DEFAULT_WIDTH = 384;
const HEADER_HEIGHT = 34;
const MIN_WIDTH = 240;
const MIN_HEIGHT = 160;

/** Right-hand rail defaults: windows open here unless a config positions them. */
const RAIL_RIGHT = GAP;
const RAIL_TOP = 96;

function readStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage is optional; a blocked/absent localStorage only costs persistence.
  }
}

function clamp(value, min, max) {
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

/**
 * Create one floating window per config and wire a dock chip to each.
 *
 * A config names the panel `element`, a `title`, and optional `position`, `width`,
 * `height`, `center`, `dockLabel`, `titleFrom`, `canOpen`, `blockedTitle`, `onOpen`,
 * `onClose`, and `onBlocked`.
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

  const persist = () => {
    const next = {};
    for (const controller of controllers) {
      next[controller.key] = controller.snapshot();
    }
    writeStore(next);
  };

  const renderDock = () => {
    if (!dock) return;
    const chips = controllers.map((controller) => controller.dockButton());
    dock.replaceChildren(...chips);
    // A toolbar is one tab stop: the first enabled chip is tabbable and the arrow keys
    // move focus between the rest.
    const enabled = chips.filter((chip) => !chip.disabled);
    enabled.forEach((chip, index) => {
      chip.tabIndex = index === 0 ? 0 : -1;
    });
  };

  /** Draw attention to the chip that just opened its window, so the panel is found. */
  const flashChip = (key) => {
    const chip = dock?.querySelector(`.dock-chip[data-panel="${key}"]`);
    if (!chip) return;
    chip.classList.remove('is-flash');
    // Reflow between remove and add so re-opening restarts the animation.
    void chip.offsetWidth;
    chip.classList.add('is-flash');
  };

  for (const config of panels) {
    const element = config.element;
    if (!element) continue;

    const saved = store[config.key] ?? {};
    // Only a size the user set by resizing is remembered; otherwise the config's default applies.
    let size = sanitizeSize(saved.size);
    const width = size.width ?? config.width ?? DEFAULT_WIDTH;

    const win = document.createElement('section');
    win.className = 'float-window';
    win.dataset.panel = config.key;
    win.hidden = true;
    win.style.width = `${width}px`;
    if (size.height) {
      win.style.height = `${size.height}px`;
    }

    const header = document.createElement('header');
    header.className = 'float-header';
    header.tabIndex = 0;
    header.title = 'Drag to move · double-click to collapse';

    const grip = document.createElement('span');
    grip.className = 'float-grip';
    grip.setAttribute('aria-hidden', 'true');
    grip.textContent = '⠿';

    const title = document.createElement('span');
    title.className = 'float-title';
    title.textContent = config.title ?? config.key;

    // A floating panel is a non-modal dialog: it can be focused, it names itself, and
    // Escape closes it. `tabIndex = -1` lets the window take focus on open without joining
    // the tab order (the dock chip remains the tab stop).
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-label', title.textContent);
    win.tabIndex = -1;

    const spacer = document.createElement('span');
    spacer.className = 'float-spacer';

    const collapseButton = document.createElement('button');
    collapseButton.type = 'button';
    collapseButton.className = 'float-button float-collapse';

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'float-button float-close';
    closeButton.setAttribute('aria-label', 'Close panel');
    closeButton.title = 'Close';
    closeButton.textContent = '×';

    const body = document.createElement('div');
    body.className = 'float-body';

    const resizeHandle = document.createElement('span');
    resizeHandle.className = 'float-resize';
    resizeHandle.setAttribute('aria-hidden', 'true');
    resizeHandle.title = 'Drag to resize';

    header.append(grip, title, spacer, collapseButton, closeButton);
    win.append(header, body, resizeHandle);

    element.parentNode.insertBefore(win, element);
    body.append(element);

    // Panels used to share one anchor and stack exactly on top of each other. A window now
    // opens in the first free slot of a right-hand rail, unless a config positions it.
    const fallbackHeight = config.height ?? 260;

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

    const isCollapsed = () => win.classList.contains('is-collapsed');

    const updateCollapseChrome = () => {
      const collapsed = isCollapsed();
      collapseButton.textContent = collapsed ? '+' : '–';
      collapseButton.title = collapsed ? 'Expand' : 'Collapse';
      collapseButton.setAttribute('aria-label', collapsed ? 'Expand panel' : 'Collapse panel');
    };

    const setCollapsed = (collapsed) => {
      win.classList.toggle('is-collapsed', collapsed);
      updateCollapseChrome();
      persist();
    };

    if (saved.collapsed ?? config.collapsed) win.classList.add('is-collapsed');
    updateCollapseChrome();

    let lastHidden = null;

    const raise = () => {
      topZ += 1;
      win.style.zIndex = String(topZ);
    };

    const sync = () => {
      const hidden = element.hidden === true;
      win.hidden = hidden;
      if (!hidden && config.titleFrom) {
        const heading = config.titleFrom(element);
        if (heading) {
          title.textContent = heading;
        }
      }
      win.setAttribute('aria-label', title.textContent);
      if (hidden !== lastHidden) {
        lastHidden = hidden;
        renderDock();
        if (!hidden) {
          // A panel can also be revealed by setting `element.hidden = false` directly (the
          // Repository passport opens that way on a first visit). It still earns its rail
          // slot and the top of the stack here, instead of sitting at the CSS default in the
          // corner over the toolbar with the previous panel on top of it.
          if (!hasPosition) placeInRail();
          raise();
          flashChip(config.key);
        }
      }
    };

    new MutationObserver(sync).observe(element, {
      attributes: true,
      attributeFilter: ['hidden'],
      childList: true,
      subtree: true,
      characterData: true,
    });

    const controller = {
      key: config.key,
      window: win,
      element,
      isOpen: () => !win.hidden,
      isCollapsed,
      open() {
        if (config.canOpen && !config.canOpen()) {
          config.onBlocked?.();
          return false;
        }
        config.onOpen?.();
        element.hidden = false;
        win.hidden = false;
        if (!hasPosition) {
          placeInRail();
        }
        sync();
        raise();
        persist();
        // Land the keyboard in the panel that was just opened, without scrolling the rail.
        win.focus({ preventScroll: true });
        return true;
      },
      close() {
        const hadFocus = win.contains(document.activeElement);
        if (config.onClose) config.onClose();
        else element.hidden = true;
        win.hidden = true;
        lastHidden = true;
        renderDock();
        persist();
        // Return focus to the chip that opened it, so closing does not drop the keyboard.
        if (hadFocus) {
          dock?.querySelector(`.dock-chip[data-panel="${config.key}"]`)?.focus();
        }
      },
      toggle() {
        if (win.hidden) {
          return this.open();
        } else if (isCollapsed()) {
          setCollapsed(false);
          raise();
          return true;
        } else {
          this.close();
          return true;
        }
      },
      snapshot() {
        const snapshot = {
          size: { ...size },
          collapsed: isCollapsed(),
        };
        // A window that has never opened keeps no position: it earns its rail slot at open,
        // so persisting the 0,0 default would pin it to the corner instead.
        if (hasPosition) {
          snapshot.position = {
            left: parseFloat(win.style.left) || 0,
            top: parseFloat(win.style.top) || 0,
          };
        }
        return snapshot;
      },
      dockButton() {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dock-chip';
        button.dataset.panel = config.key;
        const open = !win.hidden;
        const canOpen = !config.canOpen || config.canOpen();
        button.classList.toggle('active', open);
        button.classList.toggle('collapsed', open && isCollapsed());
        button.setAttribute('aria-pressed', String(open));
        button.textContent = config.dockLabel ?? config.title ?? config.key;
        if (!canOpen && !open) {
          button.disabled = true;
          const reason =
            typeof config.blockedTitle === 'function'
              ? config.blockedTitle()
              : (config.blockedTitle ?? `Open ${config.title ?? config.key} (unavailable)`);
          button.title = reason;
        } else {
          button.title = open ? `Close ${config.title ?? config.key}` : `Open ${config.title ?? config.key}`;
        }
        button.addEventListener('click', () => controller.toggle());
        return button;
      },
    };

    // Escape closes the focused window and stops there, so it does not also reach the
    // global handler that clears the map selection.
    win.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.stopPropagation();
        event.preventDefault();
        controller.close();
      }
    });

    header.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button') || event.button !== 0) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = parseFloat(win.style.left) || 0;
      const startTop = parseFloat(win.style.top) || 0;
      header.setPointerCapture(event.pointerId);
      const move = (moveEvent) => {
        place(
          startLeft + (moveEvent.clientX - startX),
          startTop + (moveEvent.clientY - startY),
        );
      };
      const end = () => {
        header.removeEventListener('pointermove', move);
        header.removeEventListener('pointerup', end);
        header.removeEventListener('pointercancel', end);
        persist();
      };
      header.addEventListener('pointermove', move);
      header.addEventListener('pointerup', end);
      header.addEventListener('pointercancel', end);
      raise();
      event.preventDefault();
    });

    resizeHandle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const rect = win.getBoundingClientRect();
      const startWidth = rect.width;
      const startHeight = rect.height;
      const left = parseFloat(win.style.left) || 0;
      const top = parseFloat(win.style.top) || 0;
      const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - left - GAP);
      const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - top - GAP);
      resizeHandle.setPointerCapture(event.pointerId);
      const move = (moveEvent) => {
        win.style.width = `${clamp(startWidth + (moveEvent.clientX - startX), MIN_WIDTH, maxWidth)}px`;
        win.style.height = `${clamp(startHeight + (moveEvent.clientY - startY), MIN_HEIGHT, maxHeight)}px`;
      };
      const end = () => {
        resizeHandle.removeEventListener('pointermove', move);
        resizeHandle.removeEventListener('pointerup', end);
        resizeHandle.removeEventListener('pointercancel', end);
        // A click without a drag leaves no inline height; keep what was remembered.
        const resized = sanitizeSize({
          width: parseFloat(win.style.width),
          height: parseFloat(win.style.height),
        });
        size = { width: resized.width ?? size.width, height: resized.height ?? size.height };
        persist();
      };
      resizeHandle.addEventListener('pointermove', move);
      resizeHandle.addEventListener('pointerup', end);
      resizeHandle.addEventListener('pointercancel', end);
      raise();
      event.preventDefault();
      event.stopPropagation();
    });

    header.addEventListener('dblclick', (event) => {
      if (event.target.closest('button')) return;
      setCollapsed(!isCollapsed());
    });

    collapseButton.addEventListener('click', (event) => {
      event.stopPropagation();
      setCollapsed(!isCollapsed());
    });

    closeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      controller.close();
    });

    win.addEventListener('pointerdown', raise, true);
    win.addEventListener('contextmenu', raise, true);

    // A panel that is visible on load (the legend) never goes through `open()`, so give it
    // its rail slot here too; otherwise it sits unpositioned over the toolbar.
    if (!hasPosition && element.hidden !== true) {
      placeInRail();
    }

    controllers.push(controller);
    sync();
  }

  // Arrow keys move focus between the dock chips (roving tabindex), Home/End jump to the
  // ends. The dock is a `role="toolbar"`, so this is the expected keyboard contract.
  dock?.addEventListener('keydown', (event) => {
    const chips = [...dock.querySelectorAll('.dock-chip')].filter((chip) => !chip.disabled);
    const next = rovingIndex(chips.indexOf(document.activeElement), chips.length, event.key);
    if (next === null) {
      return;
    }
    event.preventDefault();
    chips.forEach((chip, index) => {
      chip.tabIndex = index === next ? 0 : -1;
    });
    chips[next].focus();
  });

  window.addEventListener('resize', () => {
    for (const controller of controllers) {
      const win = controller.window;
      // A hidden window has no position yet; it takes a rail slot when it opens.
      if (win.hidden) continue;
      const left = parseFloat(win.style.left) || 0;
      const top = parseFloat(win.style.top) || 0;
      win.style.left = `${clamp(left, 0, Math.max(0, window.innerWidth - 60))}px`;
      win.style.top = `${clamp(top, 0, Math.max(0, window.innerHeight - HEADER_HEIGHT - 4))}px`;
    }
  });

  renderDock();
  // The array doubles as a handle: callers refresh disabled/active chips after
  // selection, overlay, or member-map state changes (which don't touch `hidden`).
  controllers.refresh = renderDock;
  return controllers;
}
