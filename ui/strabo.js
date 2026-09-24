/**
 * Strabo browser controller.
 *
 * Owns user intent: repository and layer selection, block/file detail level, filters,
 * selection, drill-down, and navigation. Delegates rendering to strabo-view, inspector
 * and panels to strabo-panels, neighbourhood and path operations to strabo-selection,
 * and viewport operations to strabo-viewport.
 *
 * The UI calls only Strabo APIs and renders empty, loading, error, diagnostics,
 * catalogue, layout, evidence, and drill-down states without host globals.
 */

import {
  API_PATH,
  buildAgentPrompt,
  buildGraphQuery,
  edgeEvidenceFor,
  fileWebUrl,
  filterNodes,
  folderLocation,
  graphSummary,
  mapCounts,
  passportFor,
  rovingIndex,
  shelfHoverText,
  unitHoverFacts,
} from './strabo-core.js';
import { createView } from './strabo-view.js';
import { writeIslandLayout } from './strabo-island-layout.js';
import { closeContextMenu, copyText, launchAgent, setDelegateSessionOpener, showContextMenu, showPromptReview, showToast } from './strabo-delegate.js';
import { initFloatingWindows } from './strabo-float.js';
import { clampMenuLeft, initFloatingToolbar } from './strabo-float-toolbar.js';
import { createFreshnessBadge } from './strabo-freshness.js';
import {
  renderBreadcrumb,
  renderChangesWith,
  renderDiagnostics,
  renderEdgeEvidence,
  renderFolderList,
  renderFunctions,
  renderImpactPassport,
  renderInspector,
  renderLegend,
  renderMembers,
  renderOverlayPanel,
  renderShortcuts,
  renderSource,
  renderTestsStrip,
} from './strabo-panels.js';
import { findPath, neighbourhood } from './strabo-selection.js';
import { buildBrickAssembly } from './strabo-lego.js';
import { applyAppearance, readSettings, watchSystemPreferences } from './strabo-settings.js';
import { fit, focus, zoomIn, zoomOut } from './strabo-viewport.js';
import { createStore } from './store.js';
import { initTerminalScreen } from './strabo-terminal.js';
import { createViewPrefs } from './strabo-view-prefs.js';
import { createRuntimeReadout } from './strabo-runtime-readout.js';
import { createUrlState } from './strabo-url-state.js';
import { createNarrationController } from './strabo-narration-controller.js';
import { createMemberMapController } from './strabo-member-map-controller.js';
import { createGitController } from './strabo-git-controller.js';
import { createSettingsController } from './strabo-settings-controller.js';
import { createRepositoryPanels } from './strabo-repo-panels.js';
import { createLensController } from './strabo-lens-controller.js';

/**
 * The state several features read and write. It lives on one object, rather than in
 * module-level `let`s, so a feature controller in its own module sees the same values.
 */
const app = {
  /** Incremented on every scan; async completions check their captured generation. */
  scanGeneration: 0,
  /** The graph model the canvas is drawing, or null before the first scan. */
  current: null,
  /** The node the Module Passport shows, or null. */
  selected: null,
  /** Edge id (`e<N>`) with an open evidence panel, or null. */
  selectedEdgeId: null,
  /** Node ids currently held in cytoscape's own selection: ⌘/ctrl-click or shift-drag. */
  groupSelection: [],
  /** The Git review result currently shown in the review panel, for delegation. */
  currentReview: null,
  /** The narrator status from `/narrator`, fetched once; null until it resolves. */
  narratorStatus: null,
  /** Provider presets for the Settings Narrator section, from `/narrator`. */
  narratorPresets: [],
  /** Client preferences, read once and re-applied on every change. */
  clientPrefs: readSettings(),
  /** The Terminal screen, assigned once it is created at bootstrap. */
  terminalScreen: null,
  /** The last loaded member-map payload. */
  memberData: null,
  /** The floating-window controllers, assigned once the panels are wrapped. */
  floatingWindows: null,
};

/**
 * One store for the app's UI state. `state` and `memberUI` stay the view onto the `view` and
 * `member` slices so existing code keeps reading them, but changes go through `store.set`,
 * which notifies a single subscription that re-renders and keeps the URL in sync.
 */
const store = createStore({
  view: {
    repository: null,
    mode: 'block',
    depth: 1,
    prefix: '',
    filter: '',
    overlay: 'none',
    /** The edge lens: 'imports' for module coupling, 'calls' for recorded function calls. */
    edgeKind: 'imports',
    /** The co-change coupling lens: off by default, since it needs a git history pass. */
    coChange: false,
    /** The large-file lens: keep only files at or above the line threshold. Off by default. */
    locLens: false,
    /** The tier lens: 'off', 'all' to colour every tier, or one tier to colour and filter. */
    tier: 'off',
    pathMode: false,
    pathFrom: null,
    renderedGeneration: 0,
    /** The open build unit in a System drill-down, or null at L0. */
    systemUnit: null,
    /** The open unit's declared name, for the breadcrumb. */
    systemUnitLabel: null,
    /** The file whose in-unit edges are drawn, or null. */
    unitFile: null,
    /** Whether the selected file's cross-unit links are drawn (L17). */
    showOutside: false,
    /** Target units whose count badge is expanded in place. */
    expandedUnits: [],
    /** Set once a single-unit repository has auto-opened, so L0 is not re-entered (L19). */
    systemAutoOpened: false,
  },
  member: {
    order: 'source',
    find: '',
    showWiring: true,
    zoom: 'medium',
    dataFlow: true,
    onlyFlow: false,
    explain: false,
    stepIndex: 0,
    dim: false,
  },
  ui: { node: null, memberOpen: false, screen: 'graph' },
});
const state = store.get().view;
const memberUI = store.get().member;

const view = createView(document.getElementById('graph'));

// A finished island drag writes the arrangement under the repository it belongs to; a later
// visit to that repository replays it. The view owns the offsets at runtime, so this only
// persists what a drag just produced.
view.onIslandLayout((offsets) => {
  writeIslandLayout(state.repository, offsets);
});

/**
 * Re-apply the client preferences. `applyAppearance` sets the theme and reduce-motion
 * attributes before the first render; the canvas reads their colours, so it is restyled
 * here too.
 */
function applyClientPrefs() {
  applyAppearance(app.clientPrefs);
  view.applyTheme();
  view.setLabelsVisible(app.clientPrefs.labels);
  view.setLabelsForceAll(app.clientPrefs.allLabels);
  app.terminalScreen?.applyTheme();
}

applyClientPrefs();

