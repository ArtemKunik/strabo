/**
 * Keyboard-navigation helpers for roving focus.
 *
 * A roving tabindex keeps one item in a composite widget (tab list, menu, toolbar) tabbable
 * and the rest reachable by arrow keys. The index arithmetic is pure so it can be unit
 * tested; the DOM code that calls it stays thin.
 *
 * Pure functions only: no DOM, no Cytoscape, no fetch.
 */

/** The keys a roving widget moves on, in both orientations. */
export const ROVING_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];

/**
 * The index a roving key moves focus to, or null when the key is not a navigation key.
 *
 * Wraps by default, which is the ARIA authoring practice for tab lists and menus: an arrow
 * past the last item lands on the first. `wrap: false` clamps instead, for a widget that
 * should stop at its ends.
 */
export function rovingIndex(current, count, key, { wrap = true } = {}) {
  if (!ROVING_KEYS.includes(key) || count <= 0) {
    return null;
  }
  const index = Number.isInteger(current) && current >= 0 && current < count ? current : 0;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return wrap ? (index + 1) % count : Math.min(index + 1, count - 1);
    case 'ArrowLeft':
    case 'ArrowUp':
      return wrap ? (index - 1 + count) % count : Math.max(index - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * Focus the item a roving key selects and make sure it is the tabbable one.
 *
 * `items` is an array of focusable elements in visual order; `activeElement` is compared by
 * identity so the helper stays free of the DOM types. Returns the newly focused element, or
 * null when the key is not a navigation key or there is nothing to focus.
 */
export function applyRovingFocus(items, activeElement, key, options) {
  const target = rovingIndex(items.indexOf(activeElement), items.length, key, options);
  if (target === null) {
    return null;
  }
  for (const item of items) {
    item.tabIndex = -1;
  }
  const next = items[target];
  if (!next) {
    return null;
  }
  next.tabIndex = 0;
  next.focus();
  return next;
}
