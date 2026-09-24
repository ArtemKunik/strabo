/**
 * System view drill-down: opening and leaving a build unit, a file's cross-unit links, the
 * expandable target-unit badges, and the toolbar controls that only exist inside a unit.
 */

export function createSystemUnits(app) {
  const { state, elements } = app;

  /** Open one build unit in System mode, showing its files inside their layers. */
  function openUnit(id) {
    if (state.mode !== 'system') {
      return;
    }
    const node = app.current?.nodes.find((candidate) => candidate.id === id);
    state.systemUnit = id;
    state.systemUnitLabel = node?.label ?? id;
    state.unitFile = null;
    state.showOutside = false;
    state.expandedUnits = [];
    app.scan();
  }

  /** Leave a unit back to the L0 unit map. */
  function closeUnit() {
    state.systemUnit = null;
    state.systemUnitLabel = null;
    state.unitFile = null;
    state.showOutside = false;
    state.expandedUnits = [];
    app.scan();
  }

  /**
   * Draw or hide the selected file's cross-unit links (L17).
   *
   * Nothing crosses the unit frame until this is asked for; the choice is part of the deep
   * link and is refetched with the selected file so the links end at their target unit boxes.
   */
  function toggleOutsideLinks() {
    if (state.mode !== 'system' || !state.systemUnit) {
      return;
    }
    if (!state.unitFile) {
      elements.hover.textContent = 'Select a file inside the unit before showing outside links.';
      return;
    }
    state.showOutside = !state.showOutside;
    state.expandedUnits = [];
    updateOutsideButton();
    app.scan();
  }

  /** Expand or fold a target unit's badge, revealing the files it holds in place. */
  function toggleExpandedUnit(id) {
    const set = new Set(state.expandedUnits ?? []);
    if (set.has(id)) {
      set.delete(id);
    } else {
      set.add(id);
    }
    state.expandedUnits = [...set].sort();
    app.scan();
  }

  /** The L19 note: a one-unit repository says why it skipped the L0 unit map. */
  function updateSystemNote(model) {
    if (!elements.systemNote) {
      return;
    }
    const single = Boolean(model?.system && model.systemUnit && model.systemSingleUnit === model.systemUnit);
    elements.systemNote.hidden = !single;
    if (single) {
      elements.systemNote.textContent = '1 build unit: showing its layers';
    }
  }

  /** The toolbar action appears only when a unit is open; its pressed state follows the flag. */
  function updateOutsideButton() {
    if (!elements.tbOutside) {
      return;
    }
    const shown = state.mode === 'system' && Boolean(state.systemUnit);
    elements.tbOutside.hidden = !shown;
    elements.tbOutside.classList.toggle('active', state.showOutside);
    elements.tbOutside.setAttribute('aria-pressed', String(state.showOutside));
  }

  /**
   * The explicit way back to the unit map (L20).
   *
   * Esc and the breadcrumb both leave a unit, but neither is visible on the canvas, so a
   * reader who has just opened a unit needs a control that names where it goes.
   */
  function updateUnitsButton() {
    if (!elements.tbUnits) {
      return;
    }
    elements.tbUnits.hidden = !(state.mode === 'system' && Boolean(state.systemUnit));
  }

  if (elements.tbOutside) {
    elements.tbOutside.addEventListener('click', () => toggleOutsideLinks());
  }

  if (elements.tbUnits) {
    elements.tbUnits.addEventListener('click', () => closeUnit());
  }

  return {
    closeUnit,
    openUnit,
    toggleExpandedUnit,
    toggleOutsideLinks,
    updateOutsideButton,
    updateSystemNote,
    updateUnitsButton,
  };
}
