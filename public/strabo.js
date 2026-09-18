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

import { API_PATH, buildGraphQuery, fileWebUrl, filterNodes, findPath, graphSummary, mapCounts, memberMapSteps, overlayFor, passportFor } from './strabo-core.js';
import { createView } from './strabo-view.js';
import {
  renderBreadcrumb,
  renderDiagnostics,
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
import { fit, focus } from './strabo-viewport.js';

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
  overlay: document.getElementById('overlay'),
  overlayPanel: document.getElementById('overlay-panel'),
  diagnosticsToggle: document.getElementById('diagnostics-toggle'),
  diagnostics: document.getElementById('diagnostics'),
  legend: document.getElementById('legend'),
  breadcrumb: document.getElementById('breadcrumb'),
  status: document.getElementById('status'),
  inspector: document.getElementById('inspector'),
  strip: document.getElementById('strip'),
  hover: document.getElementById('hover'),
  tbFocus: document.getElementById('tb-focus'),
  tbImpact: document.getElementById('tb-impact'),
  tbPath: document.getElementById('tb-path'),
  tbBoundaries: document.getElementById('tb-boundaries'),
  tbTimeline: document.getElementById('tb-timeline'),
  tbClear: document.getElementById('tb-clear'),
  timelinePanel: document.getElementById('timeline-panel'),
  folderDialog: document.getElementById('folder-dialog'),
  folderPath: document.getElementById('folder-path'),
  folderList: document.getElementById('folder-list'),
  folderUp: document.getElementById('folder-up'),
  folderUse: document.getElementById('folder-use'),
  folderCancel: document.getElementById('folder-cancel'),
  forget: document.getElementById('forget'),
  memberView: document.getElementById('member-view'),
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
  night: false,
};
let memberData = null;
let memberTimer = null;

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
  closeMemberMap();

  try {
    const model = await request(`/graph${buildGraphQuery(state, { refresh })}`);
    if (generation !== scanGeneration) {
      return;
    }
    current = model;
    selected = null;
    state.renderedGeneration = generation;
    view.render(model);
    view.filter(filterNodes(model, state.filter));
    renderLegend(elements.legend, model);
    renderTestsStrip(elements.strip, mapCounts(model), applyStripFilter);
    renderDiagnostics(elements.diagnostics, model);
    renderBreadcrumb(elements.breadcrumb, state, (prefix) => {
      state.prefix = prefix;
      scan();
    });
    elements.inspector.hidden = true;
    elements.status.textContent = graphSummary(model);
    view.resize();
    fit(view.cy);
    if (state.overlay !== 'none') {
      await applyOverlay(generation);
    }
  } catch (error) {
    if (generation !== scanGeneration) {
      return;
    }
    elements.status.textContent = `Error: ${error.message}`;
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
  view.highlight(null);
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
      memberUI.night = !memberUI.night;
      document.body.classList.toggle('night-vision', memberUI.night);
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
        night: false,
      });
      document.body.classList.remove('night-vision');
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
  document.body.classList.remove('night-vision');
  memberUI.night = false;
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.memberView.hidden) {
    closeMemberMap();
  }
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
  });
}

/** Compare a revision with the working tree and annotate the map with the impact. */
async function selectCommit(commit) {
  const params = new URLSearchParams({ base: commit.hash });
  if (state.repository) {
    params.set('repository', state.repository);
  }
  const data = await request(`/analysis/impact?${params.toString()}`);
  const overlay = overlayFor('impact', data);
  state.overlay = 'impact';
  elements.overlay.value = 'impact';
  view.overlay(overlay.classes);
  renderOverlayPanel(elements.overlayPanel, `Compare ${commit.shortHash}`, overlay);
  view.fitNodes([...overlay.classes.keys()]);
  elements.status.textContent = `Since ${commit.shortHash}: ${overlay.summary}`;
}

function applyStripFilter(filter) {
  state.filter = filter;
  elements.filter.value = filter;
  if (current) {
    view.filter(filterNodes(current, filter));
  }
}

function tracePath(from, to) {
  const path = findPath(current, from, to);
  const trace = elements.inspector.querySelector('[data-role="trace"]');
  if (!trace) {
    return;
  }
  if (path) {
    trace.textContent = `${path.length - 1} step(s): ${path.join(' → ')}`;
    view.highlight(path);
  } else {
    trace.textContent = `No directed path from ${from} to ${to}.`;
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
  renderOverlayPanel(elements.overlayPanel, OVERLAY_TITLES[kind], overlay);
}

/** Folder selection is a server-side browse bounded by the configured scan ceiling. */
async function loadFolder(path) {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  const result = await request(`/browse${query}`);
  browsedFolder = result;
  elements.folderPath.textContent = result.path;
  elements.folderUp.disabled = !result.parent;
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
  if (current) {
    view.filter(filterNodes(current, state.filter));
  }
});
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

view.onHover((id) => {
  if (!id) {
    elements.hover.textContent = '';
    return;
  }
  const node = current?.nodes.find((candidate) => candidate.id === id);
  elements.hover.textContent = `${id} · blast radius ${node?.transitiveDependents ?? 0} · ${node?.kind ?? ''}`;
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

// Gated automation hook for browser acceptance tests. It exposes measurement and the
// same handlers the UI uses; it is inert unless the page opts in with window.STRABO_TEST.
if (window.STRABO_TEST) {
  window.straboTest = {
    cy: view.cy,
    state,
    select: selectNode,
    drill: onDrill,
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