const elements = {
  repository: document.getElementById('repository'),
  browse: document.getElementById('browse'),
  detail: document.getElementById('detail'),
  refresh: document.getElementById('refresh'),
  filter: document.getElementById('filter'),
  filterClear: document.getElementById('filter-clear'),
  filterCount: document.getElementById('filter-count'),
  overlay: document.getElementById('overlay'),
  tier: document.getElementById('tier'),
  overlayPanel: document.getElementById('overlay-panel'),
  edgePanel: document.getElementById('edge-panel'),
  reviewPanel: document.getElementById('review-panel'),
  riskPanel: document.getElementById('risk-panel'),
  diagnosticsToggle: document.getElementById('diagnostics-toggle'),
  diagnosticsBadge: document.getElementById('diagnostics-badge'),
  diagnostics: document.getElementById('diagnostics'),
  legend: document.getElementById('legend'),
  breadcrumb: document.getElementById('breadcrumb'),
  status: document.getElementById('status'),
  freshness: document.getElementById('freshness'),
  inspector: document.getElementById('inspector'),
  strip: document.getElementById('strip'),
  hover: document.getElementById('hover'),
  systemNote: document.getElementById('system-note'),
  tooltip: document.getElementById('tooltip'),
  graphEmpty: document.getElementById('graph-empty'),
  graphEmptyClear: document.getElementById('graph-empty-clear'),
  graphLoading: document.getElementById('graph-loading'),
  zoomIn: document.getElementById('zoom-in'),
  zoomOut: document.getElementById('zoom-out'),
  zoomFit: document.getElementById('zoom-fit'),
  tbFocus: document.getElementById('tb-focus'),
  tbImpact: document.getElementById('tb-impact'),
  tbOutside: document.getElementById('tb-outside'),
  tbUnits: document.getElementById('tb-units'),
  tbPath: document.getElementById('tb-path'),
  tbBoundaries: document.getElementById('tb-boundaries'),
  tbCalls: document.getElementById('tb-calls'),
  tbCoChange: document.getElementById('tb-cochange'),
  tbLabels: document.getElementById('tb-labels'),
  tbLoc: document.getElementById('tb-loc'),
  tbTimeline: document.getElementById('tb-timeline'),
  tbReview: document.getElementById('tb-review'),
  tbRisk: document.getElementById('tb-risk'),
  tbBranches: document.getElementById('tb-branches'),
  tbClear: document.getElementById('tb-clear'),
  tbOverflow: document.getElementById('tb-overflow'),
  tbOverflowMenu: document.getElementById('tb-overflow-menu'),
  graphToolbar: document.querySelector('.graph-toolbar'),
  groupCount: document.getElementById('group-count'),
  tbDelegateGroup: document.getElementById('tb-delegate-group'),
  timelinePanel: document.getElementById('timeline-panel'),
  branchesPanel: document.getElementById('branches-panel'),
  narrationPanel: document.getElementById('narration-panel'),
  folderDialog: document.getElementById('folder-dialog'),
  folderPath: document.getElementById('folder-path'),
  folderNote: document.getElementById('folder-note'),
  folderList: document.getElementById('folder-list'),
  folderUp: document.getElementById('folder-up'),
  folderUse: document.getElementById('folder-use'),
  folderCancel: document.getElementById('folder-cancel'),
  forget: document.getElementById('forget'),
  memberView: document.getElementById('member-view'),
  graphHint: document.getElementById('graph-hint'),
  shortcuts: document.getElementById('shortcuts'),
  settingsToggle: document.getElementById('settings-toggle'),
  settingsPanel: document.getElementById('settings-panel'),
  workspacePanel: document.getElementById('workspace-panel'),
  passportPanel: document.getElementById('passport-panel'),
  routePanel: document.getElementById('route-panel'),
  blocksPanel: document.getElementById('blocks-panel'),
  sourcePanel: document.getElementById('source-panel'),
  screenTabGraph: document.getElementById('screen-tab-graph'),
  screenTabTerminal: document.getElementById('screen-tab-terminal'),
  screenTabReview: document.getElementById('screen-tab-review'),
  screenTabHistory: document.getElementById('screen-tab-history'),
  graphScreen: document.getElementById('graph-screen'),
  terminalScreen: document.getElementById('terminal-screen'),
  terminalContainer: document.getElementById('terminal-container'),
  reviewScreen: document.getElementById('review-screen'),
  reviewScreenBody: document.getElementById('review-screen-body'),
  reviewScreenRefresh: document.getElementById('review-screen-refresh'),
  reviewScreenPending: document.getElementById('review-screen-pending'),
  historyScreen: document.getElementById('history-screen'),
  historyScreenBody: document.getElementById('history-screen-body'),
  historyScreenRefresh: document.getElementById('history-screen-refresh'),
};
/** Module Passport selections, oldest first, so Back can step down to one. */
let passportHistory = [];
/** True while Back is re-selecting, so the step it makes is not itself pushed. */
let passportGoingBack = false;

let browsedFolder = null;

