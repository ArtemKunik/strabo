/**
 * The terminal tab strip: session tabs, active state, close buttons, drag-to-reorder, and
 * roving keyboard focus.
 *
 * The ordering and navigation arithmetic is pure and exported, so the tests can exercise the
 * reorder model and the Ctrl+Tab / Ctrl+1..9 jump targets without a browser. The DOM half is
 * a thin renderer over those helpers.
 */

import { rovingIndex } from './strabo-core.js';

export const KIND_LABELS = {
  shell: 'Shell',
  agent: 'Agent',
  task: 'Task',
  watch: 'Watch',
};

/** The tab's visible name: the shell-set title when present, else the kind. */
export function sessionTabLabel(meta) {
  const title = typeof meta?.title === 'string' ? meta.title.trim() : '';
  if (title) {
    return title;
  }
  return KIND_LABELS[meta?.kind] ?? 'Session';
}

/**
 * Display labels for a whole strip, disambiguating duplicates with an ordinal. Several shells
 * that fall back to the repository name (because their OSC title was rejected as noise) would
 * otherwise read the same, so the second becomes "name 2", the third "name 3".
 */
export function tabLabels(sessions) {
  const list = sessions ?? [];
  const totals = new Map();
  for (const session of list) {
    const base = sessionTabLabel(session);
    totals.set(base, (totals.get(base) ?? 0) + 1);
  }
  const seen = new Map();
  const labels = new Map();
  for (const session of list) {
    const base = sessionTabLabel(session);
    if ((totals.get(base) ?? 0) > 1) {
      const index = (seen.get(base) ?? 0) + 1;
      seen.set(base, index);
      labels.set(session.id, `${base} ${index}`);
    } else {
      labels.set(session.id, base);
    }
  }
  return labels;
}

/**
 * The status badge for a tab. Running shells get a quiet dot; a watch session pulses; an
 * exited session is named, and a non-zero code is called out as an error rather than hidden.
 */
export function tabBadge(meta) {
  if (meta?.status === 'exited') {
    const code = meta.exitCode;
    if (typeof code === 'number' && code !== 0) {
      return { className: 'is-exited is-error', label: `exited ${code}` };
    }
    return { className: 'is-exited', label: 'exited' };
  }
  if (meta?.kind === 'watch') {
    return { className: 'is-watch', label: 'watching' };
  }
  return { className: 'is-running', label: 'running' };
}

/**
 * The ids of the sessions a "kill all inactive" should close.
 *
 * A session is inactive when it is not the active one and is not running — an exited or
 * failed session whose tab is still open. The running sessions behind the other panes are
 * left alone, since the operator is showing them on purpose; `keepIds` names the sessions
 * to spare beyond the active one (the other visible panes), so a split is never torn down.
 */
export function inactiveSessionIds(sessions, activeId, keepIds = []) {
  const keep = new Set([activeId, ...keepIds]);
  return (sessions ?? [])
    .filter((session) => session?.id && session.status !== 'running' && !keep.has(session.id))
    .map((session) => session.id);
}

/** Order sessions by the saved id list, appending anything the list does not know about. */
export function orderSessions(sessions, order) {
  const byId = new Map((sessions ?? []).map((session) => [session.id, session]));
  const out = [];
  for (const id of order ?? []) {
    const session = byId.get(id);
    if (session) {
      out.push(session);
      byId.delete(id);
    }
  }
  for (const session of sessions ?? []) {
    if (byId.has(session.id)) {
      out.push(session);
      byId.delete(session.id);
    }
  }
  return out;
}

/** Move `fromId` to sit where `toId` is, returning a new order array (drag-to-reorder). */
export function moveInOrder(order, fromId, toId) {
  const list = [...(order ?? [])];
  const from = list.indexOf(fromId);
  const to = list.indexOf(toId);
  if (from === -1 || to === -1 || from === to) {
    return list;
  }
  list.splice(from, 1);
  const target = list.indexOf(toId);
  list.splice(target, 0, fromId);
  return list;
}

/** The next tab id when cycling, wrapping in both directions; null for an empty strip. */
export function cycleSessionId(order, activeId, delta) {
  const list = order ?? [];
  if (list.length === 0) {
    return null;
  }
  const index = list.indexOf(activeId);
  const base = index === -1 ? 0 : index;
  const next = (((base + delta) % list.length) + list.length) % list.length;
  return list[next] ?? null;
}

/** The tab a Ctrl+1..9 chord targets, or null when the digit has no tab behind it. */
export function digitSessionId(order, key) {
  const index = Number(key);
  if (!Number.isInteger(index) || index < 1 || index > 9) {
    return null;
  }
  return (order ?? [])[index - 1] ?? null;
}

function tabButton(session, active, handlers, label = sessionTabLabel(session)) {
  // A div rather than a button: the close control is itself a button, and a button may not
  // contain another. The roving tabindex keeps it keyboard-reachable like a button.
  const button = document.createElement('div');
  button.className = 'terminal-tab';
  button.dataset.sessionId = session.id;
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-selected', String(active));
  button.tabIndex = active ? 0 : -1;
  button.draggable = true;
  if (active) {
    button.classList.add('is-active');
  }

  const badge = tabBadge(session);
  const dot = document.createElement('span');
  dot.className = `terminal-tab-badge ${badge.className}`;
  dot.setAttribute('aria-hidden', 'true');

  const labelElement = document.createElement('span');
  labelElement.className = 'terminal-tab-label';
  labelElement.textContent = label;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'terminal-tab-close';
  close.setAttribute('aria-label', `Close ${label}`);
  close.title = 'Close session';
  close.textContent = '×';
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    handlers.onClose?.(session.id);
  });

  button.append(dot, labelElement, close);
  button.addEventListener('click', () => handlers.onSelect?.(session.id));
  button.addEventListener('dragstart', (event) => {
    event.dataTransfer?.setData('text/plain', session.id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
    }
  });
  button.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  });
  button.addEventListener('drop', (event) => {
    event.preventDefault();
    const fromId = event.dataTransfer?.getData('text/plain');
    if (fromId && fromId !== session.id) {
      handlers.onReorder?.(fromId, session.id);
    }
  });
  return button;
}

/**
 * Render the strip. The container keeps a roving tabindex: one tab is tabbable and the arrow
 * keys move focus (and selection) between the rest, matching the ARIA tabs pattern.
 */
export function renderTabs(container, sessions, activeId, handlers = {}) {
  if (!container) {
    return;
  }
  const labels = tabLabels(sessions);
  const buttons = (sessions ?? []).map((session) =>
    tabButton(session, session.id === activeId, handlers, labels.get(session.id)),
  );
  container.replaceChildren(...buttons);
  container.onkeydown = (event) => {
    const items = [...container.querySelectorAll('.terminal-tab')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Enter' || event.key === ' ') {
      const id = document.activeElement?.dataset?.sessionId;
      if (id) {
        event.preventDefault();
        handlers.onSelect?.(id);
      }
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const id = document.activeElement?.dataset?.sessionId;
      if (id) {
        event.preventDefault();
        handlers.onClose?.(id);
      }
      return;
    }
    const next = rovingIndex(index, items.length, event.key);
    if (next === null) {
      return;
    }
    event.preventDefault();
    items.forEach((item, position) => {
      item.tabIndex = position === next ? 0 : -1;
    });
    const target = items[next];
    target?.focus();
    if (target?.dataset?.sessionId) {
      handlers.onSelect?.(target.dataset.sessionId);
    }
  };
}
