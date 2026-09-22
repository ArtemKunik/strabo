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

import { API_PATH, buildAgentPrompt, buildGraphQuery, coChangePartnersFor, edgeEvidenceFor, fileWebUrl, filterNodes, folderLocation, graphSummary, mapCounts, memberMapSteps, overlayFor, passportFor, reviewOverlay, riskSummary, rovingIndex, shelfHoverText, tierOfFile, unitHoverFacts, withUnitHotspots } from './strabo-core.js';
import { createView } from './strabo-view.js';
import { createFrameSampler } from './strabo-perf.js';
import { readIslandLayout, writeIslandLayout } from './strabo-island-layout.js';
import { closeContextMenu, copyText, launchAgent, showContextMenu, showPromptReview, showToast } from './strabo-delegate.js';
import { initFloatingWindows } from './strabo-float.js';
import { createFreshnessBadge } from './strabo-freshness.js';
import {
  renderBreadcrumb,
  renderDiagnostics,
  renderEdgeEvidence,
  renderFolderList,
  renderFunctions,
  renderImpactPassport,
  renderInspector,
  renderLegend,
  renderBranches,
  renderChangesWith,
  renderMemberMap,
  renderMembers,
  renderNarrationPanel,
  renderOverlayPanel,
  renderRepositoryPassport,
  renderReview,
  renderReviewLoading,
  renderRisk,
  renderShortcuts,
  renderSource,
  renderTestsStrip,
  renderTimeline,
  renderWorkspace,
} from './strabo-panels.js';
import { findPath, neighbourhood } from './strabo-selection.js';
import { renderTierPanel } from './strabo-tier-panel.js';
import {
  clampRouteIndex,
  readRouteProgress,
  renderRoutePanel,
  routeIndexOf,
  routeSteps,
  writeRouteProgress,
} from './strabo-route.js';
import { tierDirectionClasses } from './strabo-tiers.js';
import {
  GROUP_NAMING_INSTRUCTION,
  MEMBER_NARRATION_INSTRUCTION,
  REVIEW_NARRATION_INSTRUCTION,
  buildGroupNamingEvidence,
  buildMemberNarratorEvidence,
  buildNarratorEvidence,
  buildReviewNarrationEvidence,
  narratorMenuState,
} from './strabo-narrator.js';
import { openCommitDialog } from './strabo-commit.js';
import { applyAppearance, readSettings, renderSettings, watchSystemPreferences, writeSettings } from './strabo-settings.js';
import { crossRepoNodeIds } from './strabo-workspace.js';
import { fit, focus, zoomIn, zoomOut } from './strabo-viewport.js';
import { createStore } from './store.js';

/** Incremented on every scan; async completions check their captured generation. */
let scanGeneration = 0;
let current = null;
let selected = null;
/** Edge id (`e<N>`) with an open evidence panel, or null. */
let selectedEdgeId = null;
/** Node ids currently held in cytoscape's own selection: ⌘/ctrl-click or shift-drag. */
let groupSelection = [];
/** The Git review result currently shown in the review panel, for delegation. */
let currentReview = null;
/** The narrator status from `/narrator`, fetched once; null until it resolves. */
let narratorStatus = null;

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
  ui: { node: null, memberOpen: false },
});
const state = store.get().view;
const memberUI = store.get().member;

/* ------------------------------------------- Persisted view preferences */

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
}

const view = createView(document.getElementById('graph'));

// A finished island drag writes the arrangement under the repository it belongs to; a later
// visit to that repository replays it. The view owns the offsets at runtime, so this only
// persists what a drag just produced.
view.onIslandLayout((offsets) => {
  writeIslandLayout(state.repository, offsets);
});

/**
 * A rolling frame-time readout for the Diagnostics panel.
 *
 * Rendering is CPU-bound — the renderer walks every element in JS before the GPU sees
 * anything — so the useful numbers are the frame interval and the renderer's own redraw
 * count, not GPU utilisation. Sampled only while Diagnostics is open, since an idle rAF loop
 * is itself work. The renderer's `redraws` counter is the honest "did the map actually
 * repaint" signal behind the viewport fast paths.
 */
const frameSampler = createFrameSampler(window);
let runtimeBase = '';
let runtimeTimer = 0;

function runtimeSuffix() {
  const { fps, ms } = frameSampler.stats();
  const redraws = view.cy?.renderer?.()?.redraws ?? 0;
  const drawn = view.cy?.elements().length ?? 0;
  const fpsText = fps === null ? 'fps: sampling…' : `${Math.round(fps)} fps`;
  const msText = ms === null ? '' : ` / ${ms.toFixed(1)} ms`;
  return `${fpsText}${msText} · ${redraws} redraws · ${drawn} elements`;
}

function refreshRuntimeReadout() {
  if (!elements.diagnostics || elements.diagnostics.hidden || !runtimeBase) {
    return;
  }
  const line = elements.diagnostics.querySelector('[data-role="runtime"]');
  if (line) {
    line.textContent = `${runtimeBase} · ${runtimeSuffix()}`;
  }
}

function startRuntimeReadout() {
  frameSampler.start();
  if (!runtimeTimer) {
    runtimeTimer = setInterval(refreshRuntimeReadout, 500);
  }
  refreshRuntimeReadout();
}

function stopRuntimeReadout() {
  frameSampler.stop();
  if (runtimeTimer) {
    clearInterval(runtimeTimer);
    runtimeTimer = 0;
  }
}

/**
 * Client preferences, read once and re-applied on every change. `applyAppearance` sets the
 * theme and reduce-motion attributes before the first render; the canvas reads their
 * colours, so it is restyled here too.
 */
let clientPrefs = readSettings();

function applyClientPrefs() {
  applyAppearance(clientPrefs);
  view.applyTheme();
  view.setLabelsVisible(clientPrefs.labels);
  view.setLabelsForceAll(clientPrefs.allLabels);
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
  tbTimeline: document.getElementById('tb-timeline'),
  tbReview: document.getElementById('tb-review'),
  tbRisk: document.getElementById('tb-risk'),
  tbBranches: document.getElementById('tb-branches'),
  tbClear: document.getElementById('tb-clear'),
  tbOverflow: document.getElementById('tb-overflow'),
  tbOverflowMenu: document.getElementById('tb-overflow-menu'),
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
  sourcePanel: document.getElementById('source-panel'),
};

/** `memberData` holds the last loaded member-map payload; `memberUI` is the store slice. */
let memberData = null;
let memberTimer = null;
let selectedCommitHash = null;
let selectedBranchName = null;
/** The base the Branches panel compares with; null lets the server pick the trunk. */
let branchBase = null;
/** True while a branch fetch/push/sync is in flight, so the panel disables its actions. */
let branchesBusy = false;

/** Reviews shown in the Review panel, oldest first, so Back can step down to one. */
let reviewHistory = [];
/** The review the panel is showing, so the next navigation can push it onto the history. */
let currentReviewRequest = null;
/** Module Passport selections, oldest first, so Back can step down to one. */
let passportHistory = [];
/** True while Back is re-selecting, so the step it makes is not itself pushed. */
let passportGoingBack = false;
/** The reading route the panel is showing, and the step it is on, so a step can focus the map. */
let currentRoute = null;
let routeIndex = 0;

let browsedFolder = null;

