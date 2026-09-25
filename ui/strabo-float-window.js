/**
 * One floating window for a Strabo auxiliary panel: collapse state, the `hidden` mirror it
 * keeps in sync with the panel element, and the controller the app and dock call into.
 *
 * The chrome DOM is built by `strabo-float-chrome.js`, placement by
 * `strabo-float-placement.js`, and the drag/resize gestures by `strabo-float-gestures.js`.
 */

import { sanitizeSize, DEFAULT_WIDTH } from './strabo-float-geometry.js';
import { buildWindowChrome } from './strabo-float-chrome.js';
import { createPlacement } from './strabo-float-placement.js';
import { wireWindowGestures } from './strabo-float-gestures.js';

/**
 * Build the window for one config, insert it before the panel element, move the element
 * into its body, and return the controller.
 *
 * `saved` is the panel's persisted record. `controllers` is the live array of every
 * controller (used to find a free rail slot). `dockRail` is the dock chrome to render and
 * flash. `nextZ()` hands out stacking order; `persist()` writes the store.
 */
export function createFloatingWindow({ config, saved, controllers, dockRail, nextZ, persist }) {
  const element = config.element;
  const { render: renderDock, flashChip, dock, moreMenu, moreToggle } = dockRail;

  // Only a size the user set by resizing is remembered; otherwise the config's default applies.
  let size = sanitizeSize(saved.size);
  const width = size.width ?? config.width ?? DEFAULT_WIDTH;

  const { win, header, title, collapseButton, closeButton, resizeHandle } =
    buildWindowChrome({ config, width, height: size.height });

  const fallbackHeight = config.height ?? 260;
  const { place, placeInRail, hasPosition } = createPlacement({
    win,
    controllers,
    width,
    fallbackHeight,
    config,
    saved,
  });

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
    win.style.zIndex = String(nextZ());
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
        if (!hasPosition()) placeInRail();
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
    docked: config.dock !== false,
    pinned: Boolean(config.pinned),
    // `pinned: 2` pins the panel second on the rail; `pinned: true` pins it after those.
    pinOrder: typeof config.pinned === 'number' ? config.pinned : 1000,
    window: win,
    element,
    isOpen: () => !win.hidden,
    isCollapsed,
    // Bring an already-open window to the top of the stack without the focus shift and
    // re-placement `open()` performs, for callers that only need it seen (a selection).
    raise,
    open() {
      if (config.canOpen && !config.canOpen()) {
        config.onBlocked?.();
        return false;
      }
      config.onOpen?.();
      element.hidden = false;
      win.hidden = false;
      if (!hasPosition()) {
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
        // An unpinned panel's chip leaves the rail on close, into the hidden "More" list;
        // focus lands on "More" instead, which reopens it.
        const chip = dock?.querySelector(`.dock-chip[data-panel="${config.key}"]`);
        if (chip && !moreMenu.contains(chip)) chip.focus();
        else moreToggle.focus();
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
      if (hasPosition()) {
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
      // The icon is drawn from the attribute, so the chip's text stays its plain label.
      button.dataset.glyph = config.glyph ?? '•';
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

  wireWindowGestures({
    win,
    header,
    resizeHandle,
    place,
    raise,
    persist,
    onResized: (resized) => {
      size = { width: resized.width ?? size.width, height: resized.height ?? size.height };
    },
    isCollapsed,
    setCollapsed,
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
  if (!hasPosition() && element.hidden !== true) {
    placeInRail();
  }

  controllers.push(controller);
  sync();
  return controller;
}
