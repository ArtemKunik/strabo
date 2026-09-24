/**
 * The header and toolbar menus: the toolbar overflow menu, the Repository / View / Scope
 * popovers, and the summaries their buttons show.
 */

import { clampMenuLeft } from './strabo-float-toolbar.js';
import { rovingIndex } from './strabo-core.js';

export function createChromeMenus(app) {
  const { elements } = app;

  /** The menu items, in DOM order: one roving tab stop across the `role="menu"`. */
  function overflowItems() {
    return [...(elements.tbOverflowMenu?.querySelectorAll('[role="menuitem"]') ?? [])];
  }

  function closeOverflowMenu({ restoreFocus = false } = {}) {
    if (!elements.tbOverflowMenu || elements.tbOverflowMenu.hidden) {
      return;
    }
    elements.tbOverflowMenu.hidden = true;
    elements.tbOverflow.setAttribute('aria-expanded', 'false');
    if (restoreFocus) {
      elements.tbOverflow.focus();
    }
  }

  function openOverflowMenu() {
    elements.tbOverflowMenu.hidden = false;
    elements.tbOverflow.setAttribute('aria-expanded', 'true');
    positionOverflowMenu();
    const items = overflowItems();
    items.forEach((item, index) => {
      item.tabIndex = index === 0 ? 0 : -1;
    });
    items[0]?.focus();
  }

  /** Keep the menu on screen: right-aligned to its trigger normally, but shifted right when the
   * floating toolbar sits near the left edge and the menu would run off the viewport. */
  function positionOverflowMenu() {
    const menu = elements.tbOverflowMenu;
    const anchor = menu.offsetParent;
    if (!anchor) {
      return;
    }
    // Clear first so the anchor's rect is measured without the previous placement.
    menu.style.left = '';
    menu.style.right = '';
    const anchorRect = anchor.getBoundingClientRect();
    const left = clampMenuLeft(anchorRect.right, menu.offsetWidth, window.innerWidth);
    menu.style.left = `${left - anchorRect.left}px`;
    menu.style.right = 'auto';
  }

  if (elements.tbOverflow) {
    elements.tbOverflow.addEventListener('click', (event) => {
      event.stopPropagation();
      for (const closeHeaderPopover of headerPopoverClosers) closeHeaderPopover();
      if (elements.tbOverflowMenu.hidden) {
        openOverflowMenu();
      } else {
        closeOverflowMenu();
      }
    });
    // Arrow keys move between the items; Escape closes and returns focus to the trigger.
    elements.tbOverflowMenu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        closeOverflowMenu({ restoreFocus: true });
        return;
      }
      const items = overflowItems();
      const next = rovingIndex(items.indexOf(document.activeElement), items.length, event.key);
      if (next === null) {
        return;
      }
      event.preventDefault();
      items.forEach((item, index) => {
        item.tabIndex = index === next ? 0 : -1;
      });
      items[next].focus();
    });
    for (const id of ['tb-timeline', 'tb-branches', 'tb-review', 'tb-risk']) {
      document.getElementById(id)?.addEventListener('click', () => closeOverflowMenu({ restoreFocus: true }));
    }
    document.addEventListener('click', (event) => {
      if (!event.target.closest?.('.tb-overflow-wrap')) closeOverflowMenu();
    });
  }

  /**
   * A header popover: the toggle opens and closes it, a click outside or Escape closes it.
   * Menu items (`role="menuitem"`) close it when picked; the View popover's selects do not,
   * so several view options can be changed in one visit.
   */
  const headerPopoverClosers = [];

  function bindHeaderPopover(toggle, popover) {
    if (!toggle || !popover) {
      return;
    }
    const close = ({ restoreFocus = false } = {}) => {
      if (popover.hidden) return;
      popover.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      if (restoreFocus) toggle.focus();
    };
    headerPopoverClosers.push(close);
    toggle.addEventListener('click', (event) => {
      // The click stops here, so the document handler below never sees it: close the other
      // header popovers by hand, or two would stay open at once.
      event.stopPropagation();
      closeOverflowMenu();
      if (!popover.hidden) {
        close();
        return;
      }
      for (const closeOther of headerPopoverClosers) closeOther();
      popover.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      popover.querySelector('button:not(:disabled), select')?.focus();
    });
    popover.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        close({ restoreFocus: true });
      }
    });
    popover.addEventListener('click', (event) => {
      if (event.target.closest?.('[role="menuitem"]')) close();
    });
    document.addEventListener('click', (event) => {
      if (!toggle.parentElement?.contains(event.target)) close();
    });
  }

  bindHeaderPopover(document.getElementById('repo-menu-toggle'), document.getElementById('repo-menu'));

  bindHeaderPopover(document.getElementById('view-menu-toggle'), document.getElementById('view-menu'));

  bindHeaderPopover(document.getElementById('scope-menu-toggle'), document.getElementById('scope-menu'));

  /**
   * Scope: the tests / modules / directory chips live in a popover. Picking one filters the
   * map and closes it; the button names the active chip ("modules 238"), or "custom" when the
   * path filter matches no chip.
   */
  const scopeSummary = document.getElementById('scope-summary');

  function updateScopeSummary() {
    if (!scopeSummary || !elements.strip) return;
    const active = elements.strip.querySelector('.strip-chip[aria-pressed="true"]');
    scopeSummary.textContent = active ? active.textContent.trim() : 'custom';
  }

  elements.strip?.addEventListener('click', (event) => {
    if (!event.target.closest?.('.strip-chip')) return;
    const menu = document.getElementById('scope-menu');
    if (menu && !menu.hidden) {
      menu.hidden = true;
      document.getElementById('scope-menu-toggle')?.setAttribute('aria-expanded', 'false');
    }
  });

  if (elements.strip) {
    new MutationObserver(updateScopeSummary).observe(elements.strip, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-pressed'],
    });
    updateScopeSummary();
  }

  /**
   * The View button names what the popover is set to, e.g. "Files · All tiers · Cycles".
   * Tier and overlay appear only when set. The selects are also set from code (shortcuts,
   * prefs, URL state), which fires no `change` event, so their `value` setter is wrapped too.
   */
  const viewSummary = document.getElementById('view-summary');

  function updateViewSummary() {
    if (!viewSummary) return;
    const text = (select) => select.selectedOptions[0]?.textContent.trim() ?? '';
    const parts = [text(elements.detail)];
    if (elements.tier.value !== 'off') parts.push(text(elements.tier));
    if (elements.overlay.value !== 'none') parts.push(text(elements.overlay));
    viewSummary.textContent = parts.filter(Boolean).join(' · ');
  }

  const selectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');

  for (const select of [elements.detail, elements.tier, elements.overlay]) {
    Object.defineProperty(select, 'value', {
      configurable: true,
      get() {
        return selectValue.get.call(this);
      },
      set(next) {
        selectValue.set.call(this, next);
        updateViewSummary();
      },
    });
    select.addEventListener('change', updateViewSummary);
  }

  updateViewSummary();

  return {
    closeOverflowMenu,
  };
}
