/**
 * The floating-window dock rail: the vertical strip of chips that restores closed or
 * collapsed panels, its overflow fades, and the "More" menu for chips that do not fit on
 * the rail.
 *
 * `createDockRail` owns the rail's DOM and keyboard contract; `strabo-float.js` drives it
 * with `render()` after the set of windows or their open state changes.
 */

import { rovingIndex } from './strabo-core.js';

export function createDockRail({ dock, controllers }) {
  /**
   * Fade a dock edge while more chips sit past it. The rail is nowrap and its native
   * scrollbar is hidden, so without a fade the clipped chips just look cut off.
   */
  const syncOverflow = () => {
    if (!dock) return;
    const max = dock.scrollHeight - dock.clientHeight;
    dock.classList.toggle('is-overflow-top', dock.scrollTop > 1);
    dock.classList.toggle('is-overflow-bottom', max > 1 && dock.scrollTop < max - 1);
  };

  /** The "More" list: every docked panel without a rail chip right now. */
  let moreOpen = false;
  const moreToggle = document.createElement('button');
  moreToggle.type = 'button';
  moreToggle.className = 'dock-more';
  moreToggle.dataset.glyph = '⋯';
  moreToggle.textContent = 'More';
  moreToggle.title = 'More panels';
  moreToggle.setAttribute('aria-haspopup', 'menu');
  const moreMenu = document.createElement('div');
  moreMenu.className = 'dock-more-menu';
  moreMenu.setAttribute('role', 'menu');
  moreMenu.setAttribute('aria-label', 'More panels');

  const setMoreOpen = (open) => {
    moreOpen = open;
    moreMenu.hidden = !open;
    moreToggle.setAttribute('aria-expanded', String(open));
  };
  moreToggle.addEventListener('click', (event) => {
    event.stopPropagation();
    setMoreOpen(!moreOpen);
    if (moreOpen) moreMenu.querySelector('.dock-chip:not(:disabled)')?.focus();
  });
  moreMenu.addEventListener('click', (event) => {
    if (event.target.closest?.('.dock-chip')) setMoreOpen(false);
  });
  moreMenu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setMoreOpen(false);
      moreToggle.focus();
    }
  });
  document.addEventListener('click', (event) => {
    if (moreOpen && !moreMenu.contains(event.target)) setMoreOpen(false);
  });
  setMoreOpen(false);

  const render = () => {
    if (!dock) return;
    const docked = controllers.filter((controller) => controller.docked);
    const inRail = (controller) => controller.pinned || controller.isOpen();
    // Pinned chips keep their pin order; an open unpinned panel follows them.
    const railOrder = (controller) => (controller.pinned ? controller.pinOrder : Infinity);
    const railChips = docked
      .filter(inRail)
      .sort((a, b) => railOrder(a) - railOrder(b))
      .map((controller) => controller.dockButton());
    const moreChips = docked.filter((controller) => !inRail(controller)).map((controller) => {
      const chip = controller.dockButton();
      chip.setAttribute('role', 'menuitem');
      return chip;
    });
    moreMenu.replaceChildren(...moreChips);
    moreToggle.hidden = moreChips.length === 0;
    const tail = moreChips.length ? [moreToggle, moreMenu] : [];
    dock.replaceChildren(...railChips, ...tail);
    // A toolbar is one tab stop: the first enabled rail chip is tabbable and the arrow keys
    // move focus between the rest, ending on "More".
    const enabled = railItems();
    enabled.forEach((chip, index) => {
      chip.tabIndex = index === 0 ? 0 : -1;
    });
    syncOverflow();
  };

  /** The rail's own keyboard stops: enabled chips on the rail, then the "More" toggle. */
  const railItems = () =>
    [...(dock?.children ?? [])].filter(
      (item) => (item.classList.contains('dock-chip') || item === moreToggle) && !item.disabled && !item.hidden,
    );

  /** Draw attention to the chip that just opened its window, so the panel is found. */
  const flashChip = (key) => {
    const chip = dock?.querySelector(`.dock-chip[data-panel="${key}"]`);
    if (!chip) return;
    chip.classList.remove('is-flash');
    // Reflow between remove and add so re-opening restarts the animation.
    void chip.offsetWidth;
    chip.classList.add('is-flash');
  };

  // Arrow keys move focus between the dock chips (roving tabindex), Home/End jump to the
  // ends. The dock is a `role="toolbar"`, so this is the expected keyboard contract.
  dock?.addEventListener('keydown', (event) => {
    if (moreMenu.contains(event.target)) {
      const items = [...moreMenu.querySelectorAll('.dock-chip')].filter((chip) => !chip.disabled);
      const target = rovingIndex(items.indexOf(document.activeElement), items.length, event.key);
      if (target !== null) {
        event.preventDefault();
        items[target].focus();
      }
      return;
    }
    const chips = railItems();
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

  // The rail scrolls vertically on a short window; the edge fades follow. Observe size
  // changes so the fades appear the moment the window is shortened.
  dock?.addEventListener('scroll', syncOverflow, { passive: true });
  if (dock && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(syncOverflow).observe(dock);
  }

  return { dock, moreMenu, moreToggle, render, railItems, flashChip };
}
