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

import { API_PATH, buildAgentPrompt, buildGraphQuery, edgeEvidenceFor, fileWebUrl, filterNodes, folderLocation, graphSummary, mapCounts, memberMapSteps, overlayFor, passportFor, reviewOverlay, riskSummary } from './strabo-core.js';
import { createView } from './strabo-view.js';
import { closeContextMenu, copyText, launchAgent, showContextMenu, showToast } from './strabo-delegate.js';
import { initFloatingWindows } from './strabo-float.js';
import {
  renderBreadcrumb,
  renderDiagnostics,
  renderEdgeEvidence,
  renderFolderList,
  renderFunctions,
  renderInspector,
  renderLegend,
  renderMemberMap,
  renderMembers,
  renderOverlayPanel,
  renderRepositoryPassport,
  renderReview,
  renderRisk,
  renderShortcuts,
  renderTestsStrip,
  renderTimeline,
  renderWorkspace,
} from './strabo-panels.js';
import { findPath, neighbourhood } from './strabo-selection.js';
import { buildNarratorEvidence } from './strabo-narrator.js';
import { applyAppearance, readSettings, renderSettings, watchSystemPreferences, writeSettings } from './strabo-settings.js';
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
    pathMode: false,
    pathFrom: null,
    renderedGeneration: 0,
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
    if (parsed.mode === 'block' || parsed.mode === 'file') {
      prefs.mode = parsed.mode;
    }
    if (typeof parsed.overlay === 'string' && parsed.overlay !== '') {
      prefs.overlay = parsed.overlay;
    }
    if (typeof parsed.filter === 'string' && parsed.filter !== '') {
      prefs.filter = parsed.filter.slice(0, 200);
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
      JSON.stringify({ mode: state.mode, overlay: state.overlay, filter: state.filter }),
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
}

const view = createView(document.getElementById('graph'));

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
  inspector: document.getElementById('inspector'),
  strip: document.getElementById('strip'),
  hover: document.getElementById('hover'),
  tooltip: document.getElementById('tooltip'),
  graphEmpty: document.getElementById('graph-empty'),
  graphEmptyClear: document.getElementById('graph-empty-clear'),
  graphLoading: document.getElementById('graph-loading'),
  zoomIn: document.getElementById('zoom-in'),
  zoomOut: document.getElementById('zoom-out'),
  zoomFit: document.getElementById('zoom-fit'),
  tbFocus: document.getElementById('tb-focus'),
  tbImpact: document.getElementById('tb-impact'),
  tbPath: document.getElementById('tb-path'),
  tbBoundaries: document.getElementById('tb-boundaries'),
  tbTimeline: document.getElementById('tb-timeline'),
  tbReview: document.getElementById('tb-review'),
  tbRisk: document.getElementById('tb-risk'),
  tbClear: document.getElementById('tb-clear'),
  tbOverflow: document.getElementById('tb-overflow'),
  tbOverflowMenu: document.getElementById('tb-overflow-menu'),
  groupCount: document.getElementById('group-count'),
  tbDelegateGroup: document.getElementById('tb-delegate-group'),
  timelinePanel: document.getElementById('timeline-panel'),
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
};

/** `memberData` holds the last loaded member-map payload; `memberUI` is the store slice. */
let memberData = null;
let memberTimer = null;
let selectedCommitHash = null;

let browsedFolder = null;