async function request(path) {
  const response = await fetch(`${API_PATH}${path}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json();
}

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
  const selected = active ?? repositories[0]?.root ?? null;
  if (selected) {
    elements.repository.value = selected;
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
  const generation = ++scanGeneration;
  elements.status.textContent = 'Scanning…';
  if (elements.graphLoading) elements.graphLoading.hidden = false;
  if (elements.graphEmpty) elements.graphEmpty.hidden = true;
  hideTooltip();
  closeMemberMap();

  try {
    const model = await request(`/graph${buildGraphQuery(state, { refresh })}`);
    if (generation !== scanGeneration) {
      return;
    }
    current = model;
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
    selected = null;
    selectedEdgeId = null;
    selectedCommitHash = null;
    selectedBranchName = null;
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
    applyTierLens();
    applyEdgeKindLens();
    applyCoChangeLens();
    renderLegend(elements.legend, model);
    renderTestsStrip(elements.strip, mapCounts(model), applyStripFilter, state.filter);
    const summary = renderDiagnostics(elements.diagnostics, model, {
      renderer: rendererName(),
      shown: view.cy.nodes().length,
    });
    // Keep the per-graph half of the runtime line, so the live perf fields can be appended
    // without losing the cache/renderer/shown facts the panel just wrote.
    runtimeBase = elements.diagnostics.querySelector('[data-role="runtime"]')?.textContent ?? '';
    refreshRuntimeReadout();
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
    updateEdgeKindButton();
    updateCoChangeButton();
    updateLabelsButton();
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
      if (generation === scanGeneration) {
        selectNode(restoreFile);
      }
    }
    if (shouldShowHint()) {
      elements.graphHint.hidden = false;
    }
    if (state.overlay !== 'none') {
      await applyOverlay(generation);
    } else if (state.tier === 'off') {
      renderOverlayPanel(elements.overlayPanel, '', null);
    }
    if (state.mode === 'system' && !model.systemUnit && (model.unitCards?.length ?? 0) > 0) {
      enrichUnitCards(generation);
    }
    refreshDock();
  } catch (error) {
    if (generation !== scanGeneration) {
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
  if (!elements.graphEmpty || !current) return;
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
  if (!current) return;
  const ids = filterNodes(current, state.filter);
  view.filter(ids);
  updateFilterChrome(ids.length, current.nodes.length);
  updateEmptyState();
  if (current) {
    renderTestsStrip(elements.strip, mapCounts(current), applyStripFilter, state.filter);
  }
}

/**
 * The tier lens: colour the file map by tier, and optionally keep one tier.
 *
 * The report is fetched once per render and cached, so switching the filter does not re-read
 * the repository. Tiers are per file, so block and system modes clear the lens rather than
 * colour an aggregate.
 */
let tierReportCache = { generation: -1, report: null };

async function applyTierLens() {
  if (state.tier === 'off' || !current || current.system || current.prefixLength !== undefined) {
    view.applyTier(null);
    view.applyTierDirections(null);
    return;
  }
  const generation = state.renderedGeneration;
  if (tierReportCache.generation !== generation || !tierReportCache.report) {
    try {
      const query = state.repository ? `?repository=${encodeURIComponent(state.repository)}` : '';
      const response = await fetch(`${API_PATH}/analysis/tiers${query}`);
      tierReportCache = {
        generation,
        report: response.ok ? await response.json() : null,
      };
    } catch {
      tierReportCache = { generation, report: null };
    }
  }
  if (!current || state.tier === 'off' || state.renderedGeneration !== generation) {
    view.applyTier(null);
    view.applyTierDirections(null);
    return;
  }
  view.applyTier(tierOfFile(tierReportCache.report), state.tier === 'all' ? 'all' : state.tier);
  view.applyTierDirections(tierDirectionClasses(tierReportCache.report));
  renderTierPanel(elements.overlayPanel, tierReportCache.report, state.tier);
}

function selectNode(id) {
  if (!current) {
    return;
  }
  dismissHint();

  // Path mode: the first selection is the start, the second traces and exits.
  if (state.pathMode) {
    if (!state.pathFrom) {
      state.pathFrom = id;
      elements.hover.textContent = `Path start: ${id}. Select the end node.`;
      view.highlight(neighbourhood(current, id));
      return;
    }
    const from = state.pathFrom;
    state.pathFrom = null;
    state.pathMode = false;
    elements.tbPath.classList.remove('active');
    const path = findPath(current, from, id);
    elements.hover.textContent = path
      ? `${path.length - 1} step(s): ${path.join(' -> ')}`
      : `No directed path from ${from} to ${id}.`;
    view.highlight(path ?? [from, id]);
    return;
  }

  const previousSelection = selected;
  selected = id;
  store.set('ui', { node: id });
  if (!passportGoingBack && previousSelection && previousSelection !== id) {
    // Keep the module the passport is leaving, so Back can step down to it. Re-selecting
    // the node already on screen (or a Back step) does not grow the history.
    passportHistory.push(previousSelection);
  }
  view.clearEdge();
  selectedEdgeId = null;
  renderEdgeEvidence(elements.edgePanel, null);
  updateFocusButton();
  view.highlight(neighbourhood(current, id));
  const unitNode = (current?.nodes ?? []).find((candidate) => candidate.id === id);
  if (current?.systemUnit && unitNode?.systemUnit && !id.endsWith('#support')) {
    // L16: a file inside the open unit draws its own in-unit edges.
    state.unitFile = id;
    view.focusFile(id);
  }
  renderInspector(elements.inspector, current, id, {
    onSelect: (target) => selectNode(target),
    onTrace: (from, to) => tracePath(from, to),
    onOpenWorkspace: (target) => openFile(target),
    onBack: passportBack,
    backTitle: passportHistory.length > 0 ? 'Back to the previously selected module' : 'Back to the map',
    ...(isFileNode(id) ? { onViewSource: (target) => viewSource(target) } : {}),
    // The reading route is repository-wide; a Module Passport opens it at its own file.
    ...(isFileNode(id) ? { onOpenRoute: (target) => showRoute(target) } : {}),
    onOpenMemberMap: (target) => {
      // The member map is a drill-down from the passport. Open it through its window
      // controller (so it centres, raises above the passport, and takes focus), then
      // retire the passport window instead of leaving the two stacked.
      openMemberMap(target)
        .then(() => {
          floatingWindows.find((controller) => controller.key === 'inspector')?.close();
        })
        .catch((error) => {
          elements.status.textContent = `Error: ${error.message}`;
        });
    },
    // A System-view unit may ask the opt-in narrator to name its group.
    ...(current?.system && !current?.systemUnit
      ? { narratorStatus, onNarrate: () => narrateGroup(id), onOpenNarratorSettings: openNarratorSettings }
      : {}),
    // Inside a unit, the selected file may show its cross-unit links (L17).
    ...(current?.systemUnit
      ? {
          outsideShown: state.showOutside,
          onShowOutside: () => toggleOutsideLinks(),
          onExpandUnit: (unit) => toggleExpandedUnit(unit),
        }
      : {}),
  });
  if (!current?.system) {
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
    if (narratorStatus === null) {
      narratorStatus = await fetchNarratorStatus();
    }
    const [symbolsResponse, impactResponse] = await Promise.all([
      fetch(`${API_PATH}/symbols?${params.toString()}`),
      fetch(`${API_PATH}/analysis/impact-passport?${impactParams.toString()}`),
    ]);
    const result = symbolsResponse.ok
      ? await symbolsResponse.json()
      : { available: false, detail: 'Symbols are unavailable for this file.' };
    const impact = impactResponse.ok ? await impactResponse.json() : null;
    const changesWith = changesWithSection ? await loadChangesWith(id) : null;
    if (selected === id) {
      if (membersSection) renderMembers(membersSection, result);
      if (functionsSection) renderFunctions(functionsSection, result, functionsHandlers(result));
      if (impactSection) renderImpactPassport(impactSection, impact ? impactPassportSet(impact) : null);
      if (changesWithSection) renderChangesWith(changesWithSection, changesWith, { onSelect: (file) => selectNode(file) });
    }
  } catch {
    if (selected === id) {
      const fallback = { available: false, detail: 'Symbols could not be loaded.' };
      if (membersSection) renderMembers(membersSection, fallback);
      if (functionsSection) renderFunctions(functionsSection, fallback, functionsHandlers(fallback));
      if (impactSection) renderImpactPassport(impactSection, null);
      if (changesWithSection) renderChangesWith(changesWithSection, { available: false, detail: 'Co-change could not be loaded.' });
    }
  }
}

/**
 * The "Changes with" partners for one file, fetched once per repository and reused.
 *
 * `unavailable` is reported honestly when Git history was not read, so the passport says so
 * rather than showing an empty list as if nothing coupled.
 */
async function loadChangesWith(id) {
  const repository = state.repository ?? null;
  if (!coChangeReport || coChangeRepository !== repository) {
    try {
      const query = repository ? `?repository=${encodeURIComponent(repository)}` : '';
      coChangeReport = await request(`/analysis/co-change${query}`);
      coChangeRepository = repository;
    } catch (error) {
      return { available: false, detail: error.message };
    }
  }
  if (coChangeReport?.unavailable) {
    return { available: false, detail: coChangeReport.detail };
  }
  return { available: true, partners: coChangePartnersFor(coChangeReport, id) };
}

/** Wrap a single file's passport in the set shape the shared card renderer reads. */
function impactPassportSet(card) {
  if (!card || card.path === undefined) {
    return null;
  }
  return { scope: 'file', baseline: card.status === 'added' ? null : 'HEAD', files: [card], totals: null, capped: false };
}

/** Handlers that let the Functions tab ask the opt-in narrator about the recorded evidence. */
function functionsHandlers(result) {
  return {
    narratorStatus,
    onNarrate: () => narrateFile(result),
    onOpenNarratorSettings: openNarratorSettings,
  };
}

/** Read the narrator status once; failures degrade to the unconfigured caption, not an error. */
async function fetchNarratorStatus() {
  try {
    const response = await fetch(`${API_PATH}/narrator`);
    if (!response.ok) {
      return { configured: false, reason: 'not-configured' };
    }
    const body = await response.json();
    if (Array.isArray(body?.presets) && body.presets.length > 0) {
      narratorPresets = body.presets;
    }
    return body;
  } catch {
    return { configured: false, reason: 'not-configured' };
  }
}

/**
 * Ask the narrator to propose a name and purpose for one System-view unit.
 *
 * Only the unit's recorded facts are sent; the reply is narrative and never creates, merges,
 * or splits a group.
 */
async function narrateGroup(id) {
  if (narratorStatus === null) {
    narratorStatus = await fetchNarratorStatus();
  }
  return postNarration(
    GROUP_NAMING_INSTRUCTION,
    buildGroupNamingEvidence(current, id),
  );
}

/**
 * Ask the narrator about one file's recorded evidence.
 *
 * Only recorded evidence is sent; the endpoint decides whether it is enabled. The reply is
 * narrative text, rendered apart from the recorded facts and never applied to the source.
 */
async function narrateFile(result) {
  return postNarration(
    'Summarise the recorded complexity, signals, and call wiring in this file.',
    buildNarratorEvidence(result),
  );
}

/**
 * Ask the narrator to explain one file's recorded members and data flow.
 *
 * Only the recorded member map is sent; the reply is narrative, rendered under the
 * model-generated attribution, and never changes the recorded view.
 */
async function narrateMemberMap() {
  return postNarration(
    MEMBER_NARRATION_INSTRUCTION,
    fileNarrationEvidence(memberData?.file, memberData, memberData?.importIds, memberData?.consumerIds),
  );
}

/**
 * Ask the narrator to explain one Git review's recorded change set.
 *
 * Only the recorded review is sent; the reply is narrative, rendered under the
 * model-generated attribution, and never changes the recorded view.
 */
async function narrateReview(result) {
  return postNarration(REVIEW_NARRATION_INSTRUCTION, buildReviewNarrationEvidence(result));
}

/**
 * The recorded evidence for narrating one file: its members, wiring, functions, and import
 * neighbours when it declares members, else its function inventory. `source` is anything with
 * `memberMap` and `functions`, such as a `/symbols` result or the open member map's data.
 */
function fileNarrationEvidence(file, source, imports, usedBy) {
  if (source?.memberMap?.types?.length > 0) {
    return buildMemberNarratorEvidence(source.memberMap, {
      file,
      imports: imports ?? undefined,
      usedBy: usedBy ?? undefined,
      functions: source.functions,
    });
  }
  return buildNarratorEvidence({ functions: source?.functions });
}

/** True when a graph node is something the narrator can describe: a file or a System unit. */
function isNarratable(id) {
  if (!id || !current || state.mode === 'block' || id.endsWith('#support')) {
    return false;
  }
  return current.nodes.some((candidate) => candidate.id === id);
}

/**
 * Narrate one graph node from its right-click menu and show the reply in the Narrator window.
 *
 * A System unit is named from its recorded facts; a file is narrated from its recorded members,
 * functions, and import neighbours. The reply is model-generated and the window says so.
 */
async function narrateNode(id) {
  const label = current?.nodes.find((candidate) => candidate.id === id)?.label ?? id;
  const showPanel = (panelState) => {
    renderNarrationPanel(elements.narrationPanel, panelState, { onOpenNarratorSettings: openNarratorSettings });
  };
  showPanel({ label, phase: 'loading' });
  floatingWindows.find((controller) => controller.key === 'narration')?.open();
  try {
    let reply;
    if (current?.system && !current?.systemUnit) {
      reply = await narrateGroup(id);
    } else {
      const params = new URLSearchParams({ file: id });
      if (state.repository) {
        params.set('repository', state.repository);
      }
      const result = await request(`/symbols?${params.toString()}`);
      const passport = passportFor(current, id);
      reply = await postNarration(
        MEMBER_NARRATION_INSTRUCTION,
        fileNarrationEvidence(
          id,
          result,
          passport?.imports.map((entry) => entry.id),
          passport?.usedBy.map((entry) => entry.id),
        ),
      );
    }
    showPanel({ label, phase: 'done', reply });
  } catch (error) {
    showPanel({ label, phase: 'error', message: error.message });
  }
}

/**
 * Ask the opt-in narrator for the guided tour: passport plus reading route become the evidence.
 *
 * The tour is model-generated narrative, shown in the Narrator window under the same
 * attribution as every other reply, and never changes the route or the map.
 */
async function narrateRouteTour() {
  const params = state.repository ? `?repository=${encodeURIComponent(state.repository)}` : '';
  const showPanel = (panelState) => {
    renderNarrationPanel(elements.narrationPanel, panelState, { onOpenNarratorSettings: openNarratorSettings });
  };
  showPanel({ label: 'Guided tour', phase: 'loading' });
  floatingWindows.find((controller) => controller.key === 'narration')?.open();
  try {
    const response = await fetch(`${API_PATH}/narrator/tour${params}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state.repository ? { repository: state.repository } : {}),
    });
    const reply = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(reply.error ?? `Narrator request failed (${response.status}).`);
    }
    showPanel({ label: 'Guided tour', phase: 'done', reply });
  } catch (error) {
    showPanel({ label: 'Guided tour', phase: 'error', message: error.message });
  }
}

