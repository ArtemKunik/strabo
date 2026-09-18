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

import { API_PATH, buildGraphQuery, edgeEvidenceFor, fileWebUrl, filterNodes, findPath, folderLocation, graphSummary, mapCounts, memberMapSteps, overlayFor, passportFor } from './strabo-core.js';
import { createView } from './strabo-view.js';
import {
  renderBreadcrumb,
  renderDiagnostics,
  renderEdgeEvidence,
  renderFolderList,
  renderInspector,
  renderLegend,
  renderMemberMap,
  renderMembers,
  renderOverlayPanel,
  renderTestsStrip,
  renderTimeline,
} from './strabo-panels.js';
import { neighbourhood } from './strabo-selection.js';
import { fit, focus, zoomIn, zoomOut } from './strabo-viewport.js';

/** Incremented on every scan; async completions check their captured generation. */
let scanGeneration = 0;
let current = null;
let selected = null;

const state = {
  repository: null,
  mode: 'block',
  depth: 1,
  prefix: '',
  filter: '',
  overlay: 'none',
  pathMode: false,
  pathFrom: null,
  renderedGeneration: 0,
};

const view = createView(document.getElementById('graph'));

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
  tbClear: document.getElementById('tb-clear'),
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
  statusbarDiag: document.getElementById('statusbar-diag'),
  statusbarLegend: document.getElementById('statusbar-legend'),
  statusbarRender: document.getElementById('statusbar-render'),
};

/** Full-screen Member map UI state; `memberData` holds the last loaded payload. */
const memberUI = {
  order: 'source',
  find: '',
  showWiring: true,
  zoom: 'medium',
  dataFlow: true,
  onlyFlow: false,
  explain: false,
  stepIndex: 0,
  dim: false,
};
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
    selectedCommitHash = null;
    state.renderedGeneration = generation;
    view.render(model);
    applyFilterToView();
    renderLegend(elements.legend, model);
    renderTestsStrip(elements.strip, mapCounts(model), applyStripFilter, state.filter);
    const summary = renderDiagnostics(elements.diagnostics, model);
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
    if (state.overlay !== 'none') {
      await applyOverlay(generation);
    } else {
      renderOverlayPanel(elements.overlayPanel, '', null);
    }
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

function updateStatusbar(model) {
  if (elements.statusbarDiag && model) {
    const d = (model.diagnostics ?? []).length;
    const e = (model.excluded ?? []).length;
    elements.statusbarDiag.textContent = `diagnostics ${d} · excluded ${e}`;
  }
  if (elements.statusbarLegend && model) {
    const kinds = [...new Set((model.nodes ?? []).map((n) => n.kind))].join(' · ');
    elements.statusbarLegend.textContent = kinds || '';
  }
  if (elements.statusbarRender) {
    const webgl = view.capabilities?.webgl2 ? 'webgl2' : 'canvas';
    elements.statusbarRender.textContent = `renderer: ${webgl} · ${view.cy.nodes().length} shown`;
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
  if (elements.statusbarRender) {
    elements.statusbarRender.textContent = `renderer: ${view.capabilities?.webgl2 ? 'webgl2' : 'canvas'} · ${ids.length}/${current.nodes.length} shown`;
  }
}

function selectNode(id) {
  if (!current) {
    return;
  }

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
  view.clearEdge();
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
}

/** Fetch members for the selected file; symbols are extracted on demand by the server. */
async function loadMembers(id) {
  const section = elements.inspector.querySelector('[data-role="members"]');
  if (!section) {
    return;
  }
  const params = new URLSearchParams({ file: id });
  if (state.repository) {
    params.set('repository', state.repository);
  }
  try {
    const response = await fetch(`${API_PATH}/symbols?${params.toString()}`);
    const result = response.ok
      ? await response.json()
      : { available: false, detail: 'Symbols are unavailable for this file.' };
    if (selected === id) {
      renderMembers(section, result);
    }
  } catch {
    if (selected === id) {
      renderMembers(section, { available: false, detail: 'Symbols could not be loaded.' });
    }
  }
}

function clearSelection() {
  selected = null;
  state.pathFrom = null;
  state.pathMode = false;
  elements.tbPath.classList.remove('active');
  elements.hover.textContent = '';
  hideTooltip();
  view.highlight(null);
  view.clearEdge();
  renderEdgeEvidence(elements.edgePanel, null);
  elements.inspector.hidden = true;
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
  memberUI.stepIndex = 0;
  memberUI.find = '';
  elements.memberView.hidden = false;
  renderMemberMapView();
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
  const refocusFind = document.activeElement?.id === 'member-find';
  renderMemberMap(elements.memberView, memberData, memberUI, {
    onFind: (value) => {
      memberUI.find = value;
      renderMemberMapView();
    },
    onOrder: (value) => {
      memberUI.order = value;
      renderMemberMapView();
    },
    onWiring: (value) => {
      memberUI.showWiring = value;
      renderMemberMapView();
    },
    onZoom: (value) => {
      memberUI.zoom = value;
      renderMemberMapView();
    },
    onExplain: () => {
      memberUI.explain = !memberUI.explain;
      renderMemberMapView();
    },
    onNight: () => {
      memberUI.dim = !memberUI.dim;
      renderMemberMapView();
    },
    onCompare: () => {
      toggleTimeline().catch((error) => {
        elements.status.textContent = `Error: ${error.message}`;
      });
    },
    onOnlyFlow: () => {
      memberUI.onlyFlow = !memberUI.onlyFlow;
      renderMemberMapView();
    },
    onReset: () => {
      Object.assign(memberUI, {
        order: 'source',
        find: '',
        showWiring: true,
        zoom: 'medium',
        dataFlow: true,
        onlyFlow: false,
        explain: false,
        stepIndex: 0,
        dim: false,
      });
      renderMemberMapView();
    },
    onDataFlow: (value) => {
      memberUI.dataFlow = value;
      renderMemberMapView();
    },
    onStep: (delta) => {
      stopMemberPlay();
      memberUI.stepIndex = Math.min(
        memberStepCount() - 1,
        Math.max(0, memberUI.stepIndex + delta),
      );
      renderMemberMapView();
    },
    onPlay: () => toggleMemberPlay(),
    onClose: () => closeMemberMap(),
  });
  if (refocusFind) {
    const input = elements.memberView.querySelector('#member-find');
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }
}

function stopMemberPlay() {
  if (memberTimer) {
    clearInterval(memberTimer);
    memberTimer = null;
  }
}

function toggleMemberPlay() {
  if (memberTimer) {
    stopMemberPlay();
    return;
  }
  memberTimer = setInterval(() => {
    if (memberUI.stepIndex >= memberStepCount() - 1) {
      memberUI.stepIndex = 0;
      renderMemberMapView();
      stopMemberPlay();
      return;
    }
    memberUI.stepIndex += 1;
    renderMemberMapView();
  }, 1400);
}

function closeMemberMap() {
  stopMemberPlay();
  elements.memberView.hidden = true;
  memberUI.dim = false;
}

document.addEventListener('keydown', (event) => {
  const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '');
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    elements.filter.focus();
    elements.filter.select();
    return;
  }
  if (event.key === 'Escape') {
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
  if (inField || !elements.memberView.hidden) return;
  const key = event.key.toLowerCase();
  if (key === 'f' && selected) focus(view.cy, selected);
  else if (key === 'i') elements.tbImpact.click();
  else if (key === 'p') elements.tbPath.click();
  else if (key === 'b') elements.tbBoundaries.click();
  else if (key === 't') elements.tbTimeline.click();
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
  const params = new URLSearchParams({ base: commit.hash });
  if (state.repository) {
    params.set('repository', state.repository);
  }
  const data = await request(`/analysis/impact?${params.toString()}`);
  const overlay = overlayFor('impact', data);
  state.overlay = 'impact';
  elements.overlay.value = 'impact';
  view.overlay(overlay.classes);
  renderOverlayPanel(elements.overlayPanel, `Compare ${commit.shortHash}`, overlay, {
    kind: 'impact',
    onClose: clearOverlay,
    onSelect: (id) => selectNode(id),
  });
  // Refresh timeline selection highlight without refetching.
  view.fitNodes([...overlay.classes.keys()]);
  elements.status.textContent = `Since ${commit.shortHash}: ${overlay.summary}`;
}

function clearOverlay() {
  state.overlay = 'none';
  elements.overlay.value = 'none';
  view.overlay(null);
  renderOverlayPanel(elements.overlayPanel, '', null);
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
    renderEdgeEvidence(elements.edgePanel, null);
    return;
  }
  const evidence = edgeEvidenceFor(current, edgeId);
  renderEdgeEvidence(elements.edgePanel, evidence, {
    onSelect: (id) => selectNode(id),
    onTrace: (from, to) => tracePath(from, to),
    onClear: () => {
      view.clearEdge();
      renderEdgeEvidence(elements.edgePanel, null);
    },
  });
  if (evidence) {
    elements.hover.textContent = `${evidence.source} → ${evidence.target} · ${evidence.kind} · L${evidence.line ?? '?'} ${evidence.specifier ?? ''}`;
  }
}

