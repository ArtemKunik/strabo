/**
 * Per-repository view preferences.
 *
 * View settings (detail mode, review overlay, filter, and the calls, co-change, and large-file
 * lenses) persist per repository in localStorage, so a reload or revisit restores the exact
 * view. The key is the repository root; unknown values are ignored rather than applied.
 */

import { readIslandLayout } from './strabo-island-layout.js';
import { FILE_MODE_OVERLAYS } from './strabo-overlays.js';

export function createViewPrefs(app) {
  const { state, view, elements } = app;

  /**
   * View settings (detail mode, review overlay, filter) persist per repository
   * in localStorage, so a reload or revisit restores the exact view. The key is
   * the repository root; unknown values are ignored rather than applied.
   */
  const VIEW_PREFS_PREFIX = 'strabo.view.';

  let prefsSaveTimer = null;

  function viewPrefsKey(repository) {
    return `${VIEW_PREFS_PREFIX}${repository ?? 'default'}`;
  }

  function readViewPrefs(repository) {
    try {
      const raw = window.localStorage.getItem(viewPrefsKey(repository));
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      const prefs = {};
      if (parsed.mode === 'block' || parsed.mode === 'file' || parsed.mode === 'system') {
        prefs.mode = parsed.mode;
      }
      if (typeof parsed.overlay === 'string' && parsed.overlay !== '') {
        prefs.overlay = parsed.overlay;
      }
      if (typeof parsed.filter === 'string' && parsed.filter !== '') {
        prefs.filter = parsed.filter.slice(0, 200);
      }
      if (parsed.edgeKind === 'calls' || parsed.edgeKind === 'imports') {
        prefs.edgeKind = parsed.edgeKind;
      }
      if (parsed.coChange === true) {
        prefs.coChange = true;
      }
      if (parsed.locLens === true) {
        prefs.locLens = true;
      }
      return prefs;
    } catch {
      return null;
    }
  }

  function writeViewPrefs() {
    try {
      window.localStorage.setItem(
        viewPrefsKey(state.repository),
        JSON.stringify({
          mode: state.mode,
          overlay: state.overlay,
          filter: state.filter,
          edgeKind: state.edgeKind,
          coChange: state.coChange,
          locLens: state.locLens,
        }),
      );
    } catch {
      // Storage unavailable (private mode, quota): the app simply doesn't persist.
    }
  }

  function schedulePrefsSave() {
    if (prefsSaveTimer) {
      clearTimeout(prefsSaveTimer);
    }
    prefsSaveTimer = setTimeout(() => {
      prefsSaveTimer = null;
      writeViewPrefs();
    }, 300);
  }

  /** Apply saved settings for the current repository; call before the first scan. */
  function applyViewPrefs() {
    // The island arrangement is per repository too, and applies even when no view prefs exist.
    view.setIslandOffsets(readIslandLayout(state.repository));
    const prefs = readViewPrefs(state.repository);
    if (!prefs) {
      return;
    }
    if (prefs.mode) {
      state.mode = prefs.mode;
      elements.detail.value = prefs.mode;
    }
    if (prefs.filter) {
      state.filter = prefs.filter;
      elements.filter.value = prefs.filter;
    }
    if (prefs.overlay && [...elements.overlay.options].some((option) => option.value === prefs.overlay)) {
      state.overlay = prefs.overlay;
      elements.overlay.value = prefs.overlay;
      // File-mode overlays need file mode (same rule as the change handler).
      if (FILE_MODE_OVERLAYS.includes(prefs.overlay) && state.mode !== 'file') {
        state.mode = 'file';
        elements.detail.value = 'file';
      }
    }
    // The calls lens only reads edges in file mode.
    if (prefs.edgeKind === 'calls' && state.mode === 'file') {
      state.edgeKind = 'calls';
    }
    // The co-change lens is remembered, but its report is only fetched when file mode draws it.
    if (prefs.coChange) {
      state.coChange = true;
    }
    // The large-file lens needs a line count, which only file nodes carry.
    if (prefs.locLens) {
      state.locLens = true;
    }
  }

  return {
    applyViewPrefs,
    schedulePrefsSave,
    writeViewPrefs,
  };
}