/** POST recorded evidence to the narrator and return its reply. */
async function postNarration(instruction, evidence) {
  const response = await fetch(`${API_PATH}/narrator`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction, evidence }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? `Narrator request failed (${response.status}).`);
  }
  return body;
}

function clearSelection() {
  selected = null;
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
  selectedEdgeId = null;
  renderEdgeEvidence(elements.edgePanel, null);
  closeReview();
  closeRisk();
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

/** Step the Member map back to the Module Passport it was opened from. */
function memberMapBack() {
  const file = memberData?.file;
  closeMemberMap();
  if (file) {
    selectNode(file);
  }
}

/** Load the member map, repository health, and consumers, then open the full view. */
async function openMemberMap(id) {
  const params = new URLSearchParams({ file: id });
  if (state.repository) {
    params.set('repository', state.repository);
  }
  const result = await request(`/symbols?${params.toString()}`);
  const healthParams = new URLSearchParams({ file: id });
  if (state.repository) {
    healthParams.set('repository', state.repository);
  }
  let health = await request(`/analysis/file-health?${healthParams.toString()}`).catch(() => null);
  if (!health) {
    const healthQuery = state.repository ? `?repository=${encodeURIComponent(state.repository)}` : '';
    health = await request(`/analysis/architecture-health${healthQuery}`).catch(() => null);
  }
  const passport = passportFor(current, id);
  memberData = {
    file: id,
    repository: state.repository,
    memberMap: result.memberMap,
    symbols: result.symbols,
    health,
    metrics: health?.metrics ?? null,
    consumerIds: passport ? passport.usedBy.map((entry) => entry.id) : null,
    importIds: passport ? passport.imports.map((entry) => entry.id) : null,
    functions: result.functions,
  };
  // The member map's narrator affordance needs the status before it renders.
  if (narratorStatus === null) {
    narratorStatus = await fetchNarratorStatus();
  }
  store.set('ui', { memberOpen: true, node: id });
  store.set('member', { stepIndex: 0, find: '' });
  // Open through the window controller, not `memberView.hidden = false` directly: the
  // controller raises the window above the passport and lands focus in it. Setting the
  // `hidden` attribute alone let the window appear behind the passport, silently.
  floatingWindows.find((controller) => controller.key === 'member')?.open();
  refreshDock();
}

function memberStepCount() {
  return memberMapSteps(memberData?.memberMap, {
    consumers: memberData?.consumerIds ? memberData.consumerIds.length : null,
  }).length;
}

function renderMemberMapView() {
  if (!memberData) {
    return;
  }
  // The view layer reuses the find input, so its focus and caret survive a re-render.
  renderMemberMap(elements.memberView, memberData, memberUI, {
    onFind: (value) => store.set('member', { find: value }),
    onOrder: (value) => store.set('member', { order: value }),
    onWiring: (value) => store.set('member', { showWiring: value }),
    onZoom: (value) => store.set('member', { zoom: value }),
    onExplain: () => {
      store.set('member', { explain: !memberUI.explain });
      if (memberUI.explain) {
        revealMemberExplain();
      }
    },
    onNight: () => store.set('member', { dim: !memberUI.dim }),
    onCompare: () => {
      toggleTimeline().catch((error) => {
        elements.status.textContent = `Error: ${error.message}`;
      });
    },
    onOnlyFlow: () => store.set('member', { onlyFlow: !memberUI.onlyFlow }),
    onReset: () =>
      store.set('member', {
        order: 'source',
        find: '',
        showWiring: true,
        zoom: 'medium',
        dataFlow: true,
        onlyFlow: false,
        explain: false,
        stepIndex: 0,
        dim: false,
      }),
    onDataFlow: (value) => store.set('member', { dataFlow: value }),
    // The member map may ask the opt-in narrator to explain the recorded members and data flow.
    narratorStatus,
    onNarrate: () => narrateMemberMap(),
    onOpenNarratorSettings: openNarratorSettings,
    onStep: (delta) => {
      stopMemberPlay();
      store.set('member', {
        stepIndex: Math.min(memberStepCount() - 1, Math.max(0, memberUI.stepIndex + delta)),
      });
    },
    onPlay: () => toggleMemberPlay(),
    onBack: () => memberMapBack(),
    onClose: () => closeMemberMap(),
  });
}

/**
 * Bring the explanation into view when it is switched on.
 *
 * The summary sits above the member list, so a panel scrolled down to the methods would insert
 * it off-screen and the toggle would look like it did nothing. It is scrolled to just below the
 * sticky toolbar, which the panel scrolls under.
 */
function revealMemberExplain() {
  const container = elements.memberView;
  const explain = container.querySelector('[data-role="explain"]');
  if (!explain) {
    return;
  }
  const toolbar = container.querySelector('.member-toolbar');
  const containerTop = container.getBoundingClientRect().top;
  const offset = (toolbar?.offsetHeight ?? 0) + 8;
  const top = explain.getBoundingClientRect().top;
  if (top < containerTop + offset) {
    container.scrollTop = Math.max(0, container.scrollTop + (top - containerTop - offset));
  }
}

function stopMemberPlay() {
  if (memberTimer) {
    clearInterval(memberTimer);
    memberTimer = null;
  }
  elements.memberView.classList.remove('is-playing');
}

function toggleMemberPlay() {
  if (memberTimer) {
    stopMemberPlay();
    return;
  }
  elements.memberView.classList.add('is-playing');
  memberTimer = setInterval(() => {
    if (memberUI.stepIndex >= memberStepCount() - 1) {
      store.set('member', { stepIndex: 0 });
      stopMemberPlay();
      return;
    }
    store.set('member', { stepIndex: memberUI.stepIndex + 1 });
  }, 1400);
}

function closeMemberMap() {
  stopMemberPlay();
  elements.memberView.hidden = true;
  memberUI.dim = false;
  store.set('ui', { memberOpen: false });
  refreshDock();
}

/* ------------------------------------------- URL state */

/**
 * Keep the selected repository, detail mode, selected node, and open member map in the URL,
 * so a view can be shared and a reload restores it. The URL mirrors the store; the store is
 * still the source of truth. Writes are synchronous but skip when nothing changed, and the
 * deep link is snapshotted on load because the first scan clears the live selection.
 */
let urlIntent = null;

function currentUrlParams() {
  try {
    return new URL(window.location.href).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function syncUrl() {
  try {
    const url = new URL(window.location.href);
    const set = (key, value) => {
      if (value) {
        url.searchParams.set(key, value);
      } else {
        url.searchParams.delete(key);
      }
    };
    set('repository', state.repository ?? '');
    set('mode', state.mode === 'file' ? 'file' : state.mode === 'system' ? 'system' : '');
    set('unit', state.mode === 'system' ? state.systemUnit ?? '' : '');
    set('outside', state.mode === 'system' && state.showOutside ? '1' : '');
    set('node', store.get().ui.node ?? '');
    set('panel', store.get().ui.memberOpen ? 'member-map' : '');
    if (`${url.pathname}${url.search}` !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, '', url);
    }
  } catch {
    // A blocked history API only costs the deep link.
  }
}

/** Apply the URL's repository and mode, and remember the panel/node for after the scan. */
function applyUrl() {
  const params = currentUrlParams();
  urlIntent = { node: params.get('node'), panel: params.get('panel') };
  const repository = params.get('repository');
  if (repository) {
    state.repository = repository;
  }
  const mode = params.get('mode');
  if (mode === 'file' || mode === 'block' || mode === 'system') {
    state.mode = mode;
    elements.detail.value = mode;
  }
  // A System deep link may name the open unit and the outside-links toggle.
  state.systemUnit = mode === 'system' ? params.get('unit') : null;
  state.systemUnitLabel = state.systemUnit;
  state.showOutside = mode === 'system' && params.get('outside') === '1';
  return params;
}

/** Reopen the member map the deep link named, once the graph it refers to is loaded. */
async function restoreUrlPanel() {
  const intent = urlIntent;
  urlIntent = null;
  if (!intent || intent.panel !== 'member-map' || !intent.node) {
    return;
  }
  if (!current || !(current.nodes ?? []).some((entry) => entry.id === intent.node)) {
    return;
  }
  selectNode(intent.node);
  await openMemberMap(intent.node);
}

// One subscription decides what a change redraws; handlers no longer call a render by hand.
store.subscribe((_, changed) => {
  if (changed.member) {
    renderMemberMapView();
  }
  syncUrl();
});

document.addEventListener('keydown', (event) => {
  const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '');
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    elements.filter.focus();
    elements.filter.select();
    return;
  }
  if (event.key === 'Escape') {
    closeOverflowMenu();
    if (!elements.memberView.hidden) {
      closeMemberMap();
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
  if (event.key === 'Enter' && !inField && state.mode === 'system' && selected) {
    const node = current?.nodes.find((candidate) => candidate.id === selected);
    if (node && !node.systemUnit) {
      // Enter opens the focused unit, matching a double-click.
      event.preventDefault();
      openUnit(selected);
      return;
    }
  }
  if (event.key === '?' && !inField) {
    event.preventDefault();
    toggleShortcuts();
    return;
  }
  if (inField || !elements.memberView.hidden) return;
  const key = event.key.toLowerCase();
  if (key === 'f' && selected) focus(view.cy, selected);
  else if (key === 'i') elements.tbImpact.click();
  else if (key === 'o' && state.mode === 'system' && state.systemUnit) elements.tbOutside.click();
  else if (key === 'u' && state.mode === 'system' && state.systemUnit) closeUnit();
  else if (key === 'p') elements.tbPath.click();
  else if (key === 'b') elements.tbBoundaries.click();
  else if (key === 'c' && state.mode === 'file') elements.tbCalls?.click();
  else if (key === 'h' && state.mode === 'file') elements.tbCoChange?.click();
  else if (key === 'l' && state.mode === 'file') elements.tbLabels?.click();
  else if (key === 's' && selected && isFileNode(selected)) viewSource(selected);
  else if (key === 't') elements.tbTimeline.click();
  else if (key === 'r') elements.tbReview.click();
  else if (key === 'v') elements.tbRisk.click();
  else if (key === 'n') elements.tbBranches.click();
  else if (key === 'g' && groupSelection.length >= 2) elements.tbDelegateGroup.click();
});

/** Show or hide recorded changes; selecting one compares it with the working tree. */
async function toggleTimeline() {
  if (!elements.timelinePanel.hidden) {
    elements.timelinePanel.hidden = true;
    return;
  }
  elements.timelinePanel.hidden = false;
  const query = state.repository ? `?repository=${encodeURIComponent(state.repository)}` : '';
  const result = await request(`/analysis/timeline${query}`);
  const draw = (metrics) =>
    renderTimeline(elements.timelinePanel, result, (commit) => {
      selectCommit(commit).catch((error) => {
        elements.status.textContent = `Error: ${error.message}`;
      });
    }, {
      selectedHash: selectedCommitHash,
      metrics,
      onClose: () => {
        elements.timelinePanel.hidden = true;
      },
    });
  draw(null);
  if (result?.available === false) {
    return;
  }
  // Per-commit change metrics arrive after the list: uncached commits are measured on the
  // server, so the timeline is usable first and the badges fill in when they are ready.
  const history = await request(`/analysis/change-metrics/history${query}`).catch(() => null);
  if (history?.available && !elements.timelinePanel.hidden) {
    draw(new Map(history.commits.map((entry) => [entry.commit.hash, entry.totals])));
  }
}

/**
 * Show branches against a base; selecting one reviews its work since it left the base.
 * The base starts as the server's choice (the remote's default branch) and follows the
 * panel's picker after that.
 */
async function toggleBranches() {
  if (!elements.branchesPanel.hidden) {
    elements.branchesPanel.hidden = true;
    return;
  }
  elements.branchesPanel.hidden = false;
  await loadBranches();
}

async function loadBranches() {
  const params = new URLSearchParams();
  if (state.repository) params.set('repository', state.repository);
  if (branchBase) params.set('base', branchBase);
  const query = params.toString() ? `?${params}` : '';
  const result = await request(`/analysis/branches${query}`);
  if (result?.available && result.base) branchBase = result.base.name;
  renderBranches(elements.branchesPanel, result, {
    selected: selectedBranchName,
    busy: branchesBusy,
    onSelect: (branch) => {
      selectBranch(branch.name).catch((error) => {
        elements.status.textContent = `Error: ${error.message}`;
      });
    },
    onBase: (name) => {
      branchBase = name;
      loadBranches().catch((error) => {
        elements.status.textContent = `Error: ${error.message}`;
      });
    },
    onFetch: () => runBranchAction('fetch', {}),
    onPull: () => runBranchAction('pull', { branch: result?.current }),
    onPullBranch: (branch) => runBranchAction('pull', { branch: branch.name }),
    onPush: (branch) => runBranchAction('push', { branch: branch.name }),
    onClose: () => {
      elements.branchesPanel.hidden = true;
    },
  });
}

/**
 * Run one branch action (fetch, pull, push, or fast-forward sync) and reload the listing.
 *
 * The server is the authority: it validates the ref, never force-pushes, and reports a
 * classified reason. The panel simply shows the message and refreshes its counts.
 */
async function runBranchAction(action, payload) {
  if (branchesBusy) return;
  if ((action === 'sync' || action === 'pull') && !payload.branch) {
    elements.status.textContent = `${action === 'pull' ? 'Pull' : 'Sync'} needs a checked-out branch.`;
    return;
  }
  branchesBusy = true;
  await loadBranches().catch((error) => {
    elements.status.textContent = `Error: ${error.message}`;
  });
  try {
    const params = state.repository ? `?repository=${encodeURIComponent(state.repository)}` : '';
    const response = await fetch(`${API_PATH}/analysis/branches/${action}${params}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error ?? `${response.status} ${response.statusText}`);
    }
    elements.status.textContent = body.available === false
      ? `${action} failed: ${body.detail}`
      : body.message;
  } catch (error) {
    elements.status.textContent = `Error: ${error.message}`;
  } finally {
    branchesBusy = false;
    await loadBranches().catch((error) => {
      elements.status.textContent = `Error: ${error.message}`;
    });
  }
}

/** Review a branch against the panel's base and annotate the map with its impact. */
async function selectBranch(name) {
  selectedBranchName = name;
  const against = branchBase ? `&against=${encodeURIComponent(branchBase)}` : '';
  await showReview(`?branch=${encodeURIComponent(name)}${against}`, null, name);
  for (const row of elements.branchesPanel.querySelectorAll('.branch-row')) {
    row.classList.toggle('selected-branch', row.querySelector('.branch')?.dataset.branch === name);
  }
}

/** Compare a revision with the working tree and annotate the map with the impact. */
async function selectCommit(commit) {
  selectedCommitHash = commit.hash;
  await showReview(`?base=${encodeURIComponent(commit.hash)}`, commit);
}

/**
 * Load a Git review and annotate the map with its change and impact classes.
 *
 * `query` is either empty (working tree) or `?base=<ref>` (that commit's own changes).
 * The review result is rendered verbatim; a file outside the graph is reported as such
 * instead of being drawn as if it had impact. Each navigation pushes the review it
 * replaces, so the panel's Back steps down through the reviews this session has shown.
 */
async function showReview(query, commit = null, branchName = null, { fromHistory = false } = {}) {
  const entry = { query, commit, branchName };
  if (!fromHistory && currentReviewRequest) {
    reviewHistory.push(currentReviewRequest);
  }
  currentReviewRequest = entry;
  const navigation = {
    canGoBack: reviewHistory.length > 0,
    onBack: reviewBack,
  };
  const separator = query ? '&' : '?';
  const repository = state.repository ? `${separator}repository=${encodeURIComponent(state.repository)}` : '';
  const ticket = ++reviewTicket;
  elements.reviewPanel.hidden = false;
  renderReviewLoading(elements.reviewPanel, { onClose: closeReview, ...navigation });
  let data;
  try {
    data = await request(`/analysis/review${query}${repository}`);
  } catch (error) {
    if (ticket === reviewTicket) {
      renderReview(elements.reviewPanel, { available: false, detail: error.message }, { onClose: closeReview, ...navigation });
    }
    throw error;
  }
  // The panel was closed, or another review started, while this one was computing.
  if (ticket !== reviewTicket) return;

  currentReview = data;
  if (data.available === false) {
    elements.reviewPanel.hidden = false;
    renderReview(elements.reviewPanel, data, { onClose: closeReview, ...navigation });
    return;
  }

  // A commit review compares two revisions, so the Structure section can name the
  // structural events. The document is the one `strabo report` prints.
  if (commit) {
    try {
      data.structural = await request(`/analysis/structural-diff?base=${encodeURIComponent(commit.hash)}${repository}`);
    } catch (error) {
      data.structural = { available: false, reason: 'git-error', detail: error.message };
    }
    if (ticket !== reviewTicket) return;
  }

  // The review's narrator affordance needs the status before it renders.
  if (narratorStatus === null) {
    narratorStatus = await fetchNarratorStatus();
  }
  // The panel was closed, or another review started, during the status fetch.
  if (ticket !== reviewTicket) return;

  const overlay = reviewOverlay(data);
  view.overlay(overlay.classes);
  elements.reviewPanel.hidden = false;
  renderReview(elements.reviewPanel, data, {
    onClose: closeReview,
    ...navigation,
    onSelect: (id) => selectNode(id),
    onOpenDiff: (file, entry) => viewDiff(file, reviewDiffSpec(data, entry), { status: entry.status }),
    narratorStatus,
    onNarrate: () => narrateReview(data),
    onOpenNarratorSettings: openNarratorSettings,
  });
  const label = branchName ?? (commit ? commit.shortHash : 'working tree');
  elements.status.textContent = `Review ${label}: ${overlay.summary}`;
}

/** Step the Review panel down to the review it replaced, if any. */
async function reviewBack() {
  const previous = reviewHistory.pop();
  if (!previous) {
    return;
  }
  try {
    await showReview(previous.query, previous.commit, previous.branchName, { fromHistory: true });
  } catch (error) {
    elements.status.textContent = `Error: ${error.message}`;
  }
}

/** Bumped by every review request and by closing, so a late response can tell it is stale. */
let reviewTicket = 0;

function closeReview() {
  reviewTicket += 1;
  currentReview = null;
  reviewHistory = [];
  currentReviewRequest = null;
  elements.reviewPanel.hidden = true;
  elements.reviewPanel.replaceChildren();
}

/** Review pending working-tree changes: staged, unstaged, and untracked. */
async function toggleReview() {
  if (!elements.reviewPanel.hidden) {
    closeReview();
    view.overlay(null);
    return;
  }
  try {
    await showReview('');
  } catch (error) {
    elements.status.textContent = `Error: ${error.message}`;
  }
}

/**
 * Load the dependency-risk report: advisories, licenses, and imported files.
 *
 * This is the one endpoint that may contact a third party (OSV.dev, deps.dev). It is
 * opt-in server-side; when disabled the report still lists dependencies and imports.
 */
async function showRisk() {
  const repository = state.repository ? `?repository=${encodeURIComponent(state.repository)}` : '';
  const report = await request(`/analysis/risk${repository}`);
  closeReview();
  elements.riskPanel.hidden = false;
  renderRisk(elements.riskPanel, report, {
    onClose: closeRisk,
    onSelect: (id) => selectNode(id),
  });
  elements.status.textContent = riskSummary(report);
}

function closeRisk() {
  elements.riskPanel.hidden = true;
  renderRisk(elements.riskPanel, null, {});
}

async function toggleRisk() {
  if (!elements.riskPanel.hidden) {
    closeRisk();
    return;
  }
  try {
    await showRisk();
  } catch (error) {
    elements.status.textContent = `Error: ${error.message}`;
  }
}

/* ------------------------------------------- Settings */

/** Server settings from `/settings`, or null while loading. */
let serverSettings = null;
let settingsStatus = '';
let settingsStatusError = false;
/** Provider presets for the Narrator section, from `/narrator`. */
let narratorPresets = [];
/** Transient Narrator-section UI state (key mode, fetched models, last test result). */
let narratorUiState = { presetId: null, keyMode: null, models: [], modelsNote: null, test: null };

/**
 * Apply one client preference: persist it, restyle the map, and reflect it in the settings
 * panel and the toolbar. Shared by the Settings checkboxes and the in-graph toolbar toggle.
 */
function setClientPref(key, value) {
  clientPrefs = { ...clientPrefs, [key]: value };
  writeSettings(clientPrefs);
  applyClientPrefs();
  updateLabelsButton();
  renderSettingsView();
  // The commit action is drawn by the impact overlay, so re-render it when it toggles.
  if (key === 'commitEnabled' && state.overlay === 'impact') {
    applyOverlay();
  }
}

function renderSettingsView() {
  if (!elements.settingsPanel) return;
  renderSettings(elements.settingsPanel, {
    prefs: clientPrefs,
    server: serverSettings,
    presets: narratorPresets,
    narratorState: narratorUiState,
    onNarratorState: (patch) => {
      narratorUiState = { ...narratorUiState, ...patch };
      renderSettingsView();
    },
    status: settingsStatus || null,
    statusError: settingsStatusError,
    onPref: (key, value) => setClientPref(key, value),
    onSaveCeiling: (value) =>
      saveServerSettings({ scanCeiling: value }, value ? 'Scan ceiling updated.' : 'Scan ceiling reset.'),
    onToggleRisk: (value) => saveServerSettings({ riskOnline: value }, 'Online risk lookup updated.'),
    onNarratorChange: async (patch) => {
      await saveServerSettings({ narrator: patch }, 'Narrator updated.');
      // The server can change more than the patch asked for: a new endpoint host clears the
      // stored key. Re-read `/settings` so the panel shows the key source it now has.
      await refreshNarratorSettings();
      renderSettingsView();
      await refreshNarratorStatus();
    },
    onFetchModels: async ({ endpoint, model }) => {
      const params = new URLSearchParams();
      if (endpoint) params.set('endpoint', endpoint);
      if (model) params.set('model', model);
      const response = await fetch(`${API_PATH}/narrator/models?${params.toString()}`);
      const body = await response.json().catch(() => ({}));
      return response.ok ? body : { models: [], error: body.error ?? `Could not list models (${response.status}).` };
    },
    onTestConnection: async ({ endpoint, model }) => {
      const response = await fetch(`${API_PATH}/narrator/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, model }),
      });
      return response.json().catch(() => ({ ok: false, reason: 'provider-error', detail: 'no response' }));
    },
    onStoreKey: async (key) => {
      const response = await fetch(`${API_PATH}/narrator/key`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error ?? `Could not store the key (${response.status}).`);
      }
      settingsStatus = 'Key stored for this host.';
      settingsStatusError = false;
      await refreshNarratorSettings();
      renderSettingsView();
      return body;
    },
    onClearKey: async () => {
      await fetch(`${API_PATH}/narrator/key`, { method: 'DELETE' }).catch(() => {});
      await refreshNarratorSettings();
      renderSettingsView();
    },
  });
}

