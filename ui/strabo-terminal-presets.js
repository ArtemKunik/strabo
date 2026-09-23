/**
 * The "Run…" preset menu for the terminal screen.
 *
 * Presets are server-derived commands (`GET /api/strabo/terminal/presets?repo=`); the client
 * only lists them and passes the chosen id back to `create`. Normalising is defensive because
 * the payload is a server response: a string entry and an object entry both become one shape.
 */

import { API_PATH } from './strabo-core.js';
import { showContextMenu } from './strabo-delegate.js';

/** One shape for a preset, whatever the server sent. */
export function normalizePresets(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.presets) ? payload.presets : [];
  return list
    .map((entry) => {
      if (typeof entry === 'string') {
        return { id: entry, label: entry, detail: '' };
      }
      const id = entry?.id ?? entry?.preset ?? entry?.key ?? '';
      const label = entry?.title ?? entry?.label ?? entry?.name ?? id;
      // `source` is the server preset's provenance (package.json, Makefile, …); it reads as
      // the menu hint the same way a description would.
      const detail = entry?.description ?? entry?.detail ?? entry?.source ?? '';
      const preset = { id: String(id), label: String(label), detail: String(detail) };
      if (typeof entry?.kind === 'string') {
        preset.kind = entry.kind;
      }
      return preset;
    })
    .filter((preset) => preset.id !== '');
}

export function presetId(preset) {
  if (typeof preset === 'string') {
    return preset;
  }
  return String(preset?.id ?? preset?.preset ?? '');
}

export function presetLabel(preset) {
  if (typeof preset === 'string') {
    return preset;
  }
  return String(preset?.title ?? preset?.label ?? preset?.name ?? preset?.id ?? '');
}

/** Fetch and normalise the presets for a repository. Throws with a readable message. */
export async function loadPresets(repo, { fetchImpl = globalThis.fetch } = {}) {
  const query = repo ? `?repo=${encodeURIComponent(repo)}` : '';
  const response = await fetchImpl(`${API_PATH}/terminal/presets${query}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Presets unavailable (${response.status})`);
  }
  return normalizePresets(await response.json());
}

/**
 * Open the preset menu anchored to `anchor`. Selecting a preset calls `onPick(preset)`. The
 * menu reuses the shared context menu, so positioning, dismissal, and Escape are consistent
 * with the rest of the app.
 */
export function openPresetMenu(anchor, { presets = [], onPick } = {}) {
  const items = presets.length
    ? presets.map((preset) => ({
        label: presetLabel(preset),
        hint: preset.detail,
        action: () => onPick?.(preset),
      }))
    : [{ label: 'No presets available' }];
  const rect = anchor?.getBoundingClientRect?.() ?? { left: 8, bottom: 8 };
  return showContextMenu({
    x: rect.left,
    y: rect.bottom + 4,
    title: 'Run preset',
    items,
  });
}
