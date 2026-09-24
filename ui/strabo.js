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

import { API_PATH, buildGraphQuery, filterNodes, graphSummary, mapCounts } from './strabo-core.js';
import { createView } from './strabo-view.js';
import { writeIslandLayout } from './strabo-island-layout.js';
import { showToast } from './strabo-delegate.js';
import { initFloatingWindows } from './strabo-float.js';
import { initFloatingToolbar } from './strabo-float-toolbar.js';
import { createFreshnessBadge } from './strabo-freshness.js';
import {
  renderBreadcrumb,
  renderDiagnostics,
  renderLegend,
  renderOverlayPanel,
  renderShortcuts,
  renderTestsStrip,
} from './strabo-panels.js';
import { buildBrickAssembly } from './strabo-lego.js';
import { applyAppearance, readSettings, watchSystemPreferences } from './strabo-settings.js';
import { fit, focus, zoomIn, zoomOut } from './strabo-viewport.js';
import { createStore } from './store.js';
import { createViewPrefs } from './strabo-view-prefs.js';
import { createRuntimeReadout } from './strabo-runtime-readout.js';
import { createUrlState } from './strabo-url-state.js';
import { createNarrationController } from './strabo-narration-controller.js';
import { createMemberMapController } from './strabo-member-map-controller.js';
import { createGitController } from './strabo-git-controller.js';
import { createSettingsController } from './strabo-settings-controller.js';
import { createRepositoryPanels } from './strabo-repo-panels.js';
import { createLensController } from './strabo-lens-controller.js';
import { createRepositoryPicker } from './strabo-repositories.js';
import { createSystemUnits } from './strabo-system-units.js';
import { createSourceViewer } from './strabo-source-viewer.js';
import { createTerminalBridge } from './strabo-terminal-bridge.js';
import { createChromeMenus } from './strabo-chrome-menus.js';
import { createDelegation } from './strabo-delegation.js';
import { createSelectionController } from './strabo-selection-controller.js';

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
  applyFilterToView,
  dismissHint,
  refreshDock,
  request,
  scan,
  setScreen,
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
app.repos = createRepositoryPicker(app);
app.units = createSystemUnits(app);
app.source = createSourceViewer(app);
app.terminal = createTerminalBridge(app);
app.menus = createChromeMenus(app);
app.delegation = createDelegation(app);
app.selection = createSelectionController(app);
// </controllers>

/** The freshness badge reads `/status` and rebuilds the map through a cache bypass. */
const freshness = createFreshnessBadge(elements.freshness, {
  request,
  onRebuild: () => scan({ refresh: true }),
  repository: () => state.repository,
});

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
  app.selection.hideTooltip();
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
      app.units.openUnit(model.systemSingleUnit);
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
        if (!prefix) app.units.closeUnit();
        return;
      }
      state.prefix = prefix;
      scan();
    });
    app.units.updateOutsideButton();
    applyModeChrome();
    app.units.updateUnitsButton();
    app.lenses.updateEdgeKindButton();
    app.lenses.updateCoChangeButton();
    app.lenses.updateLabelsButton();
    app.selection.updateFocusButton();
    elements.inspector.hidden = true;
    elements.status.textContent = graphSummary(model);
    updateStatusbar(model);
    void freshness.refresh({ repository: state.repository });
    if (elements.graphLoading) elements.graphLoading.hidden = true;
    updateEmptyState();
    app.units.updateSystemNote(model);
    view.resize();
    fit(view.cy);
    if (restoreFile && model.systemUnit && (model.nodes ?? []).some((node) => node.id === restoreFile)) {
      // A toggle (e.g. outside links) refetches; keep the file it acted on selected.
      if (generation === app.scanGeneration) {
        app.selection.selectNode(restoreFile);
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
    app.menus.closeOverflowMenu();
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
    toggleShortcuts();
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

function applyStripFilter(filter) {
  state.filter = filter;
  elements.filter.value = filter;
  applyFilterToView();
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
document.getElementById('graph')?.addEventListener('pointerdown', dismissHint, { capture: true });
elements.tbBoundaries.addEventListener('click', () => {
  state.mode = state.mode === 'block' ? 'file' : 'block';
  elements.detail.value = state.mode;
  state.prefix = '';
  scan();
});

/** Show the keyboard cheat-sheet in its own floating window. Declared with `function` so
 * the key handler above can call it before `floatingWindows` is assigned. */
function toggleShortcuts() {
  app.floatingWindows?.find?.((controller) => controller.key === 'shortcuts')?.toggle();
}

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
      onClose: () => app.selection.selectEdge(null),
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
      canOpen: () => app.source.hasSourceTarget(),
      blockedTitle: 'Select a file to view its source',
      onBlocked: () => {
        elements.status.textContent = 'Select a file first — no source to show.';
      },
      onOpen: () => app.source.sourceRender(),
      onClose: () => app.source.closeSource(),
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
    select: app.selection.selectNode,
    drill: app.selection.onDrill,
    openUnit: app.units.openUnit,
    closeUnit: app.units.closeUnit,
    toggleOutsideLinks: app.units.toggleOutsideLinks,
    toggleExpandedUnit: app.units.toggleExpandedUnit,
    outsideShown: () => state.showOutside,
    selectEdge: app.selection.selectEdge,
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
    resetIslandLayout: app.delegation.resetMapLayout,
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

app.repos.loadCatalogue()
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