/** Re-read `/settings` so the Narrator section reflects a server change. */
async function refreshNarratorSettings() {
  try {
    serverSettings = await request('/settings');
  } catch {
    // Keep the previous view; a failed refresh is not worth an error banner.
  }
}

/** Re-read `/narrator` and refresh the Functions-tab affordance after a settings change. */
async function refreshNarratorStatus() {
  narratorStatus = await fetchNarratorStatus();
}

/** Write one server setting, then re-render; failures are shown in the panel, not thrown. */
async function saveServerSettings(patch, successMessage) {
  try {
    await putServerSettings(patch);
    settingsStatus = successMessage;
    settingsStatusError = false;
  } catch (error) {
    settingsStatus = error.message;
    settingsStatusError = true;
  }
  renderSettingsView();
  // The repository picker filters against the ceiling; refresh it so a change shows there.
  loadCatalogue().catch(() => {});
}

async function putServerSettings(patch) {
  const response = await fetch(`${API_PATH}/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? `Could not save settings (${response.status}).`);
  }
  serverSettings = body;
  return body;
}

/** Open the settings window and load the current server values. */
async function openSettings() {
  settingsStatus = '';
  settingsStatusError = false;
  renderSettingsView();
  try {
    serverSettings = await request('/settings');
    // Presets arrive with the narrator status; fetch once if the Functions tab never did.
    if (narratorPresets.length === 0) {
      narratorStatus = await fetchNarratorStatus();
    }
  } catch (error) {
    settingsStatus = error.message;
    settingsStatusError = true;
  }
  renderSettingsView();
}

/**
 * Open the workspace window and load the declared multi-repo report.
 *
 * The workspace is fixed by the server's config; the panel is read-only and a server error
 * (invalid config, a root outside the ceiling) is shown in the panel rather than thrown.
 */
async function showWorkspace() {
  elements.workspacePanel.hidden = false;
  try {
    workspaceReport = await request('/workspace');
    workspaceTools.databases = await request('/workspace/databases').catch(() => null);
    renderWorkspaceView();
    // Ring the files on this map that the report records on one side of a cross-repo flow.
    view.crossRepo(crossRepoNodeIds(workspaceReport, (current?.nodes ?? []).map((node) => node.id)));
  } catch (error) {
    workspaceReport = null;
    renderWorkspace(elements.workspacePanel, null, { onClose: closeWorkspace });
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent = error.message;
    elements.workspacePanel.append(note);
  }
  refreshDock();
}

/** The report and the compatibility tools' state; the tools re-render after each action. */
let workspaceReport = null;
const workspaceTools = {
  base: 'HEAD',
  busy: '',
  error: '',
  compat: null,
  preflight: null,
  databases: null,
  live: null,
  confirming: null,
  scriptHref: '',
};

function renderWorkspaceView() {
  workspaceTools.scriptHref = `${API_PATH}/workspace/preflight?base=${encodeURIComponent(workspaceTools.base || 'HEAD')}&format=sql`;
  renderWorkspace(elements.workspacePanel, workspaceReport, {
    onClose: closeWorkspace,
    tools: workspaceTools,
    onBase: (value) => {
      // Typing must not rebuild the panel, or the field would lose focus.
      workspaceTools.base = value;
    },
    onCompat: () => runWorkspaceTool('comparing revisions', async () => {
      workspaceTools.compat = await request(`/workspace/compat?base=${encodeURIComponent(workspaceTools.base || 'HEAD')}`);
    }),
    onPreflight: () => runWorkspaceTool('building preflight queries', async () => {
      workspaceTools.preflight = await request(`/workspace/preflight?base=${encodeURIComponent(workspaceTools.base || 'HEAD')}`);
    }),
    onConfirmRun: (name) => {
      workspaceTools.confirming = name;
      renderWorkspaceView();
    },
    onCancelRun: () => {
      workspaceTools.confirming = null;
      renderWorkspaceView();
    },
    onRun: (name) => runWorkspaceTool('running read-only checks', async () => {
      workspaceTools.confirming = null;
      workspaceTools.preflight = await postWorkspace('/workspace/preflight/run', {
        database: name,
        base: workspaceTools.base || 'HEAD',
      });
      workspaceTools.databases = await request('/workspace/databases').catch(() => workspaceTools.databases);
    }),
    onLive: (name) => runWorkspaceTool('reading the live schema', async () => {
      workspaceTools.live = await postWorkspace('/workspace/live/schema', { database: name });
      workspaceTools.databases = await request('/workspace/databases').catch(() => workspaceTools.databases);
    }),
  });
}

/** Run one tool action with a busy caption, keep any error in the panel, and redraw. */
async function runWorkspaceTool(label, action) {
  workspaceTools.busy = label;
  workspaceTools.error = '';
  renderWorkspaceView();
  try {
    await action();
  } catch (error) {
    workspaceTools.error = error.message;
  } finally {
    workspaceTools.busy = '';
    renderWorkspaceView();
  }
}

async function postWorkspace(path, body) {
  const response = await fetch(`${API_PATH}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? `${response.status} ${response.statusText}`);
  }
  return payload;
}

