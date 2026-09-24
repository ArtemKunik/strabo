/**
 * Global keyboard shortcuts: screen switching, the filter, Escape's step back, and the
 * single-key map actions, which stay out of the way while a field has focus.
 */

import { showToast } from './strabo-delegate.js';
import { focus } from './strabo-viewport.js';

export function bindKeyboardShortcuts(app) {
  const { store, state, view, elements } = app;

  document.addEventListener('keydown', (event) => {
    const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '');
    const screen = store.get().ui.screen;
    const onGraph = screen === 'graph';
    // Escape leaves a full-screen Review or History tab and returns to the map. The Terminal
    // screen keeps Escape for its own widgets (switcher, menus).
    if (event.key === 'Escape' && (screen === 'review' || screen === 'history') && !inField) {
      event.preventDefault();
      app.setScreen('graph');
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && onGraph) {
      event.preventDefault();
      elements.filter.focus();
      elements.filter.select();
      return;
    }
    // Screen-level shortcuts. The terminal screen owns its own Ctrl+K and tab keys; these
    // only cover opening a shell, closing the active session, and the run presets, and stay
    // out of the way while any field (including the terminal's own input) has focus.
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && !inField) {
      const screenKey = event.key.toLowerCase();
      if (screenKey === 't') {
        event.preventDefault();
        app.setScreen('terminal');
        app.terminalScreen?.newSession?.({ kind: 'shell' })?.catch((error) => {
          showToast(`Could not open a shell (${error.message}).`);
        });
        return;
      }
      if (screenKey === 'w') {
        event.preventDefault();
        // Closing the active tab is the screen's call; a screen without the extension no-ops.
        app.terminalScreen?.closeActiveSession?.();
        return;
      }
      if (screenKey === 'r') {
        event.preventDefault();
        app.setScreen('terminal');
        // The presets menu lives in the screen; if it exposes no opener, the screen is still shown.
        app.terminalScreen?.openPresetMenu?.();
        return;
      }
    }
    if (event.key === 'Escape') {
      app.menus.closeOverflowMenu();
      if (!elements.memberView.hidden) {
        app.memberMap.closeMemberMap();
        return;
      }
      if (state.filter && !inField) {
        state.filter = '';
        elements.filter.value = '';
        app.applyFilterToView();
        return;
      }
      // Escape inside an open unit goes back to the L0 unit map.
      if (state.mode === 'system' && state.systemUnit && !inField) {
        app.units.closeUnit();
        return;
      }
      if (!inField) app.selection.clearSelection();
      return;
    }
    if (event.key === 'Enter' && !inField && state.mode === 'system' && app.selected) {
      const node = app.current?.nodes.find((candidate) => candidate.id === app.selected);
      if (node && !node.systemUnit) {
        // Enter opens the focused unit, matching a double-click.
        event.preventDefault();
        app.units.openUnit(app.selected);
        return;
      }
    }
    if (event.key === '?' && !inField) {
      event.preventDefault();
      app.windows.toggleShortcuts();
      return;
    }
    if (inField || !elements.memberView.hidden || !onGraph) return;
    const key = event.key.toLowerCase();
    if (key === 'f' && app.selected) focus(view.cy, app.selected);
    else if (key === 'i') elements.tbImpact.click();
    else if (key === 'o' && state.mode === 'system' && state.systemUnit) elements.tbOutside.click();
    else if (key === 'u' && state.mode === 'system' && state.systemUnit) app.units.closeUnit();
    else if (key === 'p') elements.tbPath.click();
    else if (key === 'b') elements.tbBoundaries.click();
    else if (key === 'c' && state.mode === 'file') elements.tbCalls?.click();
    else if (key === 'h' && state.mode === 'file') elements.tbCoChange?.click();
    else if (key === 'l' && state.mode === 'file') elements.tbLabels?.click();
    else if (key === 'z' && state.mode === 'file') elements.tbLoc?.click();
    else if (key === 's' && app.selected && app.selection.isFileNode(app.selected)) app.source.viewSource(app.selected);
    else if (key === 't') elements.tbTimeline.click();
    else if (key === 'r') elements.tbReview.click();
    else if (key === 'v') elements.tbRisk.click();
    else if (key === 'n') elements.tbBranches.click();
    else if (key === 'g' && app.groupSelection.length >= 2) elements.tbDelegateGroup.click();
  });

  return {};
}
