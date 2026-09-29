/**
 * The Coverage controller: fetches the project, folder, and file coverage reports and drives
 * the Coverage panel and the Module Passport's Coverage section.
 *
 * The fetches are on demand — the panel opens, then loads the project report; a folder row
 * loads that subtree; a selected file loads its own report — and every completion checks that
 * it is still the subject on screen before touching the DOM. A server error object is rendered
 * in the panel, not thrown.
 */

import { API_PATH } from './strabo-core.js';
import { renderCoverageFile, renderCoverageReport } from './strabo-panels.js';

export function createCoverage(app) {
  const { state, elements } = app;

  /** The subject the panel is showing, so a retry reloads the same scope. */
  let subject = { scope: 'project', folder: null };
  /** The last panel report, or `{ error }`, for the retry button. */
  let panelReport = null;
  /** Guards a slow panel fetch against a newer one. */
  let panelToken = 0;
  /** Guards a slow file fetch against a newer selection. */
  let fileToken = 0;

  function coverageQuery(extra = {}) {
    const params = new URLSearchParams(extra);
    if (state.repository) {
      params.set('repository', state.repository);
    }
    const query = params.toString();
    return query ? `?${query}` : '';
  }

  const handlers = {
    onOpenProject: () => {
      loadProject();
    },
    onOpenFolder: (folder) => {
      loadFolder(folder);
    },
    onSelect: (id) => app.selection?.selectNode(id),
    onRetry: () => {
      if (subject.scope === 'folder' && subject.folder) {
        loadFolder(subject.folder);
      } else {
        loadProject();
      }
    },
    onRefresh: () => {
      refresh();
    },
  };

  function renderPanel() {
    renderCoverageReport(elements.coveragePanel, panelReport, handlers);
  }

  /**
   * Ask the server to run the repository's own coverage script, then reload the scope on
   * screen so the panel reads the fresh report. A failure is rendered, never thrown.
   */
  async function refresh() {
    const token = (panelToken += 1);
    panelReport = { loading: true, message: 'Running the repository coverage script…' };
    renderPanel();
    try {
      const response = await fetch(`${API_PATH}/analysis/coverage/refresh${coverageQuery()}`, {
        method: 'POST',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error ?? `${response.status} ${response.statusText}`);
      }
      if (token !== panelToken) {
        return;
      }
    } catch (error) {
      if (token !== panelToken) {
        return;
      }
      panelReport = { error: error.message };
      renderPanel();
      return;
    }
    if (subject.scope === 'folder' && subject.folder) {
      await loadFolder(subject.folder);
    } else {
      await loadProject();
    }
    if (app.selected) {
      await loadFileCoverage(app.selected);
    }
  }

  /** Open the window and load the project-wide report. */
  async function showCoverage() {
    elements.coveragePanel.hidden = false;
    await loadProject();
    app.windows?.refreshDock();
  }

  async function loadProject() {
    subject = { scope: 'project', folder: null };
    const token = (panelToken += 1);
    panelReport = { loading: true };
    renderPanel();
    try {
      const report = await app.request(`/analysis/coverage/project${coverageQuery()}`);
      if (token !== panelToken) {
        return;
      }
      // The risky-and-untested list (U5) is a second, best-effort read; its absence must not
      // fail the project panel, so a failure leaves `risk` off and the section unrendered.
      let risk;
      try {
        risk = await app.request(`/analysis/coverage/risky${coverageQuery()}`);
      } catch {
        risk = undefined;
      }
      if (token !== panelToken) {
        return;
      }
      panelReport = risk === undefined ? report : { ...report, risk };
    } catch (error) {
      if (token !== panelToken) {
        return;
      }
      panelReport = { error: error.message };
    }
    renderPanel();
  }

  async function loadFolder(folder) {
    subject = { scope: 'folder', folder };
    const token = (panelToken += 1);
    panelReport = { loading: true };
    renderPanel();
    try {
      const report = await app.request(
        `/analysis/coverage/folder${coverageQuery({ folder })}`,
      );
      if (token !== panelToken) {
        return;
      }
      panelReport = report;
    } catch (error) {
      if (token !== panelToken) {
        return;
      }
      panelReport = { error: error.message };
    }
    renderPanel();
  }

  /**
   * Load and render the selected file's coverage into the Module Passport's Coverage section.
   * A selection that has moved on, or a section that is no longer in the DOM, is left alone.
   */
  async function loadFileCoverage(id, asFile = true) {
    const section = elements.inspector?.querySelector('[data-role="coverage"]');
    if (!section || !id) {
      return;
    }
    if (!asFile) {
      renderCoverageFile(section, {
        unsupported: 'Coverage is measured per file. Open the Coverage panel, or select a file on the map.',
      });
      return;
    }
    const token = (fileToken += 1);
    try {
      const report = await app.request(
        `/analysis/coverage/file${coverageQuery({ file: id })}`,
      );
      if (token !== fileToken || app.selected !== id) {
        return;
      }
      renderCoverageFile(section, report, { onSelect: (target) => app.selection?.selectNode(target) });
    } catch (error) {
      if (token !== fileToken || app.selected !== id) {
        return;
      }
      renderCoverageFile(section, { error: error.message }, {
        onRetry: () => loadFileCoverage(id),
      });
    }
  }

  function closeCoverage() {
    elements.coveragePanel.hidden = true;
    app.windows?.refreshDock();
  }

  elements.tbCoverage?.addEventListener('click', () => {
    app.floatingWindows?.find?.((controller) => controller.key === 'coverage')?.toggle();
  });

  return {
    closeCoverage,
    loadFileCoverage,
    loadFolder,
    loadProject,
    showCoverage,
  };
}