function closeWorkspace() {
  elements.workspacePanel.hidden = true;
  view.crossRepo(null);
  refreshDock();
}

/**
 * Open the Repository passport: the opening summary for the current repository.
 *
 * The passport is server-computed from the same graph the map draws, so the panel and the
 * canvas can never disagree. A server error is shown in the panel, not thrown.
 */
async function showPassport() {
  elements.passportPanel.hidden = false;
  try {
    const report = await request(`/analysis/passport${state.repository ? `?repository=${encodeURIComponent(state.repository)}` : ''}`);
    renderRepositoryPassport(elements.passportPanel, report, {
      onSelect: (id) => selectNode(id),
      onOpenRoute: () => showRoute(),
      onClose: closePassport,
    });
  } catch (error) {
    renderRepositoryPassport(elements.passportPanel, null, { onClose: closePassport });
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent = error.message;
    elements.passportPanel.append(note);
  }
  refreshDock();
}

function closePassport() {
  elements.passportPanel.hidden = true;
  refreshDock();
}

/**
 * Open the reading route: the ordered outward walk from the repository's entry points.
 *
 * The route is server-computed from recorded import edges, so the panel cannot order a file
 * ahead of one that imports it. The step is remembered per repository in localStorage, and a
 * file passed in from a Module Passport (opt-in) starts the walk there when it is routed.
 */
