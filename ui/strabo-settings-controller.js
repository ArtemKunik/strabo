/**
 * The Settings window: client preferences (persisted in the browser), server settings
 * (`/settings`), the narrator provider and key, and the server restart.
 */

import { renderSettings, writeSettings } from './strabo-settings.js';
import { showToast } from './strabo-delegate.js';
import { API_PATH } from './strabo-core.js';

export function createSettingsController(app) {
  const { state, elements, request } = app;

  /** Server settings from `/settings`, or null while loading. */
  let serverSettings = null;
  let settingsStatus = '';
  let settingsStatusError = false;

  /** Transient Narrator-section UI state (key mode, fetched models, last test result). */
  let narratorUiState = { presetId: null, keyMode: null, models: [], modelsNote: null, test: null };

  /**
   * Apply one client preference: persist it, restyle the map, and reflect it in the settings
   * panel and the toolbar. Shared by the Settings checkboxes and the in-graph toolbar toggle.
   */
  function setClientPref(key, value) {
    app.clientPrefs = { ...app.clientPrefs, [key]: value };
    writeSettings(app.clientPrefs);
    app.applyClientPrefs();
    app.lenses.updateLabelsButton();
    // The large-file lens reads the threshold, so re-apply it when that preference changes.
    if (key === 'locThreshold') {
      app.lenses.applyLocLens();
    }
    renderSettingsView();
    // The commit action is drawn by the impact overlay, so re-render it when it toggles.
    if (key === 'commitEnabled' && state.overlay === 'impact') {
      app.lenses.applyOverlay();
    }
  }

  function renderSettingsView() {
    if (!elements.settingsPanel) return;
    renderSettings(elements.settingsPanel, {
      prefs: app.clientPrefs,
      server: serverSettings,
      presets: app.narratorPresets,
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
      onRestart: () => restartServer(),
      onNarratorChange: async (patch) => {
        const saved = await saveServerSettings({ narrator: patch }, 'Narrator updated.');
        // The server can change more than the patch asked for: a new endpoint host clears the
        // stored key, because it cannot be redirected to another host.
        if (saved?.narrator?.keyCleared) {
          showToast('The endpoint host changed, so the stored key was removed.');
        }
        // Re-read `/settings` so the panel shows the key source it now has.
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
    app.narratorStatus = await app.narration.fetchNarratorStatus();
  }

  /** Write one server setting, then re-render; failures are shown in the panel, not thrown. */
  async function saveServerSettings(patch, successMessage) {
    let saved = null;
    try {
      saved = await putServerSettings(patch);
      settingsStatus = successMessage;
      settingsStatusError = false;
    } catch (error) {
      settingsStatus = error.message;
      settingsStatusError = true;
    }
    renderSettingsView();
    // The repository picker filters against the ceiling; refresh it so a change shows there.
    app.repos.loadCatalogue().catch(() => {});
    return saved;
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

  /**
   * Ask the server to relaunch itself, then wait for it to come back and reload the page.
   *
   * The acknowledgement only means the process accepted the request: the old server stops
   * right after answering, so the page polls `/health` until a server answers again rather
   * than trusting the reply. A server that never returns is reported instead of leaving the
   * panel spinning.
   */
  async function restartServer() {
    const response = await fetch(`${API_PATH}/settings/restart`, { method: 'POST' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error ?? `Could not restart the server (${response.status}).`);
    }
    await waitForServerRestart();
  }

  /** Poll `/health` until the relaunched server answers, then reload; give up after ~30s. */
  async function waitForServerRestart() {
    settingsStatus = 'Restarting…';
    settingsStatusError = false;
    renderSettingsView();
    // The old process is still finishing its reply; give it a moment to go down first.
    await new Promise((resolve) => setTimeout(resolve, 800));
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(`${API_PATH}/health`, { cache: 'no-store' });
        if (response.ok) {
          window.location.reload();
          return;
        }
      } catch {
        // Still down; keep waiting.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    settingsStatus = 'The server did not come back; restart it from the terminal.';
    settingsStatusError = true;
    renderSettingsView();
  }

  /** Open the settings window and load the current server values. */
  async function openSettings() {
    settingsStatus = '';
    settingsStatusError = false;
    renderSettingsView();
    try {
      serverSettings = await request('/settings');
      // Presets arrive with the narrator status; fetch once if the Functions tab never did.
      if (app.narratorPresets.length === 0) {
        app.narratorStatus = await app.narration.fetchNarratorStatus();
      }
    } catch (error) {
      settingsStatus = error.message;
      settingsStatusError = true;
    }
    renderSettingsView();
  }

  /** Open Settings at the Narrator section, the one call to action when the narrator is off. */
  function openNarratorSettings() {
    app.floatingWindows?.find?.((controller) => controller.key === 'settings')?.open?.();
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

  return {
    openNarratorSettings,
    openSettings,
    setClientPref,
  };
}
