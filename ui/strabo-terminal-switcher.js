/**
 * The Ctrl+K session switcher: a fuzzy-filtered overlay over every open session.
 *
 * The scoring is pure and exported so the ranking is unit-testable; the overlay is a small
 * controller with an input, a list, arrow-key navigation, Enter to open, and Escape to close.
 * The overlay is built lazily and appended to the document body, so importing this module has
 * no DOM side effects.
 */

import { sessionTabLabel, KIND_LABELS } from './strabo-terminal-tabs.js';

/** Everything a session can be matched on: its name, kind, repository, and provenance. */
export function sessionSearchText(meta) {
  const origin = meta?.origin ?? {};
  return [
    meta?.title,
    meta?.kind,
    KIND_LABELS[meta?.kind],
    meta?.repo,
    origin.node,
    origin.commit,
    origin.review,
    meta?.id,
  ]
    .filter((part) => typeof part === 'string' && part !== '')
    .join(' ');
}

/**
 * Subsequence fuzzy score: -1 when the needle is not a subsequence, else a positive score
 * with a bonus for contiguous runs, so `api` ranks `src/api` above `alpha-pipeline`.
 */
export function fuzzyScore(text, query) {
  const haystack = String(text ?? '').toLowerCase();
  const needle = String(query ?? '').toLowerCase().trim();
  if (needle === '') {
    return 0;
  }
  let score = 0;
  let cursor = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found === -1) {
      return -1;
    }
    score += found === cursor ? 2 : 1;
    cursor = found + 1;
  }
  return score;
}

/** Sessions matching `query`, best first; the whole list when the query is blank. */
export function filterSessions(sessions, query) {
  const needle = String(query ?? '').trim();
  const list = sessions ?? [];
  if (needle === '') {
    return [...list];
  }
  return list
    .map((session) => ({ session, score: fuzzyScore(sessionSearchText(session), needle) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.session);
}

let overlay = null;
let overlayApi = null;

function ensureOverlay() {
  if (overlay) {
    return overlay;
  }
  overlay = document.createElement('div');
  overlay.id = 'terminal-switcher-overlay';
  overlay.className = 'terminal-switcher';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Switch session');

  const panel = document.createElement('div');
  panel.className = 'terminal-switcher-panel';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'terminal-switcher-input';
  input.placeholder = 'Switch session…';
  input.setAttribute('aria-label', 'Filter sessions');
  input.autocomplete = 'off';

  const list = document.createElement('div');
  list.className = 'terminal-switcher-list';
  list.setAttribute('role', 'listbox');

  panel.append(input, list);
  overlay.append(panel);
  document.body.append(overlay);
  overlayApi = { overlay, panel, input, list };
  return overlay;
}

/**
 * Open the switcher. `onPick` receives the chosen session id. The returned controller can be
 * closed programmatically; Escape and a click outside close it too.
 */
export function openSessionSwitcher({ sessions = [], activeId = null, onPick } = {}) {
  ensureOverlay();
  const { overlay: root, input, list } = overlayApi;
  let matches = filterSessions(sessions, '');
  let selected = 0;

  const renderList = () => {
    const rows = matches.map((session, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'terminal-switcher-item';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === selected));
      if (index === selected) {
        row.classList.add('is-selected');
      }
      const label = document.createElement('span');
      label.className = 'terminal-switcher-label';
      label.textContent = sessionTabLabel(session);
      const meta = document.createElement('span');
      meta.className = 'terminal-switcher-meta';
      meta.textContent = [KIND_LABELS[session.kind] ?? session.kind, session.repo]
        .filter(Boolean)
        .join(' · ');
      row.append(label, meta);
      row.addEventListener('click', () => pick(session.id));
      row.addEventListener('pointermove', () => {
        selected = index;
        renderList();
      });
      return row;
    });
    list.replaceChildren(...rows);
    if (rows[selected]) {
      rows[selected].scrollIntoView({ block: 'nearest' });
    }
  };

  const pick = (id) => {
    close();
    if (id) {
      onPick?.(id);
    }
  };

  const onInput = () => {
    matches = filterSessions(sessions, input.value);
    selected = 0;
    renderList();
  };

  const onKeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selected = matches.length === 0 ? 0 : (selected + 1) % matches.length;
      renderList();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      selected = matches.length === 0 ? 0 : (selected - 1 + matches.length) % matches.length;
      renderList();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      pick(matches[selected]?.id ?? null);
    }
  };

  const onBackdrop = (event) => {
    if (event.target === root) {
      close();
    }
  };

  function close() {
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKeydown);
    root.removeEventListener('pointerdown', onBackdrop);
    root.hidden = true;
  }

  input.value = '';
  matches = filterSessions(sessions, '');
  selected = Math.max(0, matches.findIndex((session) => session.id === activeId));
  renderList();
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeydown);
  root.addEventListener('pointerdown', onBackdrop);
  root.hidden = false;
  input.focus();
  input.select();

  return { close, isOpen: () => !root.hidden };
}