async function request(path) {
  const response = await fetch(`${API_PATH}${path}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json();
}

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
    selected = null;
    selectedEdgeId = null;
    selectedCommitHash = null;
    state.renderedGeneration = generation;
    store.set('ui', { node: null });
    view.render(model);
    applyFilterToView();
    renderLegend(elements.legend, model);
    renderTestsStrip(elements.strip, mapCounts(model), applyStripFilter, state.filter);
    const summary = renderDiagnostics(elements.diagnostics, model, {
      renderer: rendererName(),
      shown: view.cy.nodes().length,
    });
    updateDiagnosticsBadge(summary);
    renderBreadcrumb(elements.breadcrumb, state, (prefix) => {
      state.prefix = prefix;
      scan();
    });
    elements.inspector.hidden = true;
    elements.status.textContent = graphSummary(model);
    updateStatusbar(model);
    if (elements.graphLoading) elements.graphLoading.hidden = true;
    updateEmptyState();
    view.resize();
    fit(view.cy);
    if (shouldShowHint()) {
      elements.graphHint.hidden = false;
    }
    if (state.overlay !== 'none') {
      await applyOverlay(generation);
    } else {
      renderOverlayPanel(elements.overlayPanel, '', null);
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

  selected = id;
  store.set('ui', { node: id });
  view.clearEdge();
  selectedEdgeId = null;
  renderEdgeEvidence(elements.edgePanel, null);
  view.highlight(neighbourhood(current, id));
  renderInspector(elements.inspector, current, id, {
    onSelect: (target) => selectNode(target),
    onTrace: (from, to) => tracePath(from, to),
    onOpenWorkspace: (target) => openFile(target),
    onOpenMemberMap: (target) => {
      openMemberMap(target).catch((error) => {
        elements.status.textContent = `Error: ${error.message}`;
      });
    },
  });
  loadMembers(id);
  refreshDock();
}

/** Fetch members and functions for the selected file; symbols are extracted on demand. */
async function loadMembers(id) {
  const membersSection = elements.inspector.querySelector('[data-role="members"]');
  const functionsSection = elements.inspector.querySelector('[data-role="functions"]');
  if (!membersSection && !functionsSection) {
    return;
  }
  const params = new URLSearchParams({ file: id });
  if (state.repository) {
    params.set('repository', state.repository);
  }
  try {
    if (narratorStatus === null) {
      narratorStatus = await fetchNarratorStatus();
    }
    const response = await fetch(`${API_PATH}/symbols?${params.toString()}`);
    const result = response.ok
      ? await response.json()
      : { available: false, detail: 'Symbols are unavailable for this file.' };
    if (selected === id) {
      if (membersSection) renderMembers(membersSection, result);
      if (functionsSection) renderFunctions(functionsSection, result, functionsHandlers(result));
    }
  } catch {
    if (selected === id) {
      const fallback = { available: false, detail: 'Symbols could not be loaded.' };
      if (membersSection) renderMembers(membersSection, fallback);
      if (functionsSection) renderFunctions(functionsSection, fallback, functionsHandlers(fallback));
    }
  }
}

/** Handlers that let the Functions tab ask the opt-in narrator about the recorded evidence. */
function functionsHandlers(result) {
  return {
    narratorStatus,
    onNarrate: () => narrateFile(result),
  };
}

/** Read the narrator status once; failures degrade to the unconfigured caption, not an error. */
async function fetchNarratorStatus() {
  try {
    const response = await fetch(`${API_PATH}/narrator`);
    return response.ok ? await response.json() : { configured: false, reason: 'not-configured' };
  } catch {
    return { configured: false, reason: 'not-configured' };
  }
}

/**
 * Ask the narrator about one file's recorded evidence.
 *
 * Only recorded evidence is sent; the endpoint decides whether it is enabled. The reply is
 * narrative text, rendered apart from the recorded facts and never applied to the source.
 */
async function narrateFile(result) {
  const response = await fetch(`${API_PATH}/narrator`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      instruction: 'Summarise the recorded complexity, signals, and call wiring in this file.',
      evidence: buildNarratorEvidence(result),
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? `Narrator request failed (${response.status}).`);
  }
  return body;
}

function clearSelection() {
  selected = null;
  store.set('ui', { node: null });
  state.pathFrom = null;
  state.pathMode = false;
  elements.tbPath.classList.remove('active');
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
  refreshDock();
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
  };
  elements.memberView.hidden = false;
  store.set('ui', { memberOpen: true, node: id });
  store.set('member', { stepIndex: 0, find: '' });
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
    onStep: (delta) => {
      stopMemberPlay();
      store.set('member', {
        stepIndex: Math.min(memberStepCount() - 1, Math.max(0, memberUI.stepIndex + delta)),
      });
    },
    onPlay: () => toggleMemberPlay(),
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
    set('mode', state.mode === 'file' ? 'file' : '');
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
  if (mode === 'file' || mode === 'block') {
    state.mode = mode;
    elements.detail.value = mode;
  }
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
    if (!inField) clearSelection();
    return;
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
  else if (key === 'p') elements.tbPath.click();
  else if (key === 'b') elements.tbBoundaries.click();
  else if (key === 't') elements.tbTimeline.click();
  else if (key === 'r') elements.tbReview.click();
  else if (key === 'v') elements.tbRisk.click();
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
  renderTimeline(elements.timelinePanel, result, (commit) => {
    selectCommit(commit).catch((error) => {
      elements.status.textContent = `Error: ${error.message}`;
    });
  }, {
    selectedHash: selectedCommitHash,
    onClose: () => {
      elements.timelinePanel.hidden = true;
    },
  });
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
 * instead of being drawn as if it had impact.
 */
async function showReview(query, commit = null) {
  const separator = query ? '&' : '?';
  const repository = state.repository ? `${separator}repository=${encodeURIComponent(state.repository)}` : '';
  const data = await request(`/analysis/review${query}${repository}`);

  currentReview = data;
  if (data.available === false) {
    elements.reviewPanel.hidden = false;
    renderReview(elements.reviewPanel, data, { onClose: closeReview });
    return;
  }

  const overlay = reviewOverlay(data);
  view.overlay(overlay.classes);
  elements.reviewPanel.hidden = false;
  renderReview(elements.reviewPanel, data, {
    onClose: closeReview,
    onSelect: (id) => selectNode(id),
  });
  const label = commit ? commit.shortHash : 'working tree';
  elements.status.textContent = `Review ${label}: ${overlay.summary}`;
}

function closeReview() {
  currentReview = null;
  elements.reviewPanel.hidden = true;
  renderReview(elements.reviewPanel, null, {});
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

function renderSettingsView() {
  if (!elements.settingsPanel) return;
  renderSettings(elements.settingsPanel, {
    prefs: clientPrefs,
    server: serverSettings,
    status: settingsStatus || null,
    statusError: settingsStatusError,
    onPref: (key, value) => {
      clientPrefs = { ...clientPrefs, [key]: value };
      writeSettings(clientPrefs);
      applyClientPrefs();
      renderSettingsView();
    },
    onSaveCeiling: (value) =>
      saveServerSettings({ scanCeiling: value }, value ? 'Scan ceiling updated.' : 'Scan ceiling reset.'),
    onToggleWidening: (value) =>
      saveServerSettings({ allowCeilingWidening: value }, 'Ceiling widening updated.'),
    onToggleRisk: (value) => saveServerSettings({ riskOnline: value }, 'Online risk lookup updated.'),
  });
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
    const report = await request('/workspace');
    renderWorkspace(elements.workspacePanel, report, { onClose: closeWorkspace });
  } catch (error) {
    renderWorkspace(elements.workspacePanel, null, { onClose: closeWorkspace });
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent = error.message;
    elements.workspacePanel.append(note);
  }
  refreshDock();
}

function closeWorkspace() {
  elements.workspacePanel.hidden = true;
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
};

const OVERLAY_ENDPOINTS = {
  impact: '/analysis/impact',
  cycles: '/analysis/cycles',
  'test-reach': '/analysis/test-reach',
  architecture: '/analysis/architecture-health',
  hotspots: '/analysis/functions',
  'module-depth': '/analysis/module-depth',
  ownership: '/analysis/ownership',
};

/** Overlays that annotate file nodes and therefore need Files mode. */
const FILE_MODE_OVERLAYS = ['impact', 'cycles', 'test-reach', 'module-depth', 'ownership'];

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
  renderOverlayPanel(elements.overlayPanel, OVERLAY_TITLES[kind], overlay, {
    kind,
    onClose: clearOverlay,
    onSelect: (id) => selectNode(id),
  });
  refreshDock();
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

/** Double-click drills in block mode; in file mode it opens the file. */
function onDrill(id) {
  if (state.mode === 'block') {
    state.prefix = id;
    state.filter = '';
    elements.filter.value = '';
    scan();
    return;
  }
  openFile(id);
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
  writeViewPrefs();
  scan();
});
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
  const title = document.createElement('div');
  title.className = 'tt-title';
  title.textContent = node.label ?? id;
  elements.tooltip.append(title);
  const row = document.createElement('div');
  row.className = 'tt-row';
  const kind = document.createElement('span');
  kind.className = 'tt-kind';
  kind.textContent = node.kind ?? '';
  row.append(kind);
  const blast = document.createElement('span');
  blast.textContent = `blast ${node.transitiveDependents ?? 0} · id ${id}`;
  row.append(blast);
  elements.tooltip.append(row);
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
  elements.hover.textContent = `${id} · blast radius ${node?.transitiveDependents ?? 0} · ${node?.kind ?? ''}`;
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

function closeOverflowMenu() {
  if (!elements.tbOverflowMenu) return;
  elements.tbOverflowMenu.hidden = true;
  elements.tbOverflow.setAttribute('aria-expanded', 'false');
}

if (elements.tbOverflow) {
  elements.tbOverflow.addEventListener('click', (event) => {
    event.stopPropagation();
    const willOpen = elements.tbOverflowMenu.hidden;
    elements.tbOverflowMenu.hidden = !willOpen;
    elements.tbOverflow.setAttribute('aria-expanded', String(willOpen));
  });
  for (const id of ['tb-timeline', 'tb-review', 'tb-risk']) {
    document.getElementById(id)?.addEventListener('click', closeOverflowMenu);
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
  const label = result.kind === 'commit' && result.commit ? `commit ${result.commit.shortHash}` : 'pending working tree';
  const evidence = [];
  if (result.commit) {
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
      state.mode === 'block' ? `directory view${state.prefix ? ` at ${state.prefix}` : ''}` : 'file view',
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
  const overlayItem = node.closest('#overlay-panel li');
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

/** Open the agent's interactive TUI on the delegated item, with the task prefilled. */
async function delegateToAgent(agent, target) {
  const repository = current?.repository ?? null;
  const prompt = buildAgentPrompt({ agent, repository, target });
  const title = (target.label ?? target.id ?? 'repository view').slice(0, 80);
  try {
    await launchAgent(agent, {
      repository: state.repository ?? repository?.root,
      target: { kind: target.kind, id: target.id, label: target.label },
      prompt,
      title,
    });
    showToast(`Opened ${agent} on ${title} — edit the prefilled task, then send.`);
  } catch (error) {
    showToast(`Could not open a terminal (${error.message}).`, {
      label: 'Copy prompt',
      onClick: async () => {
        await copyText(prompt);
        showToast('Prompt copied — paste it into your agent.');
      },
    });
  }
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
  event.preventDefault();
  closeContextMenu();
  hideTooltip();
  openDelegateMenu(resolveDomDelegateTarget(event.target) ?? fallbackDelegateTarget(), event.clientX, event.clientY);
});

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
      titleFrom: (panel) => panel.querySelector('h3')?.textContent?.trim() ?? '',
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
      onClose: () => {
        elements.diagnostics.hidden = true;
        elements.diagnosticsToggle.setAttribute('aria-expanded', 'false');
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
    workspace: () => showWorkspace(),
    passport: () => showPassport(),
  };
}

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
