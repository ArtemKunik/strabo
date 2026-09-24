/**
 * The floating-window dock rail: the vertical strip of chips that restores closed or
 * collapsed panels, and its keyboard contract.
 *
 * `createDockRail` owns the rail's DOM; the "More" menu is built by
 * `strabo-float-dock-menu.js` and the edge fades by `strabo-float-dock-overflow.js`.
 * `strabo-float.js` drives it with `render()` after the set of windows or their open state
 * changes.
 */

import { rovingIndex } from './strabo-core.js';
import { createDockMoreMenu } from './strabo-float-dock-menu.js';
import { createDockOverflow } from './strabo-float-dock-overflow.js';

export function createDockRail({ dock, controllers }) {
  const syncOverflow = createDockOverflow(dock);
  const { moreToggle, moreMenu, setMoreOpen } = createDockMoreMenu();

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

  return { dock, moreMenu, moreToggle, render, railItems, flashChip };
}
