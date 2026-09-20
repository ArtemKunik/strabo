/**
 * Floating, draggable, resizable, collapsible windows for Strabo's auxiliary panels.
 *
 * Panels keep their own ids and `hidden` semantics: the controller still toggles
 * `element.hidden`, and each window mirrors it through a MutationObserver. Position,
 * size, and collapsed state are remembered per panel in localStorage so a layout
 * survives reloads. Each window is mirrored by a chip in the dock, which restores a
 * closed or collapsed one.
 */

const STORAGE_KEY = 'strabo.float.windows.v2';
const GAP = 12;
const DEFAULT_WIDTH = 384;
const HEADER_HEIGHT = 34;
const MIN_WIDTH = 240;
const MIN_HEIGHT = 160;

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
    dock.replaceChildren(...controllers.map((controller) => controller.dockButton()));
  };

  for (const config of panels) {
    const element = config.element;
    if (!element) continue;

    const saved = store[config.key] ?? {};
    const width = saved.size?.width ?? config.width ?? DEFAULT_WIDTH;

    const win = document.createElement('section');
    win.className = 'float-window';
    win.dataset.panel = config.key;
    win.hidden = true;
    win.style.width = `${width}px`;
    if (saved.size?.height) {
      win.style.height = `${saved.size.height}px`;
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

    // Panels sharing an anchor (all default to top-left) would stack exactly on top of one
    // another, so give each corner-docked panel its own edge; explicit positions override.
    const anchors = config.position ?? {};
    const hasLeft = typeof anchors.left === 'number';
    const hasRight = typeof anchors.right === 'number';
    if (!hasLeft && !hasRight) {
      if (['overlay', 'edge', 'timeline', 'inspector'].includes(config.key)) {
        anchors.right = GAP;
        anchors.top = 96;
      } else if (['legend', 'diagnostics'].includes(config.key)) {
        anchors.left = GAP;
        anchors.bottom = 56;
      }
    }

    const place = (x, y) => {
      win.style.left = `${clamp(x, 0, Math.max(0, window.innerWidth - 60))}px`;
      win.style.top = `${clamp(y, 0, Math.max(0, window.innerHeight - HEADER_HEIGHT - 4))}px`;
    };

    const position = saved.position ?? config.position ?? {};
    const fallbackHeight = config.height ?? 260;
    let left = typeof position.left === 'number' ? position.left : null;
    let top = typeof position.top === 'number' ? position.top : null;
    if (left === null && config.center) {
      left = (window.innerWidth - width) / 2;
    }
    if (left === null) {
      left = typeof position.right === 'number'
        ? window.innerWidth - width - position.right
        : GAP;
    }
    if (top === null && config.center) {
      top = Math.max(56, (window.innerHeight - fallbackHeight) / 2);
    }
    if (top === null) {
      top = typeof position.bottom === 'number'
        ? window.innerHeight - fallbackHeight - position.bottom
        : 96;
    }
    place(left, top);

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

    const sync = () => {
      const hidden = element.hidden === true;
      win.hidden = hidden;
      if (!hidden && config.titleFrom) {
        const heading = config.titleFrom(element);
        if (heading) title.textContent = heading;
      }
      if (hidden !== lastHidden) {
        lastHidden = hidden;
        renderDock();
      }
    };

    new MutationObserver(sync).observe(element, {
      attributes: true,
      attributeFilter: ['hidden'],
      childList: true,
      subtree: true,
      characterData: true,
    });

    const raise = () => {
      topZ += 1;
      win.style.zIndex = String(topZ);
    };

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
        raise();
        persist();
        return true;
      },
      close() {
        if (config.onClose) config.onClose();
        else element.hidden = true;
        win.hidden = true;
        lastHidden = true;
        renderDock();
        persist();
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
        const rect = win.getBoundingClientRect();
        return {
          position: {
            left: parseFloat(win.style.left) || 0,
            top: parseFloat(win.style.top) || 0,
          },
          size: { width: rect.width, height: rect.height },
          collapsed: isCollapsed(),
        };
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

    controllers.push(controller);
    sync();
  }

  window.addEventListener('resize', () => {
    for (const controller of controllers) {
      const win = controller.window;
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