function onSelect(id) {
  selectNode(id);
}

const OVERLAY_TITLES = {
  impact: 'Change impact',
  cycles: 'Cycles',
  'test-reach': 'Test reach',
  architecture: 'Architecture health',
};

const OVERLAY_ENDPOINTS = {
  impact: '/analysis/impact',
  cycles: '/analysis/cycles',
  'test-reach': '/analysis/test-reach',
  architecture: '/analysis/architecture-health',
};

/**
 * Load the selected review analysis and annotate the graph. Overlays annotate only what
 * the server reported; they never invent nodes or edges.
 */
async function applyOverlay(generation) {
  const kind = state.overlay;
  if (kind === 'none') {
    view.overlay(null);
    renderOverlayPanel(elements.overlayPanel, '', null);
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
  state.repository = root;
  state.prefix = '';
  elements.forget.disabled = false;
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
  scan();
});
elements.refresh.addEventListener('click', () => scan({ refresh: true }));
elements.overlay.addEventListener('change', () => {
  state.overlay = elements.overlay.value;
  if (state.overlay === 'none') {
    applyOverlay();
    return;
  }
  // Node overlays annotate file nodes; architecture health is repository-level.
  const needsFileMode = ['impact', 'cycles', 'test-reach'].includes(state.overlay);
  if (needsFileMode && state.mode !== 'file') {
    state.mode = 'file';
    elements.detail.value = 'file';
    scan();
    return;
  }
  applyOverlay();
});
elements.filter.addEventListener('input', () => {
  state.filter = elements.filter.value;
  applyFilterToView();
});
if (elements.filterClear) {
  elements.filterClear.addEventListener('click', () => {
    state.filter = '';
    elements.filter.value = '';
    applyFilterToView();
    elements.filter.focus();
  });
}
if (elements.graphEmptyClear) {
  elements.graphEmptyClear.addEventListener('click', () => {
    state.filter = '';
    elements.filter.value = '';
    applyFilterToView();
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
elements.tbClear.addEventListener('click', clearSelection);
view.onSelect(onSelect);
view.onDrill(onDrill);
view.onEdge(selectEdge);

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
  };
}

loadCatalogue()
  .then(() => scan())
  .catch((error) => {
    elements.status.textContent = `Error: ${error.message}`;
  });