async function request(path) {
  const response = await fetch(`${API_PATH}${path}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json();
}

Object.assign(app, { store, state, memberUI, view, elements, request });

/*
 * Feature controllers. Each takes `app`, reads shared state from it, and reaches other
 * features through it (`app.git.showReview(…)`) at call time, so creation order is free.
 */
// <core-actions>
Object.assign(app, {
  applyClientPrefs,
  loadCatalogue,
  refreshDock,
  request,
  scan,
  selectNode,
  setScreen,
  viewDiff,
});
// </core-actions>

// <controllers>
app.prefs = createViewPrefs(app);
app.runtime = createRuntimeReadout(app);
app.url = createUrlState(app);
app.narration = createNarrationController(app);
app.memberMap = createMemberMapController(app);
app.git = createGitController(app);
app.settings = createSettingsController(app);
app.panels = createRepositoryPanels(app);
app.lenses = createLensController(app);
// </controllers>

/** The freshness badge reads `/status` and rebuilds the map through a cache bypass. */
const freshness = createFreshnessBadge(elements.freshness, {
  request,
  onRebuild: () => scan({ refresh: true }),
  repository: () => state.repository,
});

async function loadCatalogue() {
  const catalogue = await request('/repositories');
  renderRepositoryOptions(catalogue.repositories, catalogue.active);
}

/** Rebuild the repository selector from the known list, selecting the active one. */
function renderRepositoryOptions(repositories, active) {
  elements.repository.replaceChildren(
    ...repositories.map((entry) => {
      const option = document.createElement('option');
      option.value = entry.root;
      option.textContent = entry.name;
      return option;
    }),
  );
  if (repositories.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No repositories';
    option.disabled = true;
    elements.repository.append(option);
  }
  const chosen = active ?? repositories[0]?.root ?? null;
  if (chosen) {
    elements.repository.value = chosen;
  }
  state.repository = elements.repository.value || null;
  elements.forget.disabled = !state.repository;
}

/** Remember a repository server-side so it is offered again after a restart. */
async function rememberRepository(root) {
  const response = await fetch(`${API_PATH}/repositories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Could not remember ${root}`);
  }
  return response.json();
}

/**
 * Refresh adds `refresh=1` — a server cache bypass, not merely a repaint. Every async
 * completion checks its captured generation before touching the DOM, so a slow response
 * for an old repository cannot overwrite the current view.
 */
async function scan({ refresh = false } = {}) {
  const generation = ++app.scanGeneration;
  elements.status.textContent = 'Scanning…';
  if (elements.graphLoading) elements.graphLoading.hidden = false;
  if (elements.graphEmpty) elements.graphEmpty.hidden = true;
  hideTooltip();
  app.memberMap.closeMemberMap();

  try {
    const model = await request(`/graph${buildGraphQuery(state, { refresh })}`);
    if (generation !== app.scanGeneration) {
      return;
    }
    app.current = model;
    // L19: with one build unit there is no L0 worth drawing, so open it at its layers. The
    // flag keeps a later Escape from bouncing straight back into the unit.
    if (
      state.mode === 'system' &&
      !model.systemUnit &&
      model.systemSingleUnit &&
      !state.systemAutoOpened
    ) {
      state.systemAutoOpened = true;
      openUnit(model.systemSingleUnit);
      return;
    }
    const restoreFile = state.mode === 'system' ? state.unitFile : null;
    app.selected = null;
    app.selectedEdgeId = null;
    app.git.clearReviewMarks();
    state.renderedGeneration = generation;
    if (model.systemUnit) {
      state.systemUnitLabel = model.systemUnitName ?? state.systemUnit;
    } else if (state.mode === 'system') {
      // A drill-down the server could not resolve (or an L0 response) leaves no open unit.
      state.systemUnit = null;
      state.systemUnitLabel = null;
      state.unitFile = null;
    }
    store.set('ui', { node: null });
    view.render(model);
    view.focusFile(null);
    applyFilterToView();
    app.lenses.applyTierLens();
    app.lenses.applyLocLens();
    app.lenses.applyEdgeKindLens();
    app.lenses.applyCoChangeLens();
    renderLegend(elements.legend, model, { locLens: state.mode === 'file' && state.locLens });
    renderTestsStrip(elements.strip, mapCounts(model), applyStripFilter, state.filter);
    const summary = renderDiagnostics(elements.diagnostics, model, {
      renderer: rendererName(),
      shown: view.cy.nodes().length,
    });
    // Keep the per-graph half of the runtime line, so the live perf fields can be appended
    // without losing the cache/renderer/shown facts the panel just wrote.
    app.runtime.setRuntimeBase(elements.diagnostics.querySelector('[data-role="runtime"]')?.textContent ?? '');
    app.runtime.refreshRuntimeReadout();
    updateDiagnosticsBadge(summary);
    renderBreadcrumb(elements.breadcrumb, state, (prefix) => {
      if (state.mode === 'system') {
        if (!prefix) closeUnit();
        return;
      }
      state.prefix = prefix;
      scan();
    });
    updateOutsideButton();
    applyModeChrome();
    updateUnitsButton();
    app.lenses.updateEdgeKindButton();
    app.lenses.updateCoChangeButton();
    app.lenses.updateLabelsButton();
    updateFocusButton();
    elements.inspector.hidden = true;
    elements.status.textContent = graphSummary(model);
    updateStatusbar(model);
    void freshness.refresh({ repository: state.repository });
    if (elements.graphLoading) elements.graphLoading.hidden = true;
    updateEmptyState();
    updateSystemNote(model);
    view.resize();
    fit(view.cy);
    if (restoreFile && model.systemUnit && (model.nodes ?? []).some((node) => node.id === restoreFile)) {
      // A toggle (e.g. outside links) refetches; keep the file it acted on selected.
      if (generation === app.scanGeneration) {
        selectNode(restoreFile);
      }
    }
    if (shouldShowHint()) {
      elements.graphHint.hidden = false;
    }
    if (state.overlay !== 'none') {
      await app.lenses.applyOverlay(generation);
    } else if (state.tier === 'off') {
      renderOverlayPanel(elements.overlayPanel, '', null);
    }
    if (state.mode === 'system' && !model.systemUnit && (model.unitCards?.length ?? 0) > 0) {
      app.lenses.enrichUnitCards(generation);
    }
    refreshDock();
  } catch (error) {
    if (generation !== app.scanGeneration) {
      return;
    }
    if (elements.graphLoading) elements.graphLoading.hidden = true;
    elements.status.textContent = `Error: ${error.message}`;
  }
}

function updateDiagnosticsBadge(summary) {
  if (!elements.diagnosticsBadge) return;
  const count = summary?.diagnostics ?? 0;
  elements.diagnosticsBadge.hidden = count === 0;
  elements.diagnosticsBadge.textContent = count > 99 ? '99+' : String(count);
  elements.diagnosticsBadge.classList.toggle('has-errors', count > 0);
}

/** The renderer actually in use, not merely the one the browser could support. */
function rendererName() {
  return view.capabilities?.renderer ?? 'canvas';
}

function updateStatusbar(model) {
  if (elements.statusbarLegend && model) {
    const kinds = [...new Set((model.nodes ?? []).map((n) => n.kind))].join(' · ');
    elements.statusbarLegend.textContent = kinds || '';
  }
}

/**
 * First-run prompt. Shown once per browser, and only until the operator does something:
 * it says what to click, then gets out of the way.
 */
const HINT_SEEN_KEY = 'strabo.hint.seen';

function shouldShowHint() {
  try {
    return window.localStorage.getItem(HINT_SEEN_KEY) !== '1';
  } catch {
    return true;
  }
}

function dismissHint() {
  if (elements.graphHint) {
    elements.graphHint.hidden = true;
  }
  try {
    window.localStorage.setItem(HINT_SEEN_KEY, '1');
  } catch {
    // Storage is optional; the hint simply reappears next session.
  }
}

function updateEmptyState() {
  if (!elements.graphEmpty || !app.current) return;
  const visible = view.cy.nodes().filter((n) => !n.hasClass('filtered-out')).length;
  const filtering = state.filter.trim().length > 0;
  elements.graphEmpty.hidden = !(filtering && visible === 0);
}

function updateFilterChrome(matchedCount, totalCount) {
  if (elements.filterClear) elements.filterClear.hidden = state.filter.length === 0;
  if (elements.filterCount) {
    if (!state.filter) {
      elements.filterCount.hidden = true;
    } else {
      elements.filterCount.hidden = false;
      elements.filterCount.textContent = `${matchedCount}/${totalCount}`;
    }
  }
}

function applyFilterToView() {
  if (!app.current) return;
  const ids = filterNodes(app.current, state.filter);
  view.filter(ids);
  updateFilterChrome(ids.length, app.current.nodes.length);
  updateEmptyState();
  if (app.current) {
    renderTestsStrip(elements.strip, mapCounts(app.current), applyStripFilter, state.filter);
  }
}

function selectNode(id) {
  if (!app.current) {
    return;
  }
  dismissHint();

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
    ...(isFileNode(id) ? { onViewSource: (target) => viewSource(target) } : {}),
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
          onShowOutside: () => toggleOutsideLinks(),
          onExpandUnit: (unit) => toggleExpandedUnit(unit),
        }
      : {}),
  });
  if (!app.current?.system) {
    loadMembers(id);
  }
  refreshDock();
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
  refreshDock();
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

// One subscription decides what a change redraws; handlers no longer call a render by hand.
store.subscribe((_, changed) => {
  if (changed.member) {
    app.memberMap.renderMemberMapView();
  }
  app.url.syncUrl();
});

document.addEventListener('keydown', (event) => {
  const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '');
  const screen = store.get().ui.screen;
  const onGraph = screen === 'graph';
  // Escape leaves a full-screen Review or History tab and returns to the map. The Terminal
  // screen keeps Escape for its own widgets (switcher, menus).
  if (event.key === 'Escape' && (screen === 'review' || screen === 'history') && !inField) {
    event.preventDefault();
    setScreen('graph');
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
      setScreen('terminal');
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
      setScreen('terminal');
      // The presets menu lives in the screen; if it exposes no opener, the screen is still shown.
      app.terminalScreen?.openPresetMenu?.();
      return;
    }
  }
  if (event.key === 'Escape') {
    closeOverflowMenu();
    if (!elements.memberView.hidden) {
      app.memberMap.closeMemberMap();
      return;
    }
    if (state.filter && !inField) {
      state.filter = '';
      elements.filter.value = '';
      applyFilterToView();
      return;
    }
    // Escape inside an open unit goes back to the L0 unit map.
    if (state.mode === 'system' && state.systemUnit && !inField) {
      closeUnit();
      return;
    }
    if (!inField) clearSelection();
    return;
  }
  if (event.key === 'Enter' && !inField && state.mode === 'system' && app.selected) {
    const node = app.current?.nodes.find((candidate) => candidate.id === app.selected);
    if (node && !node.systemUnit) {
      // Enter opens the focused unit, matching a double-click.
      event.preventDefault();
      openUnit(app.selected);
      return;
    }
  }
  if (event.key === '?' && !inField) {
    event.preventDefault();
    toggleShortcuts();
    return;
  }
  if (inField || !elements.memberView.hidden || !onGraph) return;
  const key = event.key.toLowerCase();
  if (key === 'f' && app.selected) focus(view.cy, app.selected);
  else if (key === 'i') elements.tbImpact.click();
  else if (key === 'o' && state.mode === 'system' && state.systemUnit) elements.tbOutside.click();
  else if (key === 'u' && state.mode === 'system' && state.systemUnit) closeUnit();
  else if (key === 'p') elements.tbPath.click();
  else if (key === 'b') elements.tbBoundaries.click();
  else if (key === 'c' && state.mode === 'file') elements.tbCalls?.click();
  else if (key === 'h' && state.mode === 'file') elements.tbCoChange?.click();
  else if (key === 'l' && state.mode === 'file') elements.tbLabels?.click();
  else if (key === 'z' && state.mode === 'file') elements.tbLoc?.click();
  else if (key === 's' && app.selected && isFileNode(app.selected)) viewSource(app.selected);
  else if (key === 't') elements.tbTimeline.click();
  else if (key === 'r') elements.tbReview.click();
  else if (key === 'v') elements.tbRisk.click();
  else if (key === 'n') elements.tbBranches.click();
  else if (key === 'g' && app.groupSelection.length >= 2) elements.tbDelegateGroup.click();
});

function applyStripFilter(filter) {
  state.filter = filter;
  elements.filter.value = filter;
  applyFilterToView();
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
    refreshDock();
    return;
  }
  app.selectedEdgeId = edgeId;
  const evidence = edgeEvidenceFor(app.current, edgeId);
  renderEdgeEvidence(elements.edgePanel, evidence, {
    onSelect: (id) => selectNode(id),
    onTrace: (from, to) => tracePath(from, to),
    ...(evidence && isFileNode(evidence.source)
      ? { onViewSource: (file, line) => viewSource(file, { line }) }
      : {}),
    onClear: () => {
      view.clearEdge();
      app.selectedEdgeId = null;
      renderEdgeEvidence(elements.edgePanel, null);
      refreshDock();
    },
  });
  if (evidence) {
    elements.hover.textContent = `${evidence.source} → ${evidence.target} · ${evidence.kind} · L${evidence.line ?? '?'} ${evidence.specifier ?? ''}`;
  }
  refreshDock();
}

function onSelect(id) {
  selectNode(id);
}

/** Folder selection is a server-side browse bounded by the configured scan ceiling. */
async function loadFolder(path) {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  const result = await request(`/browse${query}`);
  browsedFolder = result;
  const location = folderLocation(result);
  elements.folderPath.textContent = result.path;
  elements.folderNote.textContent = location.note;
  elements.folderNote.classList.toggle('at-ceiling', location.atCeiling);
  elements.folderUp.disabled = location.atCeiling;
  elements.folderUp.title = location.upLabel;
  elements.folderUp.dataset.parent = result.parent ?? '';
  renderFolderList(elements.folderList, result, (next) => {
    loadFolder(next).catch((error) => {
      elements.status.textContent = `Error: ${error.message}`;
    });
  });
}

function openFolderDialog() {
  browsedFolder = null;
  elements.folderDialog.showModal();
  loadFolder(state.repository ?? undefined).catch((error) => {
    elements.status.textContent = `Error: ${error.message}`;
  });
}

/** Point the app at a chosen repository, remembering it as the active one. */
async function useRepository(path) {
  app.prefs.writeViewPrefs();
  state.repository = path;
  state.prefix = '';
  state.filter = '';
  elements.filter.value = '';

  try {
    await rememberRepository(path);
    const catalogue = await request('/repositories');
    renderRepositoryOptions(catalogue.repositories, path);
  } catch (error) {
    elements.status.textContent = `Error: ${error.message}`;
    return;
  }
  app.prefs.applyViewPrefs();
  scan();
}

/** Forget the selected repository; it stays usable until the page reloads. */
async function forgetRepository() {
  const root = state.repository;
  if (!root) {
    return;
  }
  const response = await fetch(`${API_PATH}/repositories?root=${encodeURIComponent(root)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    elements.status.textContent = 'Error: could not forget the repository.';
    return;
  }
  const catalogue = await request('/repositories');
  renderRepositoryOptions(catalogue.repositories, catalogue.active);
  if (state.repository !== root) {
    scan();
  }
}

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
  scan();
}

