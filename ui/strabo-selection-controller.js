/**
 * Selecting on the map: the Module Passport for a node (with its Back history), edge
 * evidence, path tracing, drill-down on double-click, and the hover line and tooltip.
 */

import { findPath, neighbourhood } from './strabo-selection.js';
import {
  renderChangesWith,
  renderEdgeEvidence,
  renderFunctions,
  renderImpactPassport,
  renderInspector,
  renderMembers,
} from './strabo-panels.js';
import {
  API_PATH,
  edgeEvidenceFor,
  fileWebUrl,
  shelfHoverText,
  unitHoverFacts,
} from './strabo-core.js';
import { focus } from './strabo-viewport.js';

export function createSelectionController(app) {
  const { store, state, view, elements } = app;

  /** Module Passport selections, oldest first, so Back can step down to one. */
  let passportHistory = [];

  /** True while Back is re-selecting, so the step it makes is not itself pushed. */
  let passportGoingBack = false;

  function selectNode(id) {
    if (!app.current) {
      return;
    }
    app.dismissHint();

    // Path mode: the first selection is the start, the second traces and exits.
    if (state.pathMode) {
      if (!state.pathFrom) {
        state.pathFrom = id;
        elements.hover.textContent = `Path start: ${id}. Select the end node.`;
        view.highlight(neighbourhood(app.current, id));
        return;
      }
      const from = state.pathFrom;
      state.pathFrom = null;
      state.pathMode = false;
      elements.tbPath.classList.remove('active');
      const path = findPath(app.current, from, id);
      elements.hover.textContent = path
        ? `${path.length - 1} step(s): ${path.join(' -> ')}`
        : `No directed path from ${from} to ${id}.`;
      view.highlight(path ?? [from, id]);
      return;
    }

    const previousSelection = app.selected;
    app.selected = id;
    store.set('ui', { node: id });
    if (!passportGoingBack && previousSelection && previousSelection !== id) {
      // Keep the module the passport is leaving, so Back can step down to it. Re-selecting
      // the node already on screen (or a Back step) does not grow the history.
      passportHistory.push(previousSelection);
    }
    view.clearEdge();
    app.selectedEdgeId = null;
    renderEdgeEvidence(elements.edgePanel, null);
    updateFocusButton();
    view.highlight(neighbourhood(app.current, id));
    const unitNode = (app.current?.nodes ?? []).find((candidate) => candidate.id === id);
    if (app.current?.systemUnit && unitNode?.systemUnit && !id.endsWith('#support')) {
      // L16: a file inside the open unit draws its own in-unit edges.
      state.unitFile = id;
      view.focusFile(id);
    }
    renderInspector(elements.inspector, app.current, id, {
      onSelect: (target) => selectNode(target),
      onTrace: (from, to) => tracePath(from, to),
      onOpenWorkspace: (target) => openFile(target),
      onBack: passportBack,
      backTitle: passportHistory.length > 0 ? 'Back to the previously selected module' : 'Back to the map',
      ...(isFileNode(id) ? { onViewSource: (target) => app.source.viewSource(target) } : {}),
      // The reading route is repository-wide; a Module Passport opens it at its own file.
      ...(isFileNode(id) ? { onOpenRoute: (target) => app.panels.showRoute(target) } : {}),
      onOpenMemberMap: (target) => {
        // The member map is a drill-down from the passport. Open it through its window
        // controller (so it centres, raises above the passport, and takes focus), then
        // retire the passport window instead of leaving the two stacked.
        app.memberMap.openMemberMap(target)
          .then(() => {
            app.floatingWindows.find((controller) => controller.key === 'inspector')?.close();
          })
          .catch((error) => {
            elements.status.textContent = `Error: ${error.message}`;
          });
      },
      // A System-view unit may ask the opt-in narrator to name its group.
      ...(app.current?.system && !app.current?.systemUnit
        ? { narratorStatus: app.narratorStatus, onNarrate: () => app.narration.narrateGroup(id), onOpenNarratorSettings: app.settings.openNarratorSettings }
        : {}),
      // Inside a unit, the selected file may show its cross-unit links (L17).
      ...(app.current?.systemUnit
        ? {
            outsideShown: state.showOutside,
            onShowOutside: () => app.units.toggleOutsideLinks(),
            onExpandUnit: (unit) => app.units.toggleExpandedUnit(unit),
          }
        : {}),
    });
    if (!app.current?.system) {
      loadMembers(id);
    }
    app.refreshDock();
  }

  /** Fetch members, functions, and the impact passport for the selected file; all on demand. */
  async function loadMembers(id) {
    const membersSection = elements.inspector.querySelector('[data-role="members"]');
    const functionsSection = elements.inspector.querySelector('[data-role="functions"]');
    const impactSection = elements.inspector.querySelector('[data-role="impact"]');
    const changesWithSection = elements.inspector.querySelector('[data-role="changes-with"]');
    if (!membersSection && !functionsSection && !impactSection && !changesWithSection) {
      return;
    }
    const params = new URLSearchParams({ file: id });
    if (state.repository) {
      params.set('repository', state.repository);
    }
    const impactParams = new URLSearchParams(params);
    try {
      if (app.narratorStatus === null) {
        app.narratorStatus = await app.narration.fetchNarratorStatus();
      }
      const [symbolsResponse, impactResponse] = await Promise.all([
        fetch(`${API_PATH}/symbols?${params.toString()}`),
        fetch(`${API_PATH}/analysis/impact-passport?${impactParams.toString()}`),
      ]);
      const result = symbolsResponse.ok
        ? await symbolsResponse.json()
        : { available: false, detail: 'Symbols are unavailable for this file.' };
      const impact = impactResponse.ok ? await impactResponse.json() : null;
      const changesWith = changesWithSection ? await app.lenses.loadChangesWith(id) : null;
      if (app.selected === id) {
        if (membersSection) renderMembers(membersSection, result);
        if (functionsSection) renderFunctions(functionsSection, result, app.narration.functionsHandlers(result));
        if (impactSection) renderImpactPassport(impactSection, impact ? impactPassportSet(impact) : null);
        if (changesWithSection) renderChangesWith(changesWithSection, changesWith, { onSelect: (file) => selectNode(file) });
      }
    } catch {
      if (app.selected === id) {
        const fallback = { available: false, detail: 'Symbols could not be loaded.' };
        if (membersSection) renderMembers(membersSection, fallback);
        if (functionsSection) renderFunctions(functionsSection, fallback, app.narration.functionsHandlers(fallback));
        if (impactSection) renderImpactPassport(impactSection, null);
        if (changesWithSection) renderChangesWith(changesWithSection, { available: false, detail: 'Co-change could not be loaded.' });
      }
    }
  }

  /** Wrap a single file's passport in the set shape the shared card renderer reads. */
  function impactPassportSet(card) {
    if (!card || card.path === undefined) {
      return null;
    }
    return {
      scope: 'file',
      baseline: card.status === 'added' ? null : 'HEAD',
      files: [card],
      totals: null,
      capped: false,
      ...(card.provenance ? { provenance: card.provenance } : {}),
    };
  }

  function clearSelection() {
    app.selected = null;
    passportHistory = [];
    store.set('ui', { node: null });
    state.pathFrom = null;
    state.pathMode = false;
    elements.tbPath.classList.remove('active');
    state.unitFile = null;
    view.focusFile(null);
    elements.hover.textContent = '';
    hideTooltip();
    view.highlight(null);
    view.clearEdge();
    app.selectedEdgeId = null;
    renderEdgeEvidence(elements.edgePanel, null);
    app.git.closeReview();
    app.git.closeRisk();
    elements.inspector.hidden = true;
    view.clearGroupSelection();
    updateFocusButton();
    app.refreshDock();
  }

  /**
   * Step the Module Passport back to the module it was opened from, or to the map when it is
   * the first one this session. The step is marked so re-selecting does not push it again.
   */
  function passportBack() {
    const previous = passportHistory.pop();
    passportGoingBack = true;
    try {
      if (previous) {
        selectNode(previous);
      } else {
        clearSelection();
      }
    } finally {
      passportGoingBack = false;
    }
  }

  function tracePath(from, to) {
    const path = findPath(app.current, from, to);
    const trace = elements.inspector.querySelector('[data-role="trace"]');
    if (trace) {
      if (path) {
        trace.textContent = `${path.length - 1} step(s): ${path.join(' → ')}`;
      } else {
        trace.textContent = `No directed path from ${from} to ${to}.`;
      }
    }
    if (path) {
      view.highlight(path);
      elements.hover.textContent = `${path.length - 1} step(s): ${path.join(' -> ')}`;
    } else {
      elements.hover.textContent = `No directed path from ${from} to ${to}.`;
    }
  }

  /** Explain the tapped edge from the evidence the scanner recorded. */
  function selectEdge(edgeId) {
    if (!app.current || !edgeId) {
      view.clearEdge();
      app.selectedEdgeId = null;
      renderEdgeEvidence(elements.edgePanel, null);
      app.refreshDock();
      return;
    }
    app.selectedEdgeId = edgeId;
    const evidence = edgeEvidenceFor(app.current, edgeId);
    renderEdgeEvidence(elements.edgePanel, evidence, {
      onSelect: (id) => selectNode(id),
      onTrace: (from, to) => tracePath(from, to),
      ...(evidence && isFileNode(evidence.source)
        ? { onViewSource: (file, line) => app.source.viewSource(file, { line }) }
        : {}),
      onClear: () => {
        view.clearEdge();
        app.selectedEdgeId = null;
        renderEdgeEvidence(elements.edgePanel, null);
        app.refreshDock();
      },
    });
    if (evidence) {
      elements.hover.textContent = `${evidence.source} → ${evidence.target} · ${evidence.kind} · L${evidence.line ?? '?'} ${evidence.specifier ?? ''}`;
    }
    app.refreshDock();
  }

  function onSelect(id) {
    selectNode(id);
  }

  /**
   * Centre-selection only has a target once a node is selected. Left enabled with nothing
   * selected it reads as a control that does nothing, so it follows the selection instead.
   */
  function updateFocusButton() {
    if (!elements.tbFocus) {
      return;
    }
    elements.tbFocus.disabled = !app.selected;
  }

  /**
   * Double-click drills: opens a block, a System unit, or a file. At System L0 a double-click
   * opens the unit; on a file it opens the source viewer.
   */
  function onDrill(id) {
    if (state.mode === 'system') {
      const node = app.current?.nodes.find((candidate) => candidate.id === id);
      if (!node) {
        return;
      }
      if (node.systemUnit) {
        if (!id.endsWith('#support')) app.source.viewSource(id);
        return;
      }
      app.units.openUnit(id);
      return;
    }
    if (state.mode === 'block') {
      state.prefix = id;
      state.filter = '';
      elements.filter.value = '';
      app.scan();
      return;
    }
    app.source.viewSource(id);
  }

  function openFile(id) {
    const adapters = window.straboAdapters ?? {};
    if (typeof adapters.openWorkspaceFile === 'function') {
      adapters.openWorkspaceFile(id);
      return;
    }
    const url = fileWebUrl(app.current?.repository, id);
    if (url) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    elements.status.textContent = `No opener available for ${id}`;
  }

  /** True when `id` is a file the viewer can read, not a directory block, unit, or shelf. */
  function isFileNode(id) {
    const node = (app.current?.nodes ?? []).find((candidate) => candidate.id === id);
    if (!node || node.kind === 'unit' || node.kind === 'shelf') {
      return false;
    }
    return state.mode === 'file' || Boolean(node.systemUnit && !id.endsWith('#support'));
  }

  function showTooltip(id, clientX, clientY) {
    if (!elements.tooltip || !app.current) return;
    const node = app.current.nodes.find((candidate) => candidate.id === id);
    if (!node) return;
    elements.tooltip.replaceChildren();
    const kind = node.kind ?? '';
    // L20: a unit or shelf reads in unit vocabulary, not as a file with a blast radius.
    const unit = kind === 'unit' ? unitHoverFacts(app.current, id) : null;
    const title = document.createElement('div');
    title.className = 'tt-title';
    title.textContent = unit ? unit.title : node.label ?? id;
    elements.tooltip.append(title);
    const rows = unit
      ? unit.rows
      : node.shelf
        ? [shelfHoverText(node.shelf)]
        : [
            node.systemUnit && !id.endsWith('#support')
              ? `blast ${node.inUnitDependents ?? 0} in unit · ${node.outsideDependents ?? 0} outside · id ${id}`
              : `blast ${node.transitiveDependents ?? 0} · id ${id}`,
          ];
    rows.forEach((text, index) => {
      const row = document.createElement('div');
      row.className = 'tt-row';
      if (index === 0 && !unit && !node.shelf) {
        const chip = document.createElement('span');
        chip.className = 'tt-kind';
        chip.textContent = kind;
        row.append(chip);
      }
      const value = document.createElement('span');
      value.textContent = text;
      row.append(value);
      elements.tooltip.append(row);
    });
    elements.tooltip.hidden = false;
    const wrap = elements.tooltip.parentElement.getBoundingClientRect();
    elements.tooltip.style.left = `${Math.min(clientX - wrap.left + 14, wrap.width - 310)}px`;
    elements.tooltip.style.top = `${Math.max(clientY - wrap.top - 10, 8)}px`;
  }

  function hideTooltip() {
    if (elements.tooltip) elements.tooltip.hidden = true;
  }

  view.onHover((id, event) => {
    if (!id) {
      elements.hover.textContent = '';
      hideTooltip();
      return;
    }
    const node = app.current?.nodes.find((candidate) => candidate.id === id);
    const unit = node?.kind === 'unit' ? unitHoverFacts(app.current, id) : null;
    const insideUnit = node?.systemUnit && !id.endsWith('#support');
    if (unit) {
      elements.hover.textContent = `${unit.title} · ${unit.rows.join(' · ')}`;
    } else if (node?.shelf) {
      elements.hover.textContent = `${id} · ${shelfHoverText(node.shelf)}`;
    } else {
      elements.hover.textContent = insideUnit
        ? `${id} · blast radius ${node.inUnitDependents ?? 0} in unit · ${node.outsideDependents ?? 0} outside · ${node.kind ?? ''}`
        : `${id} · blast radius ${node?.transitiveDependents ?? 0} · ${node?.kind ?? ''}`;
    }
    if (event?.clientX !== undefined) showTooltip(id, event.clientX, event.clientY);
  });

  elements.tbFocus.addEventListener('click', () => {
    if (app.selected) {
      focus(view.cy, app.selected);
    }
  });

  elements.tbPath.addEventListener('click', () => {
    state.pathMode = !state.pathMode;
    state.pathFrom = null;
    elements.tbPath.classList.toggle('active', state.pathMode);
    elements.hover.textContent = state.pathMode ? 'Path mode: select the start node.' : '';
  });

  elements.tbClear.addEventListener('click', clearSelection);

  view.onSelect(onSelect);

  view.onDrill(onDrill);

  view.onEdge(selectEdge);

  return {
    clearSelection,
    hideTooltip,
    isFileNode,
    onDrill,
    selectEdge,
    selectNode,
    updateFocusButton,
  };
}
