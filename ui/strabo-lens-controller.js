/**
 * The map's lenses and overlays: the analysis overlay picker, the tier lens, the calls and
 * co-change edge lenses, and the large-file lens, with the toolbar buttons that reflect them.
 * A lens changes how the drawn map reads; it never adds nodes or edges the scan did not record.
 */

import {
  API_PATH,
  coChangePartnersFor,
  overlayFor,
  tierOfFile,
  withUnitHotspots,
} from './strabo-core.js';
import { tierDirectionClasses } from './strabo-tiers.js';
import { renderTierPanel } from './strabo-tier-panel.js';
import { renderOverlayPanel } from './strabo-panels.js';
import { FILE_MODE_OVERLAYS, OVERLAY_ENDPOINTS, OVERLAY_TITLES } from './strabo-overlays.js';
import { openCommitDialog } from './strabo-commit.js';

export function createLensController(app) {
  const { state, view, elements, request } = app;

  /**
   * The tier lens: colour the file map by tier, and optionally keep one tier.
   *
   * The report is fetched once per render and cached, so switching the filter does not re-read
   * the repository. Tiers are per file, so block and system modes clear the lens rather than
   * colour an aggregate.
   */
  let tierReportCache = { generation: -1, report: null };

  async function applyTierLens() {
    if (state.tier === 'off' || !app.current || app.current.system || app.current.prefixLength !== undefined) {
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
    if (!app.current || state.tier === 'off' || state.renderedGeneration !== generation) {
      view.applyTier(null);
      view.applyTierDirections(null);
      return;
    }
    view.applyTier(tierOfFile(tierReportCache.report), state.tier === 'all' ? 'all' : state.tier);
    view.applyTierDirections(tierDirectionClasses(tierReportCache.report));
    renderTierPanel(elements.overlayPanel, tierReportCache.report, state.tier);
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

  function clearOverlay() {
    state.overlay = 'none';
    elements.overlay.value = 'none';
    view.overlay(null);
    view.setHiddenCoupling(null, false);
    renderOverlayPanel(elements.overlayPanel, '', null);
    app.windows.refreshDock();
  }

  /**
   * Load the selected review analysis and annotate the graph. Overlays annotate only what
   * the server reported; they never invent nodes or edges.
   */
  async function applyOverlay(generation) {
    const kind = state.overlay;
    if (kind === 'none') {
      view.overlay(null);
      renderOverlayPanel(elements.overlayPanel, '', null);
      app.windows.refreshDock();
      return;
    }
    const query = state.repository ? `?repository=${encodeURIComponent(state.repository)}` : '';
    const data = await request(`${OVERLAY_ENDPOINTS[kind]}${query}`);
    if (generation !== undefined && generation !== app.scanGeneration) {
      return;
    }
    const overlay = overlayFor(kind, data);
    view.overlay(overlay.classes);
    // K3: the hidden-coupling lens draws the no-import-path co-change edges itself, distinctly
    // from the general co-change lens, and clears them for every other overlay.
    view.setHiddenCoupling(kind === 'hidden-coupling' ? data : null, kind === 'hidden-coupling');
    // The Change impact list is the working tree's own changes, so it is where the opt-in
    // commit action lives. It generates a message with the narrator, then commits and pushes.
    const actions = [];
    if (kind === 'impact' && app.clientPrefs.commitEnabled) {
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
      onSelect: (id) => app.selection.selectNode(id),
      ...(actions.length > 0 ? { actions } : {}),
    });
    app.windows.refreshDock();
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
    const repository = app.current?.repository?.root ?? null;
    if (!app.current?.unitCards?.length || unitHotspotCache?.repository === repository) {
      return;
    }
    try {
      const query = state.repository ? `?repository=${encodeURIComponent(state.repository)}` : '';
      const report = await request(`/analysis/functions${query}`);
      if (generation !== app.scanGeneration || app.current?.repository?.root !== repository) {
        return;
      }
      unitHotspotCache = { repository, report };
      view.setUnitCards(withUnitHotspots(app.current.unitCards, report));
    } catch {
      // The card keeps `hotspots —`; a missing analysis must not fail the map.
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
    app.prefs.schedulePrefsSave();
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
    app.prefs.schedulePrefsSave();
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
    const on = shown && Boolean(app.clientPrefs.allLabels);
    elements.tbLabels.hidden = !shown;
    elements.tbLabels.classList.toggle('active', on);
    elements.tbLabels.setAttribute('aria-pressed', String(on));
  }

  /**
   * The large-file lens, re-applied after every render. It needs a line count, so it only
   * ever turns on in file mode; the threshold is a client preference set in Settings.
   */
  function applyLocLens() {
    const enabled = state.mode === 'file' && state.locLens;
    view.applyLocLens(app.clientPrefs.locThreshold, enabled);
    updateLocButton();
  }

  /** Toggle the large-file lens; a change of reading, so no rescan. */
  function toggleLocLens() {
    if (state.mode !== 'file') {
      return;
    }
    state.locLens = !state.locLens;
    applyLocLens();
    app.prefs.schedulePrefsSave();
  }

  /** The large-file button appears in file mode; its pressed state follows the lens. */
  function updateLocButton() {
    if (!elements.tbLoc) {
      return;
    }
    const shown = state.mode === 'file';
    const on = shown && state.locLens;
    elements.tbLoc.hidden = !shown;
    elements.tbLoc.classList.toggle('active', on);
    elements.tbLoc.setAttribute('aria-pressed', String(on));
  }

  if (elements.tier) {
    elements.tier.addEventListener('change', () => {
      state.tier = elements.tier.value;
      // The tier lens is per file; the aggregate modes switch to file detail to show it.
      if (state.tier !== 'off' && state.mode !== 'file') {
        state.mode = 'file';
        elements.detail.value = 'file';
        app.prefs.writeViewPrefs();
        app.scan();
        return;
      }
      app.prefs.writeViewPrefs();
      applyTierLens();
    });
  }

  elements.overlay.addEventListener('change', () => {
    state.overlay = elements.overlay.value;
    if (state.overlay === 'none') {
      app.prefs.writeViewPrefs();
      applyOverlay();
      return;
    }
    // Node overlays annotate file nodes; architecture health is repository-level.
    const needsFileMode = FILE_MODE_OVERLAYS.includes(state.overlay);
    if (needsFileMode && state.mode !== 'file') {
      state.mode = 'file';
      elements.detail.value = 'file';
      app.prefs.writeViewPrefs();
      app.scan();
      return;
    }
    app.prefs.writeViewPrefs();
    applyOverlay();
  });

  elements.tbImpact.addEventListener('click', () => {
    elements.overlay.value = 'impact';
    elements.overlay.dispatchEvent(new Event('change'));
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
    elements.tbLabels.addEventListener('click', () => app.settings.setClientPref('allLabels', !app.clientPrefs.allLabels));
  }

  if (elements.tbLoc) {
    elements.tbLoc.addEventListener('click', toggleLocLens);
  }

  return {
    applyCoChangeLens,
    applyEdgeKindLens,
    applyLocLens,
    applyOverlay,
    applyTierLens,
    clearOverlay,
    enrichUnitCards,
    loadChangesWith,
    updateCoChangeButton,
    updateEdgeKindButton,
    updateLabelsButton,
  };
}