/** Leave a unit back to the L0 unit map. */
function closeUnit() {
  state.systemUnit = null;
  state.systemUnitLabel = null;
  state.unitFile = null;
  state.showOutside = false;
  state.expandedUnits = [];
  scan();
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
  scan();
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
  scan();
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
 * Show only the toolbar controls the current mode can act on (L20).
 *
 * Tier and Review are per-file lenses, and Impact / Path / Boundaries are file-map tools; a
 * unit map has none of those, so leaving them up would only invite a click that does nothing.
 * The mode lives on the body so `styles.css` owns the hiding, keeping layout out of the JS.
 */
function applyModeChrome() {
  document.body.dataset.mode = state.mode;
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
      if (!id.endsWith('#support')) viewSource(id);
      return;
    }
    openUnit(id);
    return;
  }
  if (state.mode === 'block') {
    state.prefix = id;
    state.filter = '';
    elements.filter.value = '';
    scan();
    return;
  }
  viewSource(id);
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

/* --------------------------------------------------------------- File viewer */

/** The viewer's current target: the file, the two sides, and what has been fetched. */
let sourceView = null;

/** True when `id` is a file the viewer can read, not a directory block, unit, or shelf. */
function isFileNode(id) {
  const node = (app.current?.nodes ?? []).find((candidate) => candidate.id === id);
  if (!node || node.kind === 'unit' || node.kind === 'shelf') {
    return false;
  }
  return state.mode === 'file' || Boolean(node.systemUnit && !id.endsWith('#support'));
}

/** Open the viewer on a file, at `line` when given. A `diffSpec` opens it on the change. */
function viewSource(file, options = {}) {
  sourceView = {
    file,
    ref: options.ref ?? null,
    line: options.line ?? null,
    status: options.status ?? null,
    diffSpec: options.diffSpec ?? null,
    hasDiff: Boolean(options.diffSpec),
    mode: options.diffSpec ? 'diff' : 'content',
    loading: true,
    error: null,
    content: null,
    diff: null,
  };
  app.floatingWindows.find((controller) => controller.key === 'source')?.open();
  loadSource(sourceView.mode).catch(() => {});
}

/** Open the viewer straight on a change; `spec` names the two sides for `/diff`. */
function viewDiff(file, spec, options = {}) {
  viewSource(file, { ...options, diffSpec: spec });
}

/** Fetch the side the viewer is showing; a late response is dropped if the target moved. */
async function loadSource(mode) {
  const target = sourceView;
  if (!target) {
    return;
  }
  target.mode = mode;
  target.loading = true;
  target.error = null;
  sourceRender();
  const query = new URLSearchParams({ file: target.file });
  if (state.repository) {
    query.set('repository', state.repository);
  }
  try {
    if (mode === 'diff') {
      for (const [key, value] of Object.entries(target.diffSpec ?? {})) {
        query.set(key, String(value));
      }
      const body = await request(`/diff?${query.toString()}`);
      if (sourceView !== target) return;
      if (body.available === false) target.error = body.detail ?? body.reason;
      else target.diff = body.diff;
    } else {
      if (target.ref) query.set('ref', target.ref);
      const body = await request(`/source?${query.toString()}`);
      if (sourceView !== target) return;
      target.content = body.content;
    }
  } catch (error) {
    if (sourceView !== target) return;
    target.error = error.message;
  } finally {
    if (sourceView === target) {
      target.loading = false;
      sourceRender();
    }
  }
}

function sourceRender() {
  if (!sourceView) {
    return;
  }
  renderSource(elements.sourcePanel, sourceView, {
    onClose: () => app.floatingWindows.find((controller) => controller.key === 'source')?.close(),
    onShowFile: sourceView.hasDiff && sourceView.mode === 'diff' ? () => loadSource('content') : null,
    onShowDiff: sourceView.hasDiff && sourceView.mode === 'content' ? () => loadSource('diff') : null,
  });
}

/** Whether the viewer has a file to reopen. */
function hasSourceTarget() {
  return Boolean(sourceView);
}

/** Clear the panel but keep the target, so the dock chip can reopen the last file. */
function closeSource() {
  elements.sourcePanel.hidden = true;
  elements.sourcePanel.replaceChildren();
}

/**
 * The Terminal's `openSourceAt` hook: show a repo-relative file at a line from a clicked
 * `path:line` citation. The viewer reads by path directly (`/source?file=`), so a file that
 * is not a node on the current map still opens; when it is a node, the map selection follows
 * the citation too. The viewer has no load callback, so poll briefly for the marked row.
 */
function openSourceAt(file, line) {
  const target = typeof file === 'string' ? file.replace(/\\/g, '/') : '';
  if (!target) {
    return;
  }
  setScreen('graph');
  const node = (app.current?.nodes ?? []).find((candidate) => candidate.id === target);
  if (node) {
    selectNode(node.id);
  }
  const lineNumber = Number.isInteger(line) && line > 0 ? line : null;
  viewSource(node?.id ?? target, { line: lineNumber });
  if (lineNumber) {
    revealSourceLine();
  }
}

/** Bring the marked line into view once the async source fetch has rendered it. */
function revealSourceLine(attempt = 0) {
  const marked = elements.sourcePanel?.querySelector('.src-mark');
  if (marked) {
    marked.scrollIntoView?.({ block: 'center' });
    return;
  }
  if (attempt < 20) {
    setTimeout(() => revealSourceLine(attempt + 1), 50);
  }
}

/** Whether an id names a node on the current map, so a control directive cannot point elsewhere. */
function isMappedNode(id) {
  return Boolean(id) && (app.current?.nodes ?? []).some((candidate) => candidate.id === id);
}

/**
 * The Terminal's `onControl` hook: a `::strabo::` marker printed by the `strabo` shim on a
 * session's PATH becomes a read-only map action. The verbs are a fixed set and anything
 * unknown is ignored; node and file arguments are matched against the current map, so a
 * directive can never reach a path the source viewer would not already allow.
 */
function handleTerminalControl(directive) {
  const verb = directive?.verb;
  const args = Array.isArray(directive?.args) ? directive.args : [];
  switch (verb) {
    case 'focus': {
      const id = args[0];
      if (isMappedNode(id)) {
        setScreen('graph');
        selectNode(id);
      }
      return;
    }
    case 'open': {
      const file = args[0];
      const line = Number.parseInt(args[1] ?? '', 10);
      if (file) {
        openSourceAt(file, Number.isInteger(line) ? line : null);
      }
      return;
    }
    case 'highlight': {
      const ids = args.filter(isMappedNode);
      if (ids.length > 0) {
        setScreen('graph');
        view.highlight(ids);
      }
      return;
    }
    case 'review': {
      setScreen('graph');
      const ref = args[0];
      const pending = ref
        ? app.git.showReview(`?base=${encodeURIComponent(ref)}`, { hash: ref })
        : app.git.showReview('');
      Promise.resolve(pending).catch((error) => {
        showToast(`Review failed (${error.message}).`);
      });
      return;
    }
    case 'note': {
      const message = args.join(' ').trim();
      if (message) {
        showToast(message);
      }
      return;
    }
    case 'screen': {
      const target = args[0];
      if (target === 'graph' || target === 'terminal') {
        setScreen(target);
      }
      return;
    }
    default:
      return;
  }
}

