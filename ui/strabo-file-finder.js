/**
 * Go to file: a Ctrl+P overlay that finds any scanned file by name and selects it on the map.
 *
 * The path filter only narrows the nodes the current view draws, so a file inside a directory
 * block or a closed unit cannot be found with it. The finder searches every file the scan
 * recorded (`/files`) instead, and switches the map to Files when the current view does not
 * draw files. The ranking is pure and exported so it is unit-testable; the overlay borrows the
 * terminal session switcher's look.
 */

import { fuzzyScore } from './strabo-terminal-switcher.js';
import { focus } from './strabo-viewport.js';

/** How many matches the list shows; a longer list is a sign the query is too loose. */
const MAX_RESULTS = 50;

function baseName(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

function stem(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Score one path against a query, or -1 when it does not match. The file name counts
 * before the directory: an exact name beats a name prefix, which beats a word inside the
 * name (`graph` in `strabo-graph.js`), which beats a bare substring of the name, which beats
 * a hit anywhere in the path, which beats a fuzzy subsequence of the path.
 */
export function fileMatchScore(path, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle === '') {
    return 0;
  }
  const lower = String(path ?? '').toLowerCase();
  const name = baseName(lower);
  if (needle.includes('/')) {
    // A query with a slash names part of the path, so the path is what it is matched on.
    const at = lower.indexOf(needle);
    if (at !== -1) {
      return 4000 - at;
    }
  } else {
    if (name === needle || stem(name) === needle) {
      return 10000;
    }
    if (name.startsWith(needle)) {
      return 8000;
    }
    const inName = name.indexOf(needle);
    if (inName !== -1) {
      const atWord = /[-_. ]/.test(name[inName - 1] ?? '');
      return (atWord ? 7000 : 6000) - inName;
    }
    const inPath = lower.indexOf(needle);
    if (inPath !== -1) {
      return 4000 - inPath;
    }
  }
  return fuzzyScore(lower, needle);
}

/** Files matching `query`, best first and shorter paths first on a tie; at most `limit`. */
export function rankFiles(files, query, limit = MAX_RESULTS) {
  const list = files ?? [];
  if (String(query ?? '').trim() === '') {
    return list.slice(0, limit);
  }
  return list
    .map((file) => ({ file, score: fileMatchScore(file.id, query) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.file.id.length - b.file.id.length || a.file.id.localeCompare(b.file.id))
    .slice(0, limit)
    .map((entry) => entry.file);
}

export function createFileFinder(app) {
  const { state, elements } = app;
  let overlay = null;
  let parts = null;
  let files = [];
  let filesFor = null;
  let matches = [];
  let selected = 0;

  function ensureOverlay() {
    if (overlay) {
      return;
    }
    overlay = document.createElement('div');
    overlay.id = 'file-finder-overlay';
    overlay.className = 'terminal-switcher file-finder';
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Go to file');
    const panel = document.createElement('div');
    panel.className = 'terminal-switcher-panel';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'terminal-switcher-input';
    input.placeholder = 'Go to file…';
    input.setAttribute('aria-label', 'Find a file by name');
    input.autocomplete = 'off';
    input.spellcheck = false;
    const list = document.createElement('div');
    list.className = 'terminal-switcher-list';
    list.setAttribute('role', 'listbox');
    const note = document.createElement('div');
    note.className = 'terminal-switcher-item terminal-switcher-meta';
    note.hidden = true;
    panel.append(input, list, note);
    overlay.append(panel);
    document.body.append(overlay);
    parts = { input, list, note };

    input.addEventListener('input', () => {
      matches = rankFiles(files, input.value);
      selected = 0;
      renderList();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (matches.length > 0) {
          const step = event.key === 'ArrowDown' ? 1 : -1;
          selected = (selected + step + matches.length) % matches.length;
          renderList();
        }
      } else if (event.key === 'Enter') {
        event.preventDefault();
        pick(matches[selected]?.id ?? null);
      }
    });
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) {
        close();
      }
    });
  }

  function renderList() {
    const { list, note, input } = parts;
    const rows = matches.map((file, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'terminal-switcher-item';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === selected));
      row.classList.toggle('is-selected', index === selected);
      row.dataset.file = file.id;
      const label = document.createElement('span');
      label.className = 'terminal-switcher-label';
      label.textContent = baseName(file.id);
      const meta = document.createElement('span');
      meta.className = 'terminal-switcher-meta';
      const slash = file.id.lastIndexOf('/');
      meta.textContent = [slash > 0 ? file.id.slice(0, slash) : '.', file.kind === 'test' ? 'test' : '']
        .filter(Boolean)
        .join(' · ');
      row.append(label, meta);
      row.addEventListener('click', () => pick(file.id));
      row.addEventListener('pointermove', () => {
        if (selected !== index) {
          selected = index;
          renderList();
        }
      });
      return row;
    });
    list.replaceChildren(...rows);
    rows[selected]?.scrollIntoView?.({ block: 'nearest' });
    const empty = input.value.trim() !== '' && matches.length === 0;
    note.hidden = !empty;
    note.textContent = empty ? `No scanned file matches "${input.value.trim()}".` : '';
  }

  async function loadFiles() {
    const key = state.repository ?? '';
    if (filesFor === key && files.length > 0) {
      return;
    }
    const query = state.repository ? `?repository=${encodeURIComponent(state.repository)}` : '';
    const result = await app.request(`/files${query}`);
    files = [...(result.files ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    filesFor = key;
  }

  async function open() {
    ensureOverlay();
    const { input } = parts;
    input.value = '';
    matches = [];
    selected = 0;
    overlay.hidden = false;
    input.focus();
    try {
      await loadFiles();
    } catch (error) {
      parts.note.hidden = false;
      parts.note.textContent = `The file list could not be read: ${error.message}`;
      return;
    }
    matches = rankFiles(files, input.value);
    renderList();
  }

  function close() {
    if (overlay) {
      overlay.hidden = true;
    }
  }

  function isOpen() {
    return Boolean(overlay && !overlay.hidden);
  }

  /** Forget the cached list, so the next open reads the files of a fresh scan. */
  function invalidate() {
    files = [];
    filesFor = null;
  }

  function pick(file) {
    close();
    if (file) {
      void goToFile(file);
    }
  }

  /**
   * Select `file` on the map. Only the Files view draws every file as a node, so another
   * view switches to it first; a path filter that would hide the file is cleared.
   */
  async function goToFile(file) {
    app.setScreen?.('graph');
    if (state.filter && !file.toLowerCase().includes(state.filter.trim().toLowerCase())) {
      state.filter = '';
      elements.filter.value = '';
      app.applyFilterToView();
    }
    if (state.mode !== 'file') {
      elements.detail.value = 'file';
      // The Detail menu's own handler resets the other modes' state and rescans.
      elements.detail.dispatchEvent(new Event('change'));
      await app.scanSettled?.();
    }
    const drawn = (app.current?.nodes ?? []).some((node) => node.id === file);
    if (!drawn) {
      elements.status.textContent = `${file} is scanned but not drawn in this view.`;
      app.source?.viewSource(file);
      return;
    }
    app.selection.selectNode(file);
    focus(app.view.cy, file);
  }

  return { open, close, isOpen, invalidate, goToFile };
}