async function showRoute(preferredFile) {
  elements.routePanel.hidden = false;
  try {
    const report = await request(`/analysis/route${state.repository ? `?repository=${encodeURIComponent(state.repository)}` : ''}`);
    currentRoute = report;
    const steps = routeSteps(report);
    const preferred = preferredFile ? routeIndexOf(report, preferredFile) : -1;
    routeIndex =
      preferred >= 0
        ? clampRouteIndex(preferred, steps.length)
        : clampRouteIndex(readRouteProgress(window.localStorage, state.repository) ?? 0, steps.length);
    renderRouteView();
  } catch (error) {
    currentRoute = null;
    renderRoutePanel(elements.routePanel, null, {}, {});
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent = error.message;
    elements.routePanel.append(note);
  }
  refreshDock();
}

function renderRouteView() {
  renderRoutePanel(elements.routePanel, currentRoute, {
    index: routeIndex,
    ...(narratorStatus?.configured === false ? { narratorConfigured: false } : {}),
  }, {
    onStep: (index) => stepRoute(index),
    onFocus: (file) => focusRouteFile(file),
    onNarrateTour: () => narrateRouteTour(),
  });
}

/** Move to a step, remember it, redraw, and put the file's node on the map. */
function stepRoute(index) {
  const steps = routeSteps(currentRoute);
  routeIndex = clampRouteIndex(index, steps.length);
  writeRouteProgress(window.localStorage, state.repository, routeIndex);
  renderRouteView();
  const step = steps[routeIndex];
  if (step) {
    focusRouteFile(step.file);
  }
}

/**
 * Select a routed file, so the map and the Module Passport follow the step. A file the current
 * view does not draw (for example a file inside a collapsed unit) is named in the status line
 * rather than silently selected off-screen.
 */
function focusRouteFile(file) {
  const visible = (current?.nodes ?? []).some((node) => node.id === file);
  if (!visible) {
    elements.status.textContent = `${file} is on the route; open its unit to see it on the map.`;
    return;
  }
  selectNode(file);
}

function closeRoute() {
  elements.routePanel.hidden = true;
  refreshDock();
}

/**
 * Open the passport once for a repository the operator has not seen before. The set of
 * seen roots is browser-local, so the opening screen appears on a first visit and never
 * again for that repository.
 */
const PASSPORT_SEEN_PREFIX = 'strabo.passport.seen.';

function passportSeen(repository) {
  try {
    return window.localStorage.getItem(`${PASSPORT_SEEN_PREFIX}${repository ?? 'default'}`) === '1';
  } catch {
    return true;
  }
}

function markPassportSeen(repository) {
  try {
    window.localStorage.setItem(`${PASSPORT_SEEN_PREFIX}${repository ?? 'default'}`, '1');
  } catch {
    // Storage is optional; the passport simply reappears next session.
  }
}

async function maybeOpenPassport() {
  if (!state.repository || passportSeen(state.repository)) {
    return;
  }
  markPassportSeen(state.repository);
  await showPassport();
}

function clearOverlay() {
  state.overlay = 'none';
  elements.overlay.value = 'none';
  view.overlay(null);
  renderOverlayPanel(elements.overlayPanel, '', null);
  refreshDock();
}

function applyStripFilter(filter) {
  state.filter = filter;
  elements.filter.value = filter;
  applyFilterToView();
}