elements.repository.addEventListener('change', () => {
  const root = elements.repository.value;
  if (!root) {
    return;
  }
  // Save outgoing view settings before switching, then restore the new repo's.
  app.prefs.writeViewPrefs();
  state.repository = root;
  state.prefix = '';
  state.filter = '';
  elements.filter.value = '';
  elements.forget.disabled = false;
  app.prefs.applyViewPrefs();
  rememberRepository(root)
    .then(() => scan())
    .catch((error) => {
      elements.status.textContent = `Error: ${error.message}`;
    });
});
elements.forget.addEventListener('click', () => {
  forgetRepository().catch((error) => {
    elements.status.textContent = `Error: ${error.message}`;
  });
});
elements.detail.addEventListener('change', () => {
  state.mode = elements.detail.value;
  state.prefix = '';
  // Entering System mode is a fresh visit: a one-unit repository auto-opens again (L19).
  state.systemAutoOpened = false;
  if (state.mode !== 'system') {
    state.systemUnit = null;
    state.systemUnitLabel = null;
    state.unitFile = null;
    state.showOutside = false;
    state.expandedUnits = [];
  }
  app.prefs.writeViewPrefs();
  scan();
});
elements.refresh.addEventListener('click', () => scan({ refresh: true }));
elements.filter.addEventListener('input', () => {
  dismissHint();
  state.filter = elements.filter.value;
  applyFilterToView();
  app.prefs.schedulePrefsSave();
});
if (elements.filterClear) {
  elements.filterClear.addEventListener('click', () => {
    state.filter = '';
    elements.filter.value = '';
    applyFilterToView();
    app.prefs.writeViewPrefs();
    elements.filter.focus();
  });
}
if (elements.graphEmptyClear) {
  elements.graphEmptyClear.addEventListener('click', () => {
    state.filter = '';
    elements.filter.value = '';
    applyFilterToView();
    app.prefs.writeViewPrefs();
  });
}
if (elements.zoomIn) elements.zoomIn.addEventListener('click', () => zoomIn(view.cy));
if (elements.zoomOut) elements.zoomOut.addEventListener('click', () => zoomOut(view.cy));
if (elements.zoomFit) elements.zoomFit.addEventListener('click', () => fit(view.cy));
elements.diagnosticsToggle.addEventListener('click', () => {
  const hidden = elements.diagnostics.hidden;
  elements.diagnostics.hidden = !hidden;
  elements.diagnosticsToggle.setAttribute('aria-expanded', String(hidden));
  if (hidden) app.runtime.startRuntimeReadout();
  else app.runtime.stopRuntimeReadout();
});
elements.browse.addEventListener('click', openFolderDialog);
document.getElementById('graph')?.addEventListener('pointerdown', dismissHint, { capture: true });
elements.folderCancel.addEventListener('click', () => elements.folderDialog.close());
elements.folderUp.addEventListener('click', () => {
  const parent = elements.folderUp.dataset.parent;
  if (parent) {
    loadFolder(parent).catch((error) => {
      elements.status.textContent = `Error: ${error.message}`;
    });
  }
});
elements.folderUse.addEventListener('click', () => {
  if (browsedFolder) {
    elements.folderDialog.close();
    useRepository(browsedFolder.path).catch((error) => {
      elements.status.textContent = `Error: ${error.message}`;
    });
  }
});

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
if (elements.tbOutside) {
  elements.tbOutside.addEventListener('click', () => toggleOutsideLinks());
}
if (elements.tbUnits) {
  elements.tbUnits.addEventListener('click', () => closeUnit());
}
elements.tbPath.addEventListener('click', () => {
  state.pathMode = !state.pathMode;
  state.pathFrom = null;
  elements.tbPath.classList.toggle('active', state.pathMode);
  elements.hover.textContent = state.pathMode ? 'Path mode: select the start node.' : '';
});
elements.tbBoundaries.addEventListener('click', () => {
  state.mode = state.mode === 'block' ? 'file' : 'block';
  elements.detail.value = state.mode;
  state.prefix = '';
  scan();
});
elements.tbClear.addEventListener('click', clearSelection);

/* ------------------------------------------- Overflow menu + shortcuts */

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

/* ------------------------------------------- Header menus: repository + view */

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

/** Show the keyboard cheat-sheet in its own floating window. Declared with `function` so
 * the key handler above can call it before `floatingWindows` is assigned. */
function toggleShortcuts() {
  app.floatingWindows?.find?.((controller) => controller.key === 'shortcuts')?.toggle();
}

/* ------------------------------------------- Agent delegation (right-click) */

/** Recorded facts for a node, from the passport the scan computed. */
function nodeDelegateTarget(id) {
  const passport = app.current ? passportFor(app.current, id) : null;
  const node = app.current?.nodes.find((candidate) => candidate.id === id);
  const evidence = [];
  if (passport) {
    for (const metric of passport.metrics) {
      evidence.push(`${metric.label}: ${metric.value}`);
    }
    for (const entry of passport.imports.slice(0, 8)) {
      evidence.push(`imports ${entry.id} (L${entry.line ?? '?'} ${entry.specifier ?? ''})`.replace(' )', ')'));
    }
    for (const entry of passport.usedBy.slice(0, 8)) {
      evidence.push(`imported by ${entry.id} (L${entry.line ?? '?'} ${entry.specifier ?? ''})`.replace(' )', ')'));
    }
  } else {
    evidence.push('Node is not in the current graph (it may be filtered out).');
  }
  return { kind: 'node', id, label: node?.label ?? id, evidence };
}

/* ------------------------------------------- Group selection (⌘/ctrl-click, shift-drag) */

/** Combine every selected node's passport into one delegation target. */
function groupDelegateTarget() {
  const items = app.groupSelection.map((id) => nodeDelegateTarget(id));
  return { kind: 'group', label: `${items.length} file(s)`, items };
}

/** Reflect cytoscape's native selection in the toolbar chip and delegate button. */
function updateGroupUI(ids) {
  app.groupSelection = ids ?? [];
  const count = app.groupSelection.length;
  // A plain click already selects its one node in cytoscape's terms — that's not a
  // "group" a person meant to build, so the toolbar stays quiet until there are two.
  const active = count >= 2;
  elements.groupCount.hidden = !active;
  elements.groupCount.textContent = active ? `${count} selected` : '';
  elements.tbDelegateGroup.hidden = !active;
}

view.onGroupChange(updateGroupUI);

elements.tbDelegateGroup.addEventListener('click', () => {
  // Anchor to the button itself rather than the event's coordinates: the keyboard
  // shortcut (G) dispatches a synthetic click with no real pointer position.
  const rect = elements.tbDelegateGroup.getBoundingClientRect();
  openDelegateMenu(groupDelegateTarget(), rect.left, rect.bottom + 4);
});

/** Recorded facts for an edge, from the evidence the scanner recorded. */
function edgeDelegateTarget(edgeId) {
  const evidence = app.current ? edgeEvidenceFor(app.current, edgeId) : null;
  if (!evidence) {
    return null;
  }
  return {
    kind: 'edge',
    id: edgeId,
    label: `${evidence.source} → ${evidence.target}`,
    evidence: [
      `relationship: ${evidence.kind}`,
      `specifier: ${evidence.specifier ?? 'not recorded'}`,
      `line: ${evidence.line ?? 'not recorded'}`,
      `resolution: ${evidence.resolutionLabel}`,
    ],
  };
}

/** A diagnostic line has the controlled form `file:line message`. */
function diagnosticDelegateTarget(text) {
  const match = /^(.+):(\d+)\s?(.*)$/.exec(String(text ?? '').trim());
  return {
    kind: 'diagnostic',
    id: match ? `${match[1]}:${match[2]}` : String(text ?? 'diagnostic'),
    label: String(text ?? 'diagnostic').slice(0, 120),
    detail: String(text ?? ''),
    evidence: match
      ? [`file: ${match[1]}`, `line: ${match[2]}`, `message: ${match[3] || '—'}`]
      : [String(text ?? '')],
  };
}

/**
 * Recorded facts for the currently shown Git review: which files changed, by how much,
 * and what depends on them — the same evidence rendered in the panel, nothing more.
 */
function reviewDelegateTarget(result) {
  const label =
    result.kind === 'branch' && result.branch
      ? `branch ${result.branch.branch} against ${result.branch.base}`
      : result.kind === 'commit' && result.commit
        ? `commit ${result.commit.shortHash}`
        : 'pending working tree';
  const evidence = [];
  if (result.branch) {
    const branch = result.branch;
    evidence.push(
      `branch: ${branch.branch} is ${branch.ahead} commit(s) ahead of ${branch.base} and ${branch.behind} behind; merge base ${branch.mergeBase}`,
    );
    if (branch.conflicts.available) {
      evidence.push(
        branch.conflicts.clean
          ? `trial merge into ${branch.base}: clean`
          : `trial merge into ${branch.base}: conflicts in ${branch.conflicts.paths.join(', ')}`,
      );
    }
    for (const entry of branch.movedUnderneath.slice(0, 30)) {
      evidence.push(`changed on ${branch.base} since the merge base, imported by ${entry.via}: ${entry.id}`);
    }
  } else if (result.commit) {
    evidence.push(`commit: ${result.commit.shortHash} · ${result.commit.author} · ${result.commit.subject}`);
  }
  for (const file of result.files ?? []) {
    const counts =
      file.insertions === null || file.deletions === null
        ? 'line counts unavailable'
        : `+${file.insertions} -${file.deletions}`;
    evidence.push(`${file.status} (${file.group}): ${file.path} — ${counts}${file.inGraph ? '' : ' (outside scanned graph)'}`);
  }
  const affected = (result.impact?.affected ?? []).filter((entry) => entry.distance > 0);
  for (const entry of affected.slice(0, 30)) {
    evidence.push(`potentially affected: ${entry.id} (distance ${entry.distance})`);
  }
  if (affected.length > 30) {
    evidence.push(`…and ${affected.length - 30} more affected file(s) (truncated).`);
  }
  return { kind: 'review', label, evidence };
}

