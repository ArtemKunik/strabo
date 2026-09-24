/**
 * Persistence for Strabo's floating windows: one localStorage record per panel holding its
 * size, collapsed state, and (once placed) position, so a layout survives reloads.
 *
 * Storage is optional; a blocked or absent localStorage only costs persistence.
 */

export const STORAGE_KEY = 'strabo.float.windows.v2';

export function readStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writeStore(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage is optional; a blocked/absent localStorage only costs persistence.
  }
}
