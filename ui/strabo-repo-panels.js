/**
 * The repository-wide windows: the Repository passport (and its report export), the
 * reading route, the multi-repository Workspace with its compatibility tools, and Blocks.
 */

import { crossRepoNodeIds } from './strabo-workspace.js';
import { renderRepositoryPassport, renderWorkspace } from './strabo-panels.js';
import { buildBrickAssembly } from './strabo-lego.js';
import { renderBlocks } from './strabo-panel-blocks.js';
import { API_PATH } from './strabo-core.js';
import {
  clampRouteIndex,
  readRouteProgress,
  renderRoutePanel,
  routeIndexOf,
  routeSteps,
  writeRouteProgress,
} from './strabo-route.js';

export function createRepositoryPanels(app) {
  const { state, view, elements } = app;

  /** The reading route the panel is showing, and the step it is on, so a step can focus the map. */
  let currentRoute = null;

  let routeIndex = 0;

  /**
   * Open the workspace window and load the declared multi-repo report.
   *
   * The workspace is fixed by the server's config; the panel is read-only and a server error
   * (invalid config, a root outside the ceiling) is shown in the panel rather than thrown.
   */
  async function showWorkspace() {
    elements.workspacePanel.hidden = false;
    try {
      workspaceReport = await app.request('/workspace');
      workspaceTools.databases = await app.request('/workspace/databases').catch(() => null);
      renderWorkspaceView();
      // Ring the files on this map that the report records on one side of a cross-repo flow.
      view.crossRepo(crossRepoNodeIds(workspaceReport, (app.current?.nodes ?? []).map((node) => node.id)));
    } catch (error) {
      workspaceReport = null;
      renderWorkspace(elements.workspacePanel, null, { onClose: closeWorkspace });
      const note = document.createElement('p');
      note.className = 'unavailable';
      note.textContent = error.message;
      elements.workspacePanel.append(note);
    }
    app.windows.refreshDock();
  }

  /**
   * Open the Blocks window and assemble the map already on screen into bricks.
   *
   * The assembly reads `current` — the model the canvas is drawing — so it always describes
   * exactly what is on the map, at whatever detail level (directories, files, or System units).
   * Nothing is fetched: a map with no nodes reports that there is nothing to assemble.
   */
  function showBlocks() {
    const assembly = buildBrickAssembly(app.current?.nodes ?? [], app.current?.edges ?? []);
    renderBlocks(elements.blocksPanel, assembly, {
      selected: app.selected,
      onOpen: (id) => app.selection.selectNode(id),
    });
    elements.blocksPanel.hidden = false;
    app.windows.refreshDock();
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
        workspaceTools.compat = await app.request(`/workspace/compat?base=${encodeURIComponent(workspaceTools.base || 'HEAD')}`);
      }),
      onPreflight: () => runWorkspaceTool('building preflight queries', async () => {
        workspaceTools.preflight = await app.request(`/workspace/preflight?base=${encodeURIComponent(workspaceTools.base || 'HEAD')}`);
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
        workspaceTools.databases = await app.request('/workspace/databases').catch(() => workspaceTools.databases);
      }),
      onLive: (name) => runWorkspaceTool('reading the live schema', async () => {
        workspaceTools.live = await postWorkspace('/workspace/live/schema', { database: name });
        workspaceTools.databases = await app.request('/workspace/databases').catch(() => workspaceTools.databases);
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
    app.windows.refreshDock();
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
      const report = await app.request(`/analysis/passport${state.repository ? `?repository=${encodeURIComponent(state.repository)}` : ''}`);
      renderRepositoryPassport(elements.passportPanel, report, {
        onSelect: (id) => app.selection.selectNode(id),
        onOpenRoute: () => showRoute(),
        onExportReport: (format) => exportRepositoryReport(format),
        onClose: closePassport,
      });
    } catch (error) {
      renderRepositoryPassport(elements.passportPanel, null, { onClose: closePassport });
      const note = document.createElement('p');
      note.className = 'unavailable';
      note.textContent = error.message;
      elements.passportPanel.append(note);
    }
    app.windows.refreshDock();
  }

  function closePassport() {
    elements.passportPanel.hidden = true;
    app.windows.refreshDock();
  }

  /**
   * Download the repository report from `/analysis/report`.
   *
   * The server renders Markdown, JSON, or self-contained HTML from the same document the
   * passport shows, so the download cannot disagree with the panel. HTML is the printable
   * form, so it is opened in a tab: the browser shows its own loading indicator while the
   * analyses run, and the operator prints it to PDF from there. Markdown and JSON download.
   *
   * The report can take a while on a large repository, so the status line says it is working
   * rather than leaving the click looking inert.
   */
  async function exportRepositoryReport(format) {
    const query = new URLSearchParams({ format });
    if (state.repository) {
      query.set('repository', state.repository);
    }
    const endpoint = `${API_PATH}/analysis/report?${query.toString()}`;

    if (format === 'html') {
      window.open(endpoint, '_blank', 'noopener');
      elements.status.textContent = 'Opening the printable report in a new tab…';
      return;
    }

    const extension = format === 'json' ? 'json' : 'md';
    elements.status.textContent = 'Generating the report…';
    try {
      const response = await fetch(endpoint);
      if (!response.ok) {
        elements.status.textContent =
          response.status === 404
            ? 'Report export failed: this server was started before the report route existed — restart it.'
            : `Report export failed: ${response.status} ${response.statusText}`;
        return;
      }
      const text = await response.text();
      const safeName = String(state.repository ?? 'repository').replace(/[\\/]/g, '-');
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `strabo-report-${safeName}.${extension}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      elements.status.textContent = `Report exported as ${extension.toUpperCase()}.`;
    } catch (error) {
      elements.status.textContent = `Report export failed: ${error.message}`;
    }
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
      const report = await app.request(`/analysis/route${state.repository ? `?repository=${encodeURIComponent(state.repository)}` : ''}`);
      currentRoute = report;
      await app.narration.ensureNarratorStatus();
      const steps = routeSteps(report);
      const preferred = preferredFile ? routeIndexOf(report, preferredFile) : -1;
      routeIndex =
        preferred >= 0
          ? clampRouteIndex(preferred, steps.length)
          : clampRouteIndex(readRouteProgress(window.localStorage, state.repository) ?? 0, steps.length);
      renderRouteView();
    } catch (error) {
      currentRoute = null;
      renderRoutePanel(elements.routePanel, null, { error: error.message }, {
        onRetry: () => showRoute(preferredFile),
      });
    }
    app.windows.refreshDock();
  }

  function renderRouteView() {
    renderRoutePanel(elements.routePanel, currentRoute, {
      index: routeIndex,
      narratorStatus: app.narratorStatus,
    }, {
      onStep: (index) => stepRoute(index),
      onFocus: (file) => focusRouteFile(file),
      onNarrateTour: () => app.narration.narrateRouteTour(),
      onNarrateStep: (step) => app.narration.narrateRouteStep(step),
      onOpenNarratorSettings: app.settings.openNarratorSettings,
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
    const visible = (app.current?.nodes ?? []).some((node) => node.id === file);
    if (!visible) {
      elements.status.textContent = `${file} is on the route; open its unit to see it on the map.`;
      return;
    }
    app.selection.selectNode(file);
  }

  /** The summary of the route the panel is showing, for the narrator. */
  function currentRouteSummary() {
    return currentRoute?.summary;
  }

  function closeRoute() {
    elements.routePanel.hidden = true;
    app.windows.refreshDock();
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

  return {
    closePassport,
    closeRoute,
    closeWorkspace,
    currentRouteSummary,
    maybeOpenPassport,
    showBlocks,
    showPassport,
    showRoute,
    showWorkspace,
  };
}