function commitDelegateTarget(button) {
  const meta = button.parentElement?.querySelector('.evidence')?.textContent ?? '';
  return {
    kind: 'commit',
    id: button.dataset.hash ?? button.textContent,
    label: button.textContent.trim().slice(0, 120),
    detail: meta ? `${button.textContent.trim()} (${meta.trim()})` : button.textContent.trim(),
    evidence: meta ? [`commit: ${button.textContent.trim()}`, `meta: ${meta.trim()}`] : [],
  };
}

function memberDelegateTarget(card) {
  const name = card.dataset.member ?? 'member';
  const file = app.memberData?.file ?? app.selected;
  const facts = [...card.querySelectorAll('.card-signature, .card-tag, .card-metrics')]
    .map((part) => part.textContent.trim())
    .filter(Boolean);
  return {
    kind: 'member',
    id: file ? `${file}#${name}` : name,
    label: `${name} (${file ?? 'unknown file'})`,
    evidence: [`member: ${name}`, `file: ${file ?? 'unknown'}`, ...facts],
  };
}

function overlayDelegateTarget(item) {
  const heading = document.querySelector('#overlay-panel h3')?.textContent ?? 'Review overlay';
  return {
    kind: 'view',
    label: heading.trim().slice(0, 120),
    detail: item.dataset.delegateOverlayItem ?? item.textContent.trim(),
    evidence: [`overlay: ${heading.trim()}`, `item: ${(item.dataset.delegateOverlayItem ?? item.textContent).trim()}`],
  };
}

function viewDelegateTarget(detail) {
  return {
    kind: 'view',
    label: detail ?? graphSummary(app.current ?? { nodes: [], edges: [] }),
    detail: detail ?? undefined,
    evidence: [
      app.current ? graphSummary(app.current) : 'No scan loaded.',
      state.filter ? `active filter: ${state.filter}` : 'no active filter',
      state.overlay !== 'none' ? `active review: ${state.overlay}` : 'no active review overlay',
      state.mode === 'block'
        ? `directory view${state.prefix ? ` at ${state.prefix}` : ''}`
        : state.mode === 'system'
          ? 'system view'
          : 'file view',
    ],
  };
}

function fallbackDelegateTarget() {
  return app.selected ? nodeDelegateTarget(app.selected) : viewDelegateTarget();
}

function resolveDomDelegateTarget(node) {
  if (!node?.closest) {
    return null;
  }
  const byNode = node.closest('[data-delegate-node]');
  if (byNode?.dataset.delegateNode) {
    return nodeDelegateTarget(byNode.dataset.delegateNode);
  }
  const diagnostic = node.closest('[data-delegate-diagnostic]');
  if (diagnostic?.dataset.delegateDiagnostic) {
    return diagnosticDelegateTarget(diagnostic.dataset.delegateDiagnostic);
  }
  const commit = node.closest('#timeline-panel .commit');
  if (commit) {
    return commitDelegateTarget(commit);
  }
  const reviewPanel = node.closest('#review-panel');
  if (reviewPanel && app.currentReview?.available) {
    return reviewDelegateTarget(app.currentReview);
  }
  const overlayItem = node.closest('#overlay-panel [data-delegate-overlay-item]');
  if (overlayItem) {
    return overlayDelegateTarget(overlayItem);
  }
  const edgePanel = node.closest('#edge-panel');
  if (edgePanel && app.selectedEdgeId) {
    return edgeDelegateTarget(app.selectedEdgeId);
  }
  const card = node.closest('#member-view .member-card');
  if (card) {
    return memberDelegateTarget(card);
  }
  if (node.closest('#inspector') && app.selected) {
    return nodeDelegateTarget(app.selected);
  }
  const chip = node.closest('.strip-chip');
  if (chip) {
    return viewDelegateTarget(`filter: ${chip.dataset.filter || 'all'}`);
  }
  const crumb = node.closest('#breadcrumb .crumb');
  if (crumb) {
    return viewDelegateTarget(`directory: ${crumb.textContent.trim()}`);
  }
  return null;
}

/**
 * Seed an in-app agent session on the delegated item, after the prompt is reviewed.
 * The delegate module attaches the returned session through the registered opener.
 */
async function delegateToAgent(agent, target) {
  const repository = app.current?.repository ?? null;
  const prompt = buildAgentPrompt({ agent, repository, target });
  const title = (target.label ?? target.id ?? 'repository view').slice(0, 80);
  const reviewed = await showPromptReview({ agent, title, prompt });
  if (reviewed === null) {
    return;
  }
  try {
    const result = await launchAgent(agent, {
      repository: state.repository ?? repository?.root,
      target: { kind: target.kind, id: target.id, label: target.label },
      prompt: reviewed,
      title,
    });
    showToast(
      result?.sessionId
        ? `Opened ${agent} in the Terminal on ${title} — edit the prefilled task, then send.`
        : `Prepared ${agent} on ${title}.`,
    );
  } catch (error) {
    showToast(`Could not open an agent session (${error.message}).`, {
      label: 'Copy prompt',
      onClick: async () => {
        await copyText(reviewed);
        showToast('Prompt copied — paste it into your agent.');
      },
    });
  }
}

/** Drop every stored island move for the current repository and repaint the computed layout. */
function resetMapLayout() {
  view.resetIslandOffsets();
  writeIslandLayout(state.repository, {});
  // A re-render drops the visible set the filter published, so republish it.
  applyFilterToView();
  showToast('Map layout reset to the computed arrangement.');
}

/** A reset entry, offered only where a view actually has a moved layout to restore. */
function layoutMenuItems(target) {
  if (target?.kind !== 'view' || Object.keys(view.islandOffsets()).length === 0) {
    return [];
  }
  return [
    { label: '↺ Reset map layout', hint: 'computed positions', action: resetMapLayout },
    { separator: true },
  ];
}

/** Right-click menu for one delegated item: launch, or copy the prompt. */
function openDelegateMenu(target, x, y) {
  if (!target) {
    return;
  }
  const repository = app.current?.repository ?? null;
  const menuTitle = (target.label ?? target.id ?? 'repository view').slice(0, 80);
  const promptFor = (agent) => buildAgentPrompt({ agent, repository, target });
  showContextMenu({
    x,
    y,
    title: menuTitle,
    items: [
      ...app.narration.narrateMenuItems(target),
      ...layoutMenuItems(target),
      { label: '▶ Delegate to OpenCode', hint: 'opens agent session', action: () => delegateToAgent('opencode', target) },
      { label: '▶ Delegate to Claude', hint: 'opens agent session', action: () => delegateToAgent('claude', target) },
      { separator: true },
      {
        label: '⧉ Copy prompt',
        action: async () => {
          await copyText(promptFor('opencode'));
          showToast('Prompt copied — paste it into your agent.');
        },
      },
      ...(target.id
        ? [{
          label: '⧉ Copy path',
          action: async () => {
            await copyText(target.id);
            showToast('Path copied.');
          },
        }]
        : []),
      ...(Array.isArray(target.items) && target.items.length > 0
        ? [{
          label: '⧉ Copy paths',
          action: async () => {
            await copyText(target.items.map((entry) => entry.id ?? entry.label).join('\n'));
            showToast(`${target.items.length} path(s) copied.`);
          },
        }]
        : []),
    ],
  });
}

view.onContext((target, originalEvent) => {
  hideTooltip();
  const x = originalEvent?.clientX ?? window.innerWidth / 2;
  const y = originalEvent?.clientY ?? window.innerHeight / 2;
  // Right-clicking a node that's part of the current multi-selection acts on the whole
  // group, same as most desktop apps; right-clicking outside it targets just that node,
  // leaving the group selection as-is underneath.
  if (target.kind === 'node' && target.id && app.groupSelection.length >= 2 && app.groupSelection.includes(target.id)) {
    openDelegateMenu(groupDelegateTarget(), x, y);
  } else if (target.kind === 'node' && target.id) {
    openDelegateMenu(nodeDelegateTarget(target.id), x, y);
  } else if (target.kind === 'edge' && target.id) {
    openDelegateMenu(edgeDelegateTarget(target.id) ?? viewDelegateTarget('edge'), x, y);
  } else {
    openDelegateMenu(fallbackDelegateTarget(), x, y);
  }
});