function tracePath(from, to) {
  const path = findPath(current, from, to);
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
  if (!current || !edgeId) {
    view.clearEdge();
    selectedEdgeId = null;
    renderEdgeEvidence(elements.edgePanel, null);
    refreshDock();
    return;
  }
  selectedEdgeId = edgeId;
  const evidence = edgeEvidenceFor(current, edgeId);
  renderEdgeEvidence(elements.edgePanel, evidence, {
    onSelect: (id) => selectNode(id),
    onTrace: (from, to) => tracePath(from, to),
    ...(evidence && isFileNode(evidence.source)
      ? { onViewSource: (file, line) => viewSource(file, { line }) }
      : {}),
    onClear: () => {
      view.clearEdge();
      selectedEdgeId = null;
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

const OVERLAY_TITLES = {
  impact: 'Change impact',
  cycles: 'Cycles',
  'test-reach': 'Test reach',
  architecture: 'Architecture health',
  hotspots: 'Function hotspots',
  'module-depth': 'Module depth',
  ownership: 'Ownership',
  smells: 'Smells',
};

const OVERLAY_ENDPOINTS = {
  impact: '/analysis/impact',
  cycles: '/analysis/cycles',
  'test-reach': '/analysis/test-reach',
  architecture: '/analysis/architecture-health',
  hotspots: '/analysis/functions',
  'module-depth': '/analysis/module-depth',
  ownership: '/analysis/ownership',
  smells: '/analysis/smells',
};

/** Overlays that annotate file nodes and therefore need Files mode. */
const FILE_MODE_OVERLAYS = ['impact', 'cycles', 'test-reach', 'module-depth', 'ownership', 'smells'];

/**
 * Load the selected review analysis and annotate the graph. Overlays annotate only what
 * the server reported; they never invent nodes or edges.
 */
async function applyOverlay(generation) {
  const kind = state.overlay;
  if (kind === 'none') {
    view.overlay(null);
    renderOverlayPanel(elements.overlayPanel, '', null);
    refreshDock();
    return;
  }
  const query = state.repository ? `?repository=${encodeURIComponent(state.repository)}` : '';
  const data = await request(`${OVERLAY_ENDPOINTS[kind]}${query}`);
  if (generation !== undefined && generation !== scanGeneration) {
    return;
  }
  const overlay = overlayFor(kind, data);
  view.overlay(overlay.classes);
  // The Change impact list is the working tree's own changes, so it is where the opt-in
  // commit action lives. It generates a message with the narrator, then commits and pushes.
  const actions = [];
  if (kind === 'impact' && clientPrefs.commitEnabled) {
    actions.push({
      label: 'Commit…',
      title: 'Generate a commit message with the narrator, then commit and push',
      onClick: () =>
        openCommitDialog({
          repository: state.repository,
          onCommitted: () => applyOverlay(),
        }),
    });
  }
  renderOverlayPanel(elements.overlayPanel, OVERLAY_TITLES[kind], overlay, {
    kind,
    onClose: clearOverlay,
    onSelect: (id) => selectNode(id),
    ...(actions.length > 0 ? { actions } : {}),
  });
  refreshDock();
}

/**
 * Fill the unit cards' hotspot counts from the function hotspot report (L22).
 *
 * Hotspots need symbol extraction, so the server leaves them null on the graph model; this
 * joins the same report the hotspot overlay uses, once per repository, and refreshes the
 * cards only if the view has not moved on.
 */
let unitHotspotCache = null;
async function enrichUnitCards(generation) {
  const repository = current?.repository?.root ?? null;
  if (!current?.unitCards?.length || unitHotspotCache?.repository === repository) {
    return;
  }
  try {
    const query = state.repository ? `?repository=${encodeURIComponent(state.repository)}` : '';
    const report = await request(`/analysis/functions${query}`);
    if (generation !== scanGeneration || current?.repository?.root !== repository) {
      return;
    }
    unitHotspotCache = { repository, report };
    view.setUnitCards(withUnitHotspots(current.unitCards, report));
  } catch {
    // The card keeps `hotspots —`; a missing analysis must not fail the map.
  }
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
  writeViewPrefs();
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
  applyViewPrefs();
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
  const node = current?.nodes.find((candidate) => candidate.id === id);
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

/**
 * Swap the map between import coupling and the recorded function-call graph.
 *
 * Outside file mode there are no call edges, so the lens is forced back to imports rather
 * than emptying the map; the remembered choice resumes when file mode returns.
 */
function applyEdgeKindLens() {
  view.setEdgeKind(state.mode === 'file' ? state.edgeKind : 'imports');
}

/**
 * Re-apply the co-change lens after a render. The report travels with the view, so this
 * only reflects the mode: outside file mode the co-change edges are hidden.
 */
function applyCoChangeLens() {
  if (state.mode !== 'file' || !state.coChange) {
    view.setCoChange(null, false);
    return;
  }
  if (coChangeReport) {
    view.setCoChange(coChangeReport, true);
  }
}

/**
 * Toggle the calls lens. It applies without a rescan: call edges are already in the model,
 * so this only changes which kind the map draws.
 */
function toggleEdgeKind() {
  if (state.mode !== 'file') {
    return;
  }
  state.edgeKind = state.edgeKind === 'calls' ? 'imports' : 'calls';
  updateEdgeKindButton();
  applyEdgeKindLens();
  schedulePrefsSave();
}

/** The calls button only appears in file mode; its pressed state follows the lens. */
function updateEdgeKindButton() {
  if (!elements.tbCalls) {
    return;
  }
  const showCalls = state.mode === 'file' && state.edgeKind === 'calls';
  elements.tbCalls.classList.toggle('active', showCalls);
  elements.tbCalls.setAttribute('aria-pressed', String(showCalls));
}

/** The co-change report, fetched once per repository when the lens is first turned on. */
let coChangeReport = null;
let coChangeRepository = null;

/**
 * Toggle the co-change coupling lens.
 *
 * Off by default because it needs a git history pass, so this fetches the report the first
 * time the lens is turned on for a repository and reuses it after. A map with no report for
 * the repository shows no co-change edges rather than inventing them.
 */
async function toggleCoChange() {
  state.coChange = !state.coChange;
  updateCoChangeButton();
  schedulePrefsSave();
  if (!state.coChange) {
    view.setCoChange(null, false);
    return;
  }
  const repository = state.repository ?? null;
  if (!coChangeReport || coChangeRepository !== repository) {
    try {
      const query = repository ? `?repository=${encodeURIComponent(repository)}` : '';
      coChangeReport = await request(`/analysis/co-change${query}`);
      coChangeRepository = repository;
    } catch (error) {
      state.coChange = false;
      updateCoChangeButton();
      elements.status.textContent = `Error: ${error.message}`;
      return;
    }
  }
  view.setCoChange(coChangeReport, true);
}

/** The co-change button appears in file mode; its pressed state follows the lens. */
function updateCoChangeButton() {
  if (!elements.tbCoChange) {
    return;
  }
  const shown = state.mode === 'file';
  elements.tbCoChange.hidden = !shown;
  elements.tbCoChange.classList.toggle('active', shown && state.coChange);
  elements.tbCoChange.setAttribute('aria-pressed', String(shown && state.coChange));
}

/** The labels button appears in file mode; its pressed state follows the preference. */
function updateLabelsButton() {
  if (!elements.tbLabels) {
    return;
  }
  const shown = state.mode === 'file';
  const on = shown && Boolean(clientPrefs.allLabels);
  elements.tbLabels.hidden = !shown;
  elements.tbLabels.classList.toggle('active', on);
  elements.tbLabels.setAttribute('aria-pressed', String(on));
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
  elements.tbFocus.disabled = !selected;
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
    const node = current?.nodes.find((candidate) => candidate.id === id);
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
  const url = fileWebUrl(current?.repository, id);
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
  const node = (current?.nodes ?? []).find((candidate) => candidate.id === id);
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
  floatingWindows.find((controller) => controller.key === 'source')?.open();
  loadSource(sourceView.mode).catch(() => {});
}

/** Open the viewer straight on a change; `spec` names the two sides for `/diff`. */
function viewDiff(file, spec, options = {}) {
  viewSource(file, { ...options, diffSpec: spec });
}

/** Fetch the side the viewer is showing; a late response is dropped if the target moved. */
async function loadSource(mode) {
  const view = sourceView;
  if (!view) {
    return;
  }
  view.mode = mode;
  view.loading = true;
  view.error = null;
  sourceRender();
  const query = new URLSearchParams({ file: view.file });
  if (state.repository) {
    query.set('repository', state.repository);
  }
  try {
    if (mode === 'diff') {
      for (const [key, value] of Object.entries(view.diffSpec ?? {})) {
        query.set(key, String(value));
      }
      const body = await request(`/diff?${query.toString()}`);
      if (sourceView !== view) return;
      if (body.available === false) view.error = body.detail ?? body.reason;
      else view.diff = body.diff;
    } else {
      if (view.ref) query.set('ref', view.ref);
      const body = await request(`/source?${query.toString()}`);
      if (sourceView !== view) return;
      view.content = body.content;
    }
  } catch (error) {
    if (sourceView !== view) return;
    view.error = error.message;
  } finally {
    if (sourceView === view) {
      view.loading = false;
      sourceRender();
    }
  }
}

function sourceRender() {
  if (!sourceView) {
    return;
  }
  renderSource(elements.sourcePanel, sourceView, {
    onClose: () => floatingWindows.find((controller) => controller.key === 'source')?.close(),
    onShowFile: sourceView.hasDiff && sourceView.mode === 'diff' ? () => loadSource('content') : null,
    onShowDiff: sourceView.hasDiff && sourceView.mode === 'content' ? () => loadSource('diff') : null,
  });
}

/** Clear the panel but keep the target, so the dock chip can reopen the last file. */
function closeSource() {
  elements.sourcePanel.hidden = true;
  elements.sourcePanel.replaceChildren();
}

/** Which two sides a review row's change is between. */
function reviewDiffSpec(result, file) {
  if (result?.kind === 'commit' && result.ref) {
    return { ref: result.ref };
  }
  if (result?.kind === 'branch' && result.branch) {
    return { base: result.branch.mergeBase, head: result.branch.tipHash };
  }
  if (file?.group === 'staged') return { staged: 1 };
  if (file?.group === 'untracked') return { untracked: 1 };
  return {};
}

elements.repository.addEventListener('change', () => {
  const root = elements.repository.value;
  if (!root) {
    return;
  }
  // Save outgoing view settings before switching, then restore the new repo's.
  writeViewPrefs();
  state.repository = root;
  state.prefix = '';
  state.filter = '';
  elements.filter.value = '';
  elements.forget.disabled = false;
  applyViewPrefs();
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
  writeViewPrefs();
  scan();
});
if (elements.tier) {
  elements.tier.addEventListener('change', () => {
    state.tier = elements.tier.value;
    // The tier lens is per file; the aggregate modes switch to file detail to show it.
    if (state.tier !== 'off' && state.mode !== 'file') {
      state.mode = 'file';
      elements.detail.value = 'file';
      writeViewPrefs();
      scan();
      return;
    }
    applyTierLens();
  });
}
elements.refresh.addEventListener('click', () => scan({ refresh: true }));
elements.overlay.addEventListener('change', () => {
  state.overlay = elements.overlay.value;
  if (state.overlay === 'none') {
    writeViewPrefs();
    applyOverlay();
    return;
  }
  // Node overlays annotate file nodes; architecture health is repository-level.
  const needsFileMode = FILE_MODE_OVERLAYS.includes(state.overlay);
  if (needsFileMode && state.mode !== 'file') {
    state.mode = 'file';
    elements.detail.value = 'file';
    writeViewPrefs();
    scan();
    return;
  }
  writeViewPrefs();
  applyOverlay();
});
elements.filter.addEventListener('input', () => {
  dismissHint();
  state.filter = elements.filter.value;
  applyFilterToView();
  schedulePrefsSave();
});
if (elements.filterClear) {
  elements.filterClear.addEventListener('click', () => {
    state.filter = '';
    elements.filter.value = '';
    applyFilterToView();
    writeViewPrefs();
    elements.filter.focus();
  });
}
if (elements.graphEmptyClear) {
  elements.graphEmptyClear.addEventListener('click', () => {
    state.filter = '';
    elements.filter.value = '';
    applyFilterToView();
    writeViewPrefs();
  });
}
if (elements.zoomIn) elements.zoomIn.addEventListener('click', () => zoomIn(view.cy));
if (elements.zoomOut) elements.zoomOut.addEventListener('click', () => zoomOut(view.cy));
if (elements.zoomFit) elements.zoomFit.addEventListener('click', () => fit(view.cy));
elements.diagnosticsToggle.addEventListener('click', () => {
  const hidden = elements.diagnostics.hidden;
  elements.diagnostics.hidden = !hidden;
  elements.diagnosticsToggle.setAttribute('aria-expanded', String(hidden));
  if (hidden) startRuntimeReadout();
  else stopRuntimeReadout();
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
  if (!elements.tooltip || !current) return;
  const node = current.nodes.find((candidate) => candidate.id === id);
  if (!node) return;
  elements.tooltip.replaceChildren();
  const kind = node.kind ?? '';
  // L20: a unit or shelf reads in unit vocabulary, not as a file with a blast radius.
  const unit = kind === 'unit' ? unitHoverFacts(current, id) : null;
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
  const node = current?.nodes.find((candidate) => candidate.id === id);
  const unit = node?.kind === 'unit' ? unitHoverFacts(current, id) : null;
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
  if (selected) {
    focus(view.cy, selected);
  }
});
elements.tbImpact.addEventListener('click', () => {
  elements.overlay.value = 'impact';
  elements.overlay.dispatchEvent(new Event('change'));
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
if (elements.tbCalls) {
  elements.tbCalls.addEventListener('click', toggleEdgeKind);
}
if (elements.tbCoChange) {
  elements.tbCoChange.addEventListener('click', () => {
    toggleCoChange().catch((error) => {
      elements.status.textContent = `Error: ${error.message}`;
    });
  });
}
if (elements.tbLabels) {
  elements.tbLabels.addEventListener('click', () => setClientPref('allLabels', !clientPrefs.allLabels));
}
elements.tbBranches.addEventListener('click', () => {
  toggleBranches().catch((error) => {
    elements.status.textContent = `Error: ${error.message}`;
  });
});

elements.tbTimeline.addEventListener('click', () => {
  toggleTimeline().catch((error) => {
    elements.status.textContent = `Error: ${error.message}`;
  });
});
elements.tbReview.addEventListener('click', () => {
  toggleReview().catch((error) => {
    elements.status.textContent = `Error: ${error.message}`;
  });
});
elements.tbRisk.addEventListener('click', () => {
  toggleRisk().catch((error) => {
    elements.status.textContent = `Error: ${error.message}`;
  });
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
  const items = overflowItems();
  items.forEach((item, index) => {
    item.tabIndex = index === 0 ? 0 : -1;
  });
  items[0]?.focus();
}

if (elements.tbOverflow) {
  elements.tbOverflow.addEventListener('click', (event) => {
    event.stopPropagation();
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

/** Show the keyboard cheat-sheet in its own floating window. Declared with `function` so
 * the key handler above can call it before `floatingWindows` is assigned. */
function toggleShortcuts() {
  floatingWindows?.find?.((controller) => controller.key === 'shortcuts')?.toggle();
}

/** Open Settings at the Narrator section, the one call to action when the narrator is off. */
function openNarratorSettings() {
  floatingWindows?.find?.((controller) => controller.key === 'settings')?.open?.();
  // The panel renders asynchronously; bring the Narrator section into view once it has.
  const reveal = (attempt = 0) => {
    const target = elements.settingsPanel?.querySelector('#setting-narrator');
    if (target) {
      target.scrollIntoView?.({ block: 'start' });
      return;
    }
    if (attempt < 10) {
      setTimeout(() => reveal(attempt + 1), 50);
    }
  };
  setTimeout(() => reveal(), 50);
}

/* ------------------------------------------- Agent delegation (right-click) */

/** Recorded facts for a node, from the passport the scan computed. */
function nodeDelegateTarget(id) {
  const passport = current ? passportFor(current, id) : null;
  const node = current?.nodes.find((candidate) => candidate.id === id);
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
  const items = groupSelection.map((id) => nodeDelegateTarget(id));
  return { kind: 'group', label: `${items.length} file(s)`, items };
}

/** Reflect cytoscape's native selection in the toolbar chip and delegate button. */
function updateGroupUI(ids) {
  groupSelection = ids ?? [];
  const count = groupSelection.length;
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
  const evidence = current ? edgeEvidenceFor(current, edgeId) : null;
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
  const file = memberData?.file ?? selected;
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
    label: detail ?? graphSummary(current ?? { nodes: [], edges: [] }),
    detail: detail ?? undefined,
    evidence: [
      current ? graphSummary(current) : 'No scan loaded.',
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
  return selected ? nodeDelegateTarget(selected) : viewDelegateTarget();
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
  if (reviewPanel && currentReview?.available) {
    return reviewDelegateTarget(currentReview);
  }
  const overlayItem = node.closest('#overlay-panel [data-delegate-overlay-item]');
  if (overlayItem) {
    return overlayDelegateTarget(overlayItem);
  }
  const edgePanel = node.closest('#edge-panel');
  if (edgePanel && selectedEdgeId) {
    return edgeDelegateTarget(selectedEdgeId);
  }
  const card = node.closest('#member-view .member-card');
  if (card) {
    return memberDelegateTarget(card);
  }
  if (node.closest('#inspector') && selected) {
    return nodeDelegateTarget(selected);
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

/** Open the agent's interactive TUI on the delegated item, after the prompt is reviewed. */
async function delegateToAgent(agent, target) {
  const repository = current?.repository ?? null;
  const prompt = buildAgentPrompt({ agent, repository, target });
  const title = (target.label ?? target.id ?? 'repository view').slice(0, 80);
  const reviewed = await showPromptReview({ agent, title, prompt });
  if (reviewed === null) {
    return;
  }
  try {
    await launchAgent(agent, {
      repository: state.repository ?? repository?.root,
      target: { kind: target.kind, id: target.id, label: target.label },
      prompt: reviewed,
      title,
    });
    showToast(`Opened ${agent} on ${title} — edit the prefilled task, then send.`);
  } catch (error) {
    showToast(`Could not open a terminal (${error.message}).`, {
      label: 'Copy prompt',
      onClick: async () => {
        await copyText(reviewed);
        showToast('Prompt copied — paste it into your agent.');
      },
    });
  }
}

/**
 * The Narrate entry for a right-clicked node, listed first with a separator, or nothing for a
 * target the narrator cannot describe. While the narrator is off or failing the entry stays in
 * the menu but inactive, with the reason as its tooltip, like the Narrate buttons.
 */
function narrateMenuItems(target) {
  if (target?.kind !== 'node') {
    return [];
  }
  const menuState = isNarratable(target.id)
    ? narratorMenuState(narratorStatus)
    : { enabled: false, hint: 'Narrate works on a file or a System unit — open the folder to reach its files.' };
  return [
    {
      label: '✦ Narrate',
      hint: menuState.enabled ? 'model-generated' : 'unavailable',
      ...(menuState.enabled
        ? { action: () => narrateNode(target.id) }
        : { title: menuState.hint }),
    },
    { separator: true },
  ];
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
  const repository = current?.repository ?? null;
  const menuTitle = (target.label ?? target.id ?? 'repository view').slice(0, 80);
  const promptFor = (agent) => buildAgentPrompt({ agent, repository, target });
  showContextMenu({
    x,
    y,
    title: menuTitle,
    items: [
      ...narrateMenuItems(target),
      ...layoutMenuItems(target),
      { label: '▶ Delegate to OpenCode', hint: 'opens TUI', action: () => delegateToAgent('opencode', target) },
      { label: '▶ Delegate to Claude', hint: 'opens TUI', action: () => delegateToAgent('claude', target) },
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
  if (target.kind === 'node' && target.id && groupSelection.length >= 2 && groupSelection.includes(target.id)) {
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
 * Turn every auxiliary panel into a floating window. The panels keep their ids and
 * `hidden` semantics; these handlers only supply app-aware open/close so the dock can
 * restore a panel without desyncing overlay or selection state.
 */
const floatingWindows = initFloatingWindows({
  dock: document.getElementById('float-dock'),
  panels: [
    {
      key: 'review',
      element: elements.reviewPanel,
      title: 'Review',
      dockLabel: 'Review',
      width: 400,
      // The heading's own text, without the dismiss button's `×`.
      titleFrom: (panel) => panel.querySelector('h3')?.firstChild?.textContent?.trim() ?? '',
      onOpen: () => {
        if (elements.reviewPanel.hidden) toggleReview();
      },
      onClose: () => {
        closeReview();
        view.overlay(null);
      },
    },
    {
      key: 'risk',
      element: elements.riskPanel,
      title: 'Dependency risk',
      dockLabel: 'Risk',
      width: 400,
      onOpen: () => {
        if (elements.riskPanel.hidden) toggleRisk();
      },
      onClose: () => closeRisk(),
    },
    {
      key: 'timeline',
      element: elements.timelinePanel,
      title: 'Timeline',
      dockLabel: 'Timeline',
      width: 380,
      onOpen: () => {
        if (elements.timelinePanel.hidden) {
          toggleTimeline().catch((error) => {
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
      width: 420,
      onOpen: () => {
        if (elements.branchesPanel.hidden) {
          toggleBranches().catch((error) => {
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
      width: 360,
      titleFrom: (panel) => (panel.querySelector('h3')?.textContent ?? '').split(' · ')[0].trim(),
      canOpen: () => state.overlay !== 'none',
      blockedTitle: 'Select an overlay (Review dropdown) to open Overlay',
      onBlocked: () => {
        elements.status.textContent = 'Select an overlay first — Overlay has nothing to show.';
      },
      onClose: () => clearOverlay(),
    },
    {
      key: 'edge',
      element: elements.edgePanel,
      title: 'Edge',
      dockLabel: 'Edge',
      width: 360,
      titleFrom: (panel) => panel.querySelector('h3')?.textContent?.trim() ?? '',
      canOpen: () => Boolean(selectedEdgeId),
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
      width: 720,
      height: 640,
      canOpen: () => Boolean(sourceView),
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
      width: 340,
    },
    {
      key: 'inspector',
      element: elements.inspector,
      title: 'Module passport',
      dockLabel: 'Passport',
      width: 384,
      canOpen: () => Boolean(selected),
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
      width: 420,
      titleFrom: (panel) => panel.querySelector('h3')?.textContent?.trim() ?? '',
      onOpen: () => {
        startRuntimeReadout();
      },
      onClose: () => {
        elements.diagnostics.hidden = true;
        elements.diagnosticsToggle.setAttribute('aria-expanded', 'false');
        stopRuntimeReadout();
      },
    },
    {
      key: 'settings',
      element: elements.settingsPanel,
      title: 'Settings',
      dockLabel: 'Settings',
      width: 420,
      onOpen: () => {
        if (elements.settingsPanel.hidden) {
          openSettings().catch((error) => {
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
      width: 900,
      height: 700,
      center: true,
      canOpen: () => Boolean(memberData),
      blockedTitle: 'Open a member map from a module passport first',
      onBlocked: () => {
        elements.status.textContent = 'Open a member map from a module passport first.';
      },
      onOpen: () => renderMemberMapView(),
      onClose: () => closeMemberMap(),
    },
    {
      key: 'workspace',
      element: elements.workspacePanel,
      title: 'Workspace',
      dockLabel: 'Workspace',
      width: 460,
      onOpen: () => {
        showWorkspace().catch(() => {});
      },
      onClose: () => closeWorkspace(),
    },
    {
      key: 'passport',
      element: elements.passportPanel,
      title: 'Repository passport',
      dockLabel: 'Passport',
      width: 460,
      onOpen: () => {
        showPassport().catch(() => {});
      },
      onClose: () => closePassport(),
    },
    {
      key: 'route',
      element: elements.routePanel,
      title: 'Reading route',
      dockLabel: 'Route',
      width: 440,
      onOpen: () => {
        showRoute().catch(() => {});
      },
      onClose: () => closeRoute(),
    },
  ],
});

function refreshDock() {
  try {
    floatingWindows?.refresh?.();
  } catch {
    // Dock not yet initialized; initial renderDock() covers startup.
  }
}

elements.settingsToggle?.addEventListener('click', () => {
  floatingWindows.find((controller) => controller.key === 'settings')?.toggle();
});

// Follow the OS theme/motion preference while the theme is set to "system".
watchSystemPreferences(clientPrefs, () => applyClientPrefs());

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
    model: () => current,
    renderedGeneration: () => state.renderedGeneration,
    openMemberMap: (id) => openMemberMap(id),
    closeMemberMap: () => closeMemberMap(),
    memberUI,
    memberData: () => memberData,
    memberStepCount,
    review: () => showReview(''),
    reviewCommit: (ref) => showReview(`?base=${encodeURIComponent(ref)}`),
    risk: () => showRisk(),
    groupSelection: () => groupSelection,
    floatingWindows: () => floatingWindows,
    islands: () => view.islandDirectories(),
    islandBoxes: () => view.islandBoxes(),
    islandOffsets: () => view.islandOffsets(),
    setIslandLayout: (offsets) => view.setIslandOffsets(offsets),
    resetIslandLayout: resetMapLayout,
    workspace: () => showWorkspace(),
    passport: () => showPassport(),
    route: (file) => showRoute(file),
  };
}

// The right-click Narrate entry needs the narrator status before the first menu opens.
fetchNarratorStatus().then((status) => {
  narratorStatus ??= status;
});

loadCatalogue()
  .then(() => {
    // The graph default is the fallback: a URL mode or a per-repository pref overrides it.
    state.mode = clientPrefs.defaultDetail;
    elements.detail.value = clientPrefs.defaultDetail;
    applyUrl();
    if (
      state.repository &&
      [...elements.repository.options].some((option) => option.value === state.repository)
    ) {
      elements.repository.value = state.repository;
      elements.forget.disabled = false;
    }
    applyViewPrefs();
    return scan();
  })
  .then(() => restoreUrlPanel())
  .then(() => {
    // A deep link that opened the member map is explicit intent; do not cover it.
    if (elements.memberView.hidden) {
      return maybeOpenPassport();
    }
    return undefined;
  })
  .catch((error) => {
    elements.status.textContent = `Error: ${error.message}`;
  });