document.addEventListener('contextmenu', (event) => {
  // Editable fields and dialogs keep the native menu (copy/paste, close).
  if (event.target.closest?.('input, select, textarea, [contenteditable="true"], dialog')) {
    return;
  }
  // The terminal owns its right-click menu (copy/paste); the delegate menu is noise there.
  if (event.target.closest?.('.terminal-screen')) {
    return;
  }
  // The canvas menu comes from cytoscape's cxttap; just suppress the browser one.
  if (event.target.closest?.('#graph')) {
    event.preventDefault();
    return;
  }
  // Everywhere else in the app shell, offer the delegate menu; outside it, stay native.
  if (!event.target.closest?.('.workspace, .statusbar, #member-view, #diagnostics, #breadcrumb, .toolbar')) {
    return;
  }
  // Read before anything else runs: opening the menu must not be able to disturb it.
  const selection = window.getSelection?.()?.toString().trim() ?? '';
  event.preventDefault();
  closeContextMenu();
  hideTooltip();
  const resolved = resolveDomDelegateTarget(event.target);
  openDelegateMenu(withSelection(resolved, selection), event.clientX, event.clientY);
});

/**
 * Add highlighted text to a delegation target. With no specific target under the cursor the
 * selection is the subject, and the fallback view or node becomes its context, rather than
 * the generic overview the menu would otherwise be titled with.
 */
function withSelection(resolved, selection) {
  if (!selection) {
    return resolved ?? fallbackDelegateTarget();
  }
  if (resolved) {
    return { ...resolved, selection };
  }
  const context = fallbackDelegateTarget();
  const excerpt = selection.replace(/\s+/g, ' ');
  return {
    kind: 'selection',
    label: `“${excerpt.length > 60 ? `${excerpt.slice(0, 60)}…` : excerpt}”`,
    evidence: context.evidence,
    selection,
  };
}

view.onSelect(onSelect);
view.onDrill(onDrill);
view.onEdge(selectEdge);

/**
 * The Terminal screen. Created once at bootstrap — like the graph, it lives for the whole
 * page session, so switching tabs only shows/hides it rather than tearing it down.
 *
 * The tab badge is built here rather than in `index.html` (owned elsewhere); it reuses the
 * diagnostics pill classes, so it needs no new CSS and reports running/failed sessions even
 * while the Graph screen is showing.
 */
const terminalBadge = document.createElement('span');
terminalBadge.id = 'terminal-badge';
terminalBadge.className = 'diag-badge';
terminalBadge.hidden = true;
elements.screenTabTerminal.append(terminalBadge);

/** Show a count of running sessions on the tab, reddened when any session has failed. */
function updateTerminalBadge(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const running = list.filter((session) => session?.status === 'running').length;
  const failed = list.filter(
    (session) => session?.status === 'exited' && (session.exitCode ?? 0) !== 0,
  ).length;
  const count = running + failed;
  terminalBadge.hidden = count === 0;
  terminalBadge.textContent = String(count);
  terminalBadge.classList.toggle('has-errors', failed > 0);
  terminalBadge.title = failed > 0 ? `${running} running, ${failed} failed` : `${running} running`;
}

/** The active repository as `{ name, root }` for a new terminal session. */
function resolveRepository() {
  const repository = app.current?.repository;
  const root = repository?.root ?? state.repository ?? null;
  const name = repository?.name ?? (root ? root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : null);
  return { name, root };
}

/** The Terminal's toast hook, accepting either a plain message or one carrying an action. */
function terminalToast(message, options = {}) {
  return showToast(message, options.action ?? null, { timeout: options.timeout ?? 6000 });
}

app.terminalScreen = initTerminalScreen(elements.terminalContainer, {
  openSourceAt,
  toast: terminalToast,
  onSessionsChanged: updateTerminalBadge,
  resolveRepository,
  closeTerminal: () => setScreen('graph'),
  onControl: handleTerminalControl,
});

// A delegated run is created server-side; this is how its session reaches the screen.
setDelegateSessionOpener((sessionId) => {
  setScreen('terminal');
  return app.terminalScreen?.openSession?.(sessionId);
});

function setScreen(screen) {
  store.set('ui', { screen });
  const showTerminalTab = screen === 'terminal';
  const showReviewTab = screen === 'review';
  const showHistoryTab = screen === 'history';
  const showGraphTab = !showTerminalTab && !showReviewTab && !showHistoryTab;
  elements.graphScreen.hidden = !showGraphTab;
  elements.terminalScreen.hidden = !showTerminalTab;
  if (elements.reviewScreen) elements.reviewScreen.hidden = !showReviewTab;
  if (elements.historyScreen) elements.historyScreen.hidden = !showHistoryTab;
  // Floating panels are position-fixed and live outside the graph screen, so hiding the graph
  // does not hide them: without this they sit on top of the Terminal, Review, and History
  // screens. The class hides them with the graph and reveals them again on return.
  document.body.classList.toggle('screen-off-graph', !showGraphTab);
  // A docked toolbar lives in the footer, outside the graph screen, so it does not hide with
  // the canvas. Mirror the screen state onto it while it is docked.
  if (elements.graphToolbar?.classList.contains('is-docked')) {
    elements.graphToolbar.hidden = !showGraphTab;
  }
  elements.screenTabGraph.setAttribute('aria-selected', String(showGraphTab));
  elements.screenTabTerminal.setAttribute('aria-selected', String(showTerminalTab));
  elements.screenTabReview?.setAttribute('aria-selected', String(showReviewTab));
  elements.screenTabHistory?.setAttribute('aria-selected', String(showHistoryTab));
  if (showTerminalTab) {
    app.terminalScreen.activate();
  } else if (showReviewTab) {
    app.git.openReviewScreen();
  } else if (showHistoryTab) {
    app.git.openHistoryScreen();
  }
}

elements.screenTabGraph.addEventListener('click', () => setScreen('graph'));
elements.screenTabTerminal.addEventListener('click', () => setScreen('terminal'));
elements.screenTabReview?.addEventListener('click', () => setScreen('review'));
elements.screenTabHistory?.addEventListener('click', () => setScreen('history'));

/**
 * Turn every auxiliary panel into a floating window. The panels keep their ids and
 * `hidden` semantics; these handlers only supply app-aware open/close so the dock can
 * restore a panel without desyncing overlay or selection state.
 */
app.floatingWindows = initFloatingWindows({
  dock: document.getElementById('float-dock'),
  panels: [
    {
      key: 'review',
      element: elements.reviewPanel,
      title: 'Review',
      dockLabel: 'Review',
      dock: false, // Review is a screen tab, and R toggles this panel
      width: 400,
      // The heading's own text, without the dismiss button's `×`.
      titleFrom: (panel) => panel.querySelector('h3')?.firstChild?.textContent?.trim() ?? '',
      onOpen: () => {
        if (elements.reviewPanel.hidden) app.git.toggleReview();
      },
      onClose: () => {
        app.git.closeReview();
        view.overlay(null);
      },
    },
    {
      key: 'risk',
      element: elements.riskPanel,
      title: 'Dependency risk',
      dockLabel: 'Risk',
      glyph: '⚠',
      width: 400,
      onOpen: () => {
        if (elements.riskPanel.hidden) app.git.toggleRisk();
      },
      onClose: () => app.git.closeRisk(),
    },
    {
      key: 'timeline',
      element: elements.timelinePanel,
      title: 'Timeline',
      dockLabel: 'Timeline',
      dock: false, // History is a screen tab, and T toggles this panel
      width: 380,
      onOpen: () => {
        if (elements.timelinePanel.hidden) {
          app.git.toggleTimeline().catch((error) => {
            elements.status.textContent = `Error: ${error.message}`;
          });
        }
      },
      onClose: () => {
        elements.timelinePanel.hidden = true;
      },
    },
    {
      key: 'branches',
      element: elements.branchesPanel,
      title: 'Branches',
      dockLabel: 'Branches',
      glyph: '⑂',
      width: 420,
      onOpen: () => {
        if (elements.branchesPanel.hidden) {
          app.git.toggleBranches().catch((error) => {
            elements.status.textContent = `Error: ${error.message}`;
          });
        }
      },
      onClose: () => {
        elements.branchesPanel.hidden = true;
      },
    },
    {
      key: 'narration',
      element: elements.narrationPanel,
      title: 'Narrator',
      dockLabel: 'Narrator',
      glyph: '✦',
      width: 420,
      canOpen: () => elements.narrationPanel.childElementCount > 0,
      blockedTitle: 'Right-click a file or unit and choose Narrate first',
      onBlocked: () => {
        elements.status.textContent = 'Right-click a file or unit and choose Narrate first.';
      },
      onClose: () => {
        elements.narrationPanel.hidden = true;
      },
    },
    {
      key: 'overlay',
      element: elements.overlayPanel,
      title: 'Overlay',
      dockLabel: 'Overlay',
      glyph: '◐',
      pinned: 5,
      width: 360,
      titleFrom: (panel) => (panel.querySelector('h3')?.textContent ?? '').split(' · ')[0].trim(),
      canOpen: () => state.overlay !== 'none',
      blockedTitle: 'Select an overlay (Review dropdown) to open Overlay',
      onBlocked: () => {
        elements.status.textContent = 'Select an overlay first — Overlay has nothing to show.';
      },
      onClose: () => app.lenses.clearOverlay(),
    },
    {
      key: 'edge',
      element: elements.edgePanel,
      title: 'Edge',
      dockLabel: 'Edge',
      glyph: '⟷',
      pinned: 6,
      width: 360,
      titleFrom: (panel) => panel.querySelector('h3')?.textContent?.trim() ?? '',
      canOpen: () => Boolean(app.selectedEdgeId),
      blockedTitle: 'Click an edge in the graph to open Edge',
      onBlocked: () => {
        elements.status.textContent = 'Click an edge in the graph first — no edge selected.';
      },
      onClose: () => selectEdge(null),
    },
    {
      key: 'source',
      element: elements.sourcePanel,
      title: 'Source',
      dockLabel: 'Source',
      glyph: '‹›',
      pinned: 3,
      width: 720,
      height: 640,
      canOpen: () => hasSourceTarget(),
      blockedTitle: 'Select a file to view its source',
      onBlocked: () => {
        elements.status.textContent = 'Select a file first — no source to show.';
      },
      onOpen: () => sourceRender(),
      onClose: () => closeSource(),
    },
    {
      key: 'legend',
      element: elements.legend,
      title: 'Legend',
      dockLabel: 'Legend',
      glyph: '≡',
      pinned: 1,
      width: 340,
    },
    {
      key: 'inspector',
      element: elements.inspector,
      title: 'Module passport',
      dockLabel: 'Passport',
      glyph: 'ⓘ',
      pinned: 2,
      width: 384,
      canOpen: () => Boolean(app.selected),
      blockedTitle: 'Select a module in the graph to open Passport',
      onBlocked: () => {
        elements.status.textContent = 'Select a module first — no passport to show.';
      },
      onClose: () => {
        elements.inspector.hidden = true;
      },
    },
    {
      key: 'diagnostics',
      element: elements.diagnostics,
      title: 'Diagnostics',
      dockLabel: 'Diagnostics',
      dock: false, // the header's Diagnostics icon opens it
      width: 420,
      titleFrom: (panel) => panel.querySelector('h3')?.textContent?.trim() ?? '',
      onOpen: () => {
        app.runtime.startRuntimeReadout();
      },
      onClose: () => {
        elements.diagnostics.hidden = true;
        elements.diagnosticsToggle.setAttribute('aria-expanded', 'false');
        app.runtime.stopRuntimeReadout();
      },
    },
    {
      key: 'settings',
      element: elements.settingsPanel,
      title: 'Settings',
      dockLabel: 'Settings',
      dock: false, // the header's Settings icon opens it
      width: 420,
      onOpen: () => {
        if (elements.settingsPanel.hidden) {
          app.settings.openSettings().catch((error) => {
            elements.status.textContent = `Error: ${error.message}`;
          });
        }
        elements.settingsToggle?.setAttribute('aria-expanded', 'true');
      },
      onClose: () => {
        elements.settingsPanel.hidden = true;
        elements.settingsToggle?.setAttribute('aria-expanded', 'false');
      },
    },
    {
      key: 'shortcuts',
      element: elements.shortcuts,
      title: 'Keyboard shortcuts',
      dockLabel: 'Shortcuts',
      dock: false, // ? opens it
      width: 320,
      onOpen: () => renderShortcuts(elements.shortcuts),
      onClose: () => {
        elements.shortcuts.hidden = true;
      },
    },
    {
      key: 'member',
      element: elements.memberView,
      title: 'Member map',
      dockLabel: 'Member map',
      glyph: '▦',
      pinned: 4,
      width: 900,
      height: 700,
      center: true,
      canOpen: () => Boolean(app.memberData),
      blockedTitle: 'Open a member map from a module passport first',
      onBlocked: () => {
        elements.status.textContent = 'Open a member map from a module passport first.';
      },
      onOpen: () => app.memberMap.renderMemberMapView(),
      onClose: () => app.memberMap.closeMemberMap(),
    },
    {
      key: 'workspace',
      element: elements.workspacePanel,
      title: 'Workspace',
      dockLabel: 'Workspace',
      glyph: '⧉',
      width: 460,
      onOpen: () => {
        app.panels.showWorkspace().catch(() => {});
      },
      onClose: () => app.panels.closeWorkspace(),
    },
    {
      key: 'passport',
      element: elements.passportPanel,
      title: 'Repository passport',
      dockLabel: 'Repo',
      glyph: '⌂',
      width: 460,
      onOpen: () => {
        app.panels.showPassport().catch(() => {});
      },
      onClose: () => app.panels.closePassport(),
    },
    {
      key: 'route',
      element: elements.routePanel,
      title: 'Reading route',
      dockLabel: 'Route',
      glyph: '➜',
      width: 440,
      onOpen: () => {
        app.panels.showRoute().catch(() => {});
      },
      onClose: () => app.panels.closeRoute(),
    },
    {
      key: 'blocks',
      element: elements.blocksPanel,
      title: 'Blocks',
      dockLabel: 'Blocks',
      glyph: '▣',
      width: 560,
      height: 620,
      onOpen: () => app.panels.showBlocks(),
      onClose: () => {
        elements.blocksPanel.hidden = true;
      },
    },
  ],
});

// The canvas action toolbar floats: drag its grip to move it, its edge to resize, and the
// placement is remembered. It opens bottom-left, clear of the top chrome, and drags down
// onto the bottom bar to dock there.
initFloatingToolbar(elements.graphToolbar, { dock: document.getElementById('bottom-bar') });

function refreshDock() {
  try {
    app.floatingWindows?.refresh?.();
  } catch {
    // Dock not yet initialized; initial renderDock() covers startup.
  }
}

elements.settingsToggle?.addEventListener('click', () => {
  app.floatingWindows.find((controller) => controller.key === 'settings')?.toggle();
});

// Follow the OS theme/motion preference while the theme is set to "system".
watchSystemPreferences(app.clientPrefs, () => applyClientPrefs());

// Gated automation hook for browser acceptance tests. It exposes measurement and the
// same handlers the UI uses; it is inert unless the page opts in with window.STRABO_TEST.
if (window.STRABO_TEST) {
  window.straboTest = {
    cy: view.cy,
    state,
    select: selectNode,
    drill: onDrill,
    openUnit,
    closeUnit,
    toggleOutsideLinks,
    toggleExpandedUnit,
    outsideShown: () => state.showOutside,
    selectEdge,
    model: () => app.current,
    renderedGeneration: () => state.renderedGeneration,
    openMemberMap: (id) => app.memberMap.openMemberMap(id),
    closeMemberMap: () => app.memberMap.closeMemberMap(),
    memberUI,
    memberData: () => app.memberData,
    memberStepCount: app.memberMap.memberStepCount,
    review: () => app.git.showReview(''),
    reviewCommit: (ref) => app.git.showReview(`?base=${encodeURIComponent(ref)}`),
    risk: () => app.git.showRisk(),
    groupSelection: () => app.groupSelection,
    floatingWindows: () => app.floatingWindows,
    islands: () => view.islandDirectories(),
    islandBoxes: () => view.islandBoxes(),
    islandOffsets: () => view.islandOffsets(),
    setIslandLayout: (offsets) => view.setIslandOffsets(offsets),
    resetIslandLayout: resetMapLayout,
    workspace: () => app.panels.showWorkspace(),
    passport: () => app.panels.showPassport(),
    route: (file) => app.panels.showRoute(file),
    blocks: () => app.panels.showBlocks(),
    brickAssembly: () => buildBrickAssembly(app.current?.nodes ?? [], app.current?.edges ?? []),
    setScreen,
    screen: () => store.get().ui.screen,
    openReviewScreen: app.git.openReviewScreen,
    openHistoryScreen: app.git.openHistoryScreen,
  };
}

// The right-click Narrate entry needs the narrator status before the first menu opens.
app.narration.fetchNarratorStatus().then((status) => {
  app.narratorStatus ??= status;
});

loadCatalogue()
  .then(() => {
    // The graph default is the fallback: a URL mode or a per-repository pref overrides it.
    state.mode = app.clientPrefs.defaultDetail;
    elements.detail.value = app.clientPrefs.defaultDetail;
    app.url.applyUrl();
    if (
      state.repository &&
      [...elements.repository.options].some((option) => option.value === state.repository)
    ) {
      elements.repository.value = state.repository;
      elements.forget.disabled = false;
    }
    app.prefs.applyViewPrefs();
    return scan();
  })
  .then(() => app.url.restoreUrlPanel())
  .then(() => {
    // A deep link that opened the member map is explicit intent; do not cover it.
    if (elements.memberView.hidden) {
      return app.panels.maybeOpenPassport();
    }
    return undefined;
  })
  .catch((error) => {
    elements.status.textContent = `Error: ${error.message}`;
  });
