/**
 * The Terminal screen: a multi-session, split-pane terminal over one multiplexed socket.
 *
 * Each session owns exactly one xterm `Terminal`; panes are slots that show a session's
 * surface. Tabs list every session, splits lay panes out in a binary tree, and only visible
 * panes are fitted. Layout (tab order, splits, titles, kinds) is remembered per repository in
 * localStorage and re-attached on load, so a reload returns to the same working set.
 *
 * The wire contract lives in `src/terminal/protocol.ts`; the transport is
 * `terminal-multiplexer.js`, and the pure models are `strabo-terminal-split.js` and
 * `strabo-terminal-tabs.js`. This module is only the DOM orchestrator.
 *
 * Host hooks (all optional):
 *   openSourceAt(file, line)    — a citation link was clicked; open the file in the viewer.
 *   toast(message, options)     — surface a transient error/notice.
 *   onSessionsChanged(sessions) — the visible session list changed.
 *   resolveRepository()         — `{ name, root }` for layout persistence; defaults to the
 *                                 repository select in the toolbar.
 *   closeTerminal()             — the last session closed; return to the graph.
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import { showToast } from './strabo-delegate.js';
import { createTerminalMultiplexer } from './terminal-multiplexer.js';
import {
  createLayout,
  detachSession,
  findPane,
  paneForSession,
  panes,
  sanitizeLayout,
  setPaneSession,
  setRatio,
  splitPane,
} from './strabo-terminal-split.js';
import {
  cycleSessionId,
  digitSessionId,
  moveInOrder,
  orderSessions,
  renderTabs,
} from './strabo-terminal-tabs.js';
import { openSessionSwitcher } from './strabo-terminal-switcher.js';
import { registerCitationLinks } from './strabo-terminal-linkify.js';
import { loadPresets, openPresetMenu, presetId, presetLabel } from './strabo-terminal-presets.js';
import { extractControl } from './strabo-terminal-control.js';

const LAYOUT_PREFIX = 'strabo.terminal.layout.';
const BUFFER_LIMIT = 256 * 1024;
const PERSIST_DEBOUNCE_MS = 250;

/** Read the terminal palette from the theme tokens so it follows the active theme. */
function readTheme() {
  const styles = getComputedStyle(document.documentElement);
  const read = (name) => styles.getPropertyValue(name).trim() || undefined;
  const background = read('--bg-1');
  const foreground = read('--ink-1');
  return {
    background,
    foreground,
    cursor: read('--accent') ?? foreground,
    cursorAccent: background,
    selectionBackground: read('--accent-soft'),
  };
}

function readFontFamily() {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
  return value || 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
}

export function initTerminalScreen(container, hooks = {}) {
  // The host always passes the container, but a missing element must not crash bootstrap.
  if (!container || typeof container.querySelector !== 'function') {
    return {
      activate() {},
      applyTheme() {},
      async newSession() {
        return null;
      },
      async openAgentSession() {
        return null;
      },
      async runPreset() {
        return null;
      },
      listSessions() {
        return [];
      },
      openSession() {},
      destroy() {},
    };
  }

  const screen = container.closest?.('.terminal-screen') ?? container;
  const toolbarEl = ensureElement(container, 'terminal-toolbar', 'terminal-toolbar');
  const tabsEl = ensureElement(container, 'terminal-tabs', 'terminal-tabs');
  const panesEl = ensureElement(container, 'terminal-panes', 'terminal-panes');

  /** Session metadata by id, as the server last reported it. */
  const metas = new Map();
  /** Terminal views by session id. */
  const views = new Map();
  /** Output replay buffer by session id, so a new pane can seed from history. */
  const buffers = new Map();
  /** Per-session carry for a control marker split across output chunks. */
  const controlCarry = new Map();
  /** Saved titles/kinds for restored sessions, until the server confirms them. */
  const savedMeta = new Map();
  const attachedSessions = new Set();
  /** Sessions the saved layout/tabs asked for, so only those auto-attach on load. */
  const wantedSessions = new Set();

  let order = [];
  let layout = createLayout('pane-1');
  let activePaneId = 'pane-1';
  let paneCounter = 0;
  let restored = false;
  let restoredRoot = null;
  let reconciled = false;
  let lastRoot = null;
  let persistTimer = null;
  let resizeObserver = null;

  const repoSelect = document.getElementById('repository');

  /** The host's toast hook, or the shared one when the screen runs standalone. */
  const notify = typeof hooks.toast === 'function' ? hooks.toast : (message) => showToast(message);

  const mux = createTerminalMultiplexer({ onEvent: handleEvent });

  /* ------------------------------------------------------------- persistence */

  function layoutKey(root) {
    return `${LAYOUT_PREFIX}${root ?? 'default'}`;
  }

  function resolveRepo() {
    if (typeof hooks.resolveRepository === 'function') {
      try {
        const resolved = hooks.resolveRepository();
        if (resolved?.root) {
          return resolved;
        }
      } catch {
        // A throwing host hook falls through to the toolbar select.
      }
    }
    const root = repoSelect?.value || null;
    const name = repoSelect?.selectedOptions?.[0]?.textContent?.trim() || root;
    return root ? { name, root } : { name: 'default', root: 'default' };
  }

  function newPaneId() {
    let id;
    do {
      paneCounter += 1;
      id = `pane-${paneCounter}`;
    } while (panes(layout).some((leaf) => leaf.paneId === id));
    return id;
  }

  function loadSavedFor(root) {
    order = [];
    layout = createLayout(newPaneId());
    savedMeta.clear();
    wantedSessions.clear();
    try {
      const raw = window.localStorage.getItem(layoutKey(root));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed.order)) {
            order = parsed.order.filter((id) => typeof id === 'string' && id !== '');
          }
          layout = sanitizeLayout(parsed.layout, newPaneId());
          if (parsed.sessions && typeof parsed.sessions === 'object') {
            for (const [id, info] of Object.entries(parsed.sessions)) {
              if (info && typeof info === 'object') {
                savedMeta.set(id, { title: info.title, kind: info.kind });
              }
            }
          }
        }
      }
    } catch {
      order = [];
      layout = createLayout(newPaneId());
    }
    for (const id of order) {
      wantedSessions.add(id);
    }
    for (const leaf of panes(layout)) {
      if (leaf.sessionId) {
        wantedSessions.add(leaf.sessionId);
      }
    }
  }

  function persistFor(root) {
    if (!root) {
      return;
    }
    const data = {
      version: 1,
      order: [...order],
      layout,
      sessions: Object.fromEntries([...metas].map(([id, meta]) => [id, { title: meta.title, kind: meta.kind }])),
    };
    try {
      window.localStorage.setItem(layoutKey(root), JSON.stringify(data));
    } catch {
      // Storage is optional; a blocked quota only costs persistence.
    }
  }

  function persistSoon() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => persistFor(resolveRepo().root), PERSIST_DEBOUNCE_MS);
  }

  /**
   * Restore the layout for the current repository, once per repository.
   *
   * The socket connects before the host has populated the repository select, so the first
   * restore can land on the `default` key. Re-running when the root changes (the first
   * `activate()` after the catalogue loads) reloads the real layout; `wantedSessions` is
   * rebuilt each time so only the restored tabs auto-attach.
   */
  function ensureRestored() {
    const root = resolveRepo().root;
    if (restored && restoredRoot === root) {
      return;
    }
    restored = true;
    restoredRoot = root;
    lastRoot = root;
    loadSavedFor(root);
    activePaneId = panes(layout)[0]?.paneId ?? activePaneId;
    syncOrder();
    attachWanted();
  }

  /** Append server-known sessions the saved order did not name, keeping the saved order first. */
  function syncOrder() {
    for (const id of metas.keys()) {
      if (!order.includes(id)) {
        order.push(id);
      }
    }
  }

  /** Create and attach views for the sessions the saved layout asked for. */
  function attachWanted() {
    for (const id of wantedSessions) {
      const meta = metas.get(id);
      if (meta) {
        ensureView(meta);
        attachSession(id);
      }
    }
  }

  /* ------------------------------------------------------------------ events */

  function handleEvent(event) {
    switch (event.type) {
      case 'sessions':
        reconcileSessions(event.sessions);
        return;
      case 'created':
        onCreated(event.session);
        return;
      case 'closed':
        onClosed(event.id, event.code);
        return;
      case 'output':
        onOutput(event.id, event.data, event.reset === true);
        return;
      case 'title':
        onTitle(event.id, event.title);
        return;
      case 'error':
        notify(event.message, { tone: 'error' });
        return;
      default:
        return;
    }
  }

  function reconcileSessions(sessions) {
    ensureRestored();
    for (const meta of sessions) {
      if (meta && typeof meta.id === 'string') {
        metas.set(meta.id, meta);
      }
    }
    const ids = new Set([...metas.keys()]);

    if (!reconciled) {
      reconciled = true;
      // The list is authoritative: a saved session the server no longer has is dropped.
      for (const id of [...savedMeta.keys()]) {
        if (!ids.has(id)) {
          order = order.filter((entry) => entry !== id);
          layout = detachSession(layout, id);
        }
      }
      savedMeta.clear();
    }

    order = order.filter((id) => ids.has(id));
    syncOrder();
    layout = detachUnknownSessions(layout, ids);
    attachWanted();

    // A fresh screen with sessions already on the server shows the first one rather than an
    // empty pane, so opening the Terminal tab lands on something usable.
    if (!activeSessionId() && order.length > 0) {
      const first = metas.get(order[0]);
      if (first) {
        ensureView(first);
        attachSession(first.id);
        assignToPane(first.id, activePaneId);
      }
    }

    render();
    hooks.onSessionsChanged?.(listSessions());
  }

  function onCreated(meta) {
    if (!meta || typeof meta.id !== 'string') {
      return;
    }
    metas.set(meta.id, meta);
    wantedSessions.add(meta.id);
    if (!order.includes(meta.id)) {
      order.push(meta.id);
    }
    ensureView(meta);
    attachSession(meta.id);
    render();
    hooks.onSessionsChanged?.(listSessions());
  }

  function onClosed(id, code) {
    const meta = metas.get(id);
    if (meta) {
      metas.set(id, { ...meta, status: 'exited', exitCode: code });
      render();
      hooks.onSessionsChanged?.(listSessions());
    }
  }

  function onOutput(id, data, reset = false) {
    // Pull `::strabo::` control markers out before the output is shown or buffered, so the
    // directive drives the map instead of appearing in the terminal (and replay stays clean).
    const carry = reset ? '' : (controlCarry.get(id) ?? '');
    const { text, directives, carry: next } = extractControl(carry, data);
    controlCarry.set(id, next);
    if (reset) {
      // A reconnect replay from zero: clear first so the redraw is not a duplicate, then
      // replace the replay buffer with the authoritative slice.
      buffers.set(id, text.slice(-BUFFER_LIMIT));
      const view = views.get(id);
      if (view) {
        view.term.reset();
        view.term.write(text);
      }
    } else {
      buffers.set(id, ((buffers.get(id) ?? '') + text).slice(-BUFFER_LIMIT));
      if (text) {
        views.get(id)?.term.write(text);
      }
    }
    for (const directive of directives) {
      hooks.onControl?.(directive, id);
    }
  }

  function onTitle(id, title) {
    const meta = metas.get(id);
    if (meta && meta.title !== title) {
      metas.set(id, { ...meta, title });
      render();
    }
  }

  function detachUnknownSessions(tree, ids) {
    let next = tree;
    for (const leaf of panes(tree)) {
      if (leaf.sessionId && !ids.has(leaf.sessionId)) {
        next = detachSession(next, leaf.sessionId);
      }
    }
    return next;
  }

  /* ------------------------------------------------------------------- views */

  function ensureView(meta) {
    const existing = views.get(meta.id);
    if (existing) {
      existing.meta = meta;
      return existing;
    }
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: readFontFamily(),
      scrollback: 5000,
      theme: readTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    const surface = document.createElement('div');
    surface.className = 'terminal-surface';
    term.open(surface);

    term.onData((data) => mux.sendInput(meta.id, data));
    term.onResize(({ cols, rows }) => mux.resize(meta.id, cols, rows));
    // Tab names come only from the server's `title` event, which normalises OSC noise
    // (paths, shell names) before it reaches here. xterm's own onTitleChange would re-apply
    // the raw title and undo that.
    registerCitationLinks(term, { openSourceAt: (file, line) => hooks.openSourceAt?.(file, line) });

    const view = { id: meta.id, meta, term, fit, surface };
    views.set(meta.id, view);
    const pending = buffers.get(meta.id);
    if (pending) {
      term.write(pending);
    }
    return view;
  }

  function attachSession(id) {
    if (attachedSessions.has(id)) {
      return;
    }
    attachedSessions.add(id);
    mux.attach(id);
  }

  /* --------------------------------------------------------------- rendering */

  function activeSessionId() {
    return findPane(layout, activePaneId)?.sessionId ?? null;
  }

  function listSessions() {
    return orderSessions([...metas.values()], order);
  }

  function render() {
    renderTabs(tabsEl, listSessions(), activeSessionId(), {
      onSelect: openSession,
      onClose: closeSession,
      onReorder: (fromId, toId) => {
        order = moveInOrder(order, fromId, toId);
        render();
        persistSoon();
      },
    });
    updateActiveChrome();
    mountSurfaces();
  }

  function updateActiveChrome() {
    for (const leaf of panes(layout)) {
      const paneEl = paneElement(leaf.paneId);
      if (paneEl) {
        paneEl.classList.toggle('is-active', leaf.paneId === activePaneId);
      }
    }
  }

  function paneElement(paneId) {
    return [...panesEl.querySelectorAll('.terminal-pane')].find((el) => el.dataset.paneId === paneId) ?? null;
  }

  function buildNode(node) {
    if (node.type === 'leaf') {
      const paneEl = document.createElement('div');
      paneEl.className = 'terminal-pane';
      paneEl.dataset.paneId = node.paneId;
      paneEl.addEventListener('pointerdown', () => setActivePane(node.paneId));
      return paneEl;
    }
    const wrap = document.createElement('div');
    wrap.className = `terminal-split terminal-split-${node.direction}`;
    wrap.dataset.splitId = node.id;

    const sideA = document.createElement('div');
    sideA.className = 'terminal-split-side';
    sideA.style.flex = `${node.ratio} 1 0%`;
    sideA.append(buildNode(node.a));

    const sideB = document.createElement('div');
    sideB.className = 'terminal-split-side';
    sideB.style.flex = `${1 - node.ratio} 1 0%`;
    sideB.append(buildNode(node.b));

    const splitter = document.createElement('div');
    splitter.className = 'terminal-splitter';
    splitter.dataset.splitId = node.id;
    splitter.setAttribute('role', 'separator');
    splitter.setAttribute('aria-orientation', node.direction === 'row' ? 'vertical' : 'horizontal');
    wireSplitter(splitter, node, sideA, sideB);

    wrap.append(sideA, splitter, sideB);
    return wrap;
  }

  function wireSplitter(splitter, node, sideA, sideB) {
    splitter.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }
      const wrap = splitter.parentElement;
      const rect = wrap.getBoundingClientRect();
      let ratio = node.ratio;
      splitter.setPointerCapture(event.pointerId);
      const move = (moveEvent) => {
        const raw =
          node.direction === 'row'
            ? (moveEvent.clientX - rect.left) / Math.max(1, rect.width)
            : (moveEvent.clientY - rect.top) / Math.max(1, rect.height);
        ratio = Math.min(Math.max(raw, 0.05), 0.95);
        sideA.style.flex = `${ratio} 1 0%`;
        sideB.style.flex = `${1 - ratio} 1 0%`;
      };
      const end = () => {
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', end);
        splitter.removeEventListener('pointercancel', end);
        layout = setRatio(layout, node.id, ratio);
        fitVisible();
        persistSoon();
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', end);
      splitter.addEventListener('pointercancel', end);
      event.preventDefault();
    });
  }

  function renderLayoutDom() {
    panesEl.replaceChildren(buildNode(layout));
    mountSurfaces();
  }

  function mountSurfaces() {
    for (const leaf of panes(layout)) {
      const paneEl = paneElement(leaf.paneId);
      if (!paneEl) {
        continue;
      }
      paneEl.classList.toggle('is-active', leaf.paneId === activePaneId);
      const view = leaf.sessionId ? views.get(leaf.sessionId) : null;
      if (view) {
        if (view.surface.parentElement !== paneEl) {
          paneEl.replaceChildren(view.surface);
        }
        continue;
      }
      if (!paneEl.querySelector('.terminal-pane-empty')) {
        const empty = document.createElement('div');
        empty.className = 'terminal-pane-empty';
        empty.textContent = leaf.sessionId
          ? 'This session is no longer available.'
          : 'No session. Press Ctrl+Shift+T for a shell.';
        paneEl.replaceChildren(empty);
      }
    }
  }

  function setActivePane(paneId) {
    if (!findPane(layout, paneId)) {
      return;
    }
    activePaneId = paneId;
    mountSurfaces();
    const sessionId = activeSessionId();
    if (sessionId) {
      views.get(sessionId)?.term.focus();
      fitPane(paneId);
    }
    render();
  }

  /* ------------------------------------------------------------------ fitting */

  function fitPane(paneId) {
    const leaf = findPane(layout, paneId);
    if (!leaf?.sessionId) {
      return;
    }
    const paneEl = paneElement(paneId);
    if (!paneEl || paneEl.offsetParent === null) {
      return;
    }
    try {
      views.get(leaf.sessionId)?.fit.fit();
    } catch {
      // A pane mid-layout has no measurable box; the next resize fits it.
    }
  }

  function fitVisible() {
    for (const leaf of panes(layout)) {
      fitPane(leaf.paneId);
    }
  }

  /* ------------------------------------------------------------------ actions */

  async function newSession(options = {}) {
    const meta = await mux.create({ repo: resolveRepo().root, ...options });
    if (!meta) {
      notify('The server did not create a session.');
      return null;
    }
    ensureView(meta);
    attachSession(meta.id);
    assignToPane(meta.id, activePaneId);
    render();
    persistSoon();
    return meta;
  }

  async function openAgentSession({ agent, prompt, title, origin, repo } = {}) {
    const options = {
      kind: 'agent',
      title,
      origin,
      repo: repo ?? resolveRepo().root,
    };
    if (agent) {
      // The registry resolves an agent session from its argv; the prompt is typed into the
      // session once it is live, since the wire protocol has no prompt field.
      options.argv = [agent];
    }
    const meta = await newSession(options);
    if (meta && prompt) {
      mux.sendInput(meta.id, `${prompt}\r`);
    }
    return meta;
  }

  async function runPreset(preset) {
    const id = presetId(preset);
    if (!id) {
      return null;
    }
    const label = presetLabel(preset);
    // The registry derives the kind, argv, and cwd from the preset id; only the label is
    // passed through so a fresh session shows a useful tab name immediately.
    return newSession({ preset: id, title: label || undefined });
  }

  function assignToPane(sessionId, paneId = activePaneId) {
    const existing = paneForSession(layout, sessionId);
    if (existing) {
      setActivePane(existing.paneId);
      return;
    }
    const target = findPane(layout, paneId) ? paneId : (panes(layout)[0]?.paneId ?? paneId);
    layout = setPaneSession(layout, target, sessionId);
    setActivePane(target);
    mountSurfaces();
  }

  function openSession(id) {
    if (typeof id !== 'string' || id === '') {
      return;
    }
    wantedSessions.add(id);
    let meta = metas.get(id);
    if (!meta) {
      // A session created outside the socket (the REST delegate route) has no `created`
      // frame yet. Show it provisionally and ask for the authoritative list; the next
      // `sessions` frame replaces the placeholder with the server's metadata.
      meta = provisionalMeta(id);
      metas.set(id, meta);
      if (!order.includes(id)) {
        order.push(id);
      }
      mux.list();
    }
    ensureView(meta);
    // Attach even before the metadata arrives: the backlog is buffered and drawn once the
    // view is created, so a session created outside the socket still opens with history.
    attachSession(id);
    const existing = paneForSession(layout, id);
    if (existing) {
      setActivePane(existing.paneId);
    } else {
      assignToPane(id, activePaneId);
    }
    render();
  }

  /** A placeholder meta for a session the client has attached to but not yet been told about. */
  function provisionalMeta(id) {
    return {
      id,
      title: 'Agent session',
      kind: 'agent',
      cwd: '',
      repo: resolveRepo().root ?? '',
      pid: null,
      cols: 0,
      rows: 0,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      status: 'running',
      exitCode: null,
      seq: 0,
    };
  }

  function closeSession(id) {
    mux.kill(id);
    attachedSessions.delete(id);
    const view = views.get(id);
    if (view) {
      try {
        view.term.dispose();
      } catch {
        // A terminal already disposed is fine.
      }
      views.delete(id);
    }
    buffers.delete(id);
    metas.delete(id);
    wantedSessions.delete(id);
    order = order.filter((entry) => entry !== id);
    layout = detachSession(layout, id);
    renderLayoutDom();
    render();
    persistSoon();
    if (order.length === 0 && typeof hooks.closeTerminal === 'function') {
      hooks.closeTerminal();
    }
  }

  async function splitActive(direction) {
    ensureRestored();
    const target = findPane(layout, activePaneId) ? activePaneId : panes(layout)[0]?.paneId;
    if (!target) {
      return;
    }
    const paneId = newPaneId();
    layout = splitPane(layout, target, direction, paneId) ?? layout;
    renderLayoutDom();
    setActivePane(paneId);
    persistSoon();
    // A split opens a fresh shell in the new pane, which is what a split is for.
    await newSession();
  }

  function openSwitcher() {
    openSessionSwitcher({
      sessions: listSessions(),
      activeId: activeSessionId(),
      onPick: (id) => openSession(id),
    });
  }

  /* ----------------------------------------------------------------- toolbar */

  function toolbarButton(label, hint, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'terminal-toolbar-button';
    button.textContent = label;
    if (hint) {
      button.title = `${label} (${hint})`;
    }
    button.addEventListener('click', action);
    return button;
  }

  function buildToolbar() {
    toolbarEl.replaceChildren();
    const newButton = toolbarButton('New shell', 'Ctrl+Shift+T', () => {
      newSession().catch(handleError);
    });
    const runButton = toolbarButton('Run…', '', () => openRunMenu(runButton));
    const splitButton = toolbarButton('Split', 'Ctrl+Shift+E', () => {
      splitActive('row').catch(handleError);
    });
    const switchButton = toolbarButton('Sessions', 'Ctrl+K', openSwitcher);
    switchButton.id = 'terminal-switcher-button';
    toolbarEl.append(newButton, runButton, splitButton, switchButton);
  }

  function openRunMenu(anchor) {
    loadPresets(resolveRepo().root)
      .then((presets) =>
        openPresetMenu(anchor, {
          presets,
          onPick: (preset) => {
            runPreset(preset).catch(handleError);
          },
        }),
      )
      .catch((error) => notify(error.message));
  }

  function handleError(error) {
    notify(error instanceof Error ? error.message : String(error));
  }

  /* --------------------------------------------------------------- keyboard */

  function onKeydown(event) {
    if (screen.hidden) {
      return;
    }
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    const key = event.key.toLowerCase();
    const act = (fn) => {
      event.preventDefault();
      event.stopPropagation();
      fn();
    };
    if (event.shiftKey && key === 't') {
      act(() => newSession().catch(handleError));
      return;
    }
    if (event.shiftKey && key === 'w') {
      act(() => {
        const id = activeSessionId();
        if (id) {
          closeSession(id);
        }
      });
      return;
    }
    if (event.shiftKey && key === 'e') {
      act(() => splitActive('row').catch(handleError));
      return;
    }
    if (event.shiftKey && key === 'o') {
      act(() => splitActive('column').catch(handleError));
      return;
    }
    if (key === 'tab') {
      act(() => {
        const next = cycleSessionId(order, activeSessionId(), event.shiftKey ? -1 : 1);
        if (next) {
          openSession(next);
        }
      });
      return;
    }
    if (key === 'k') {
      act(openSwitcher);
      return;
    }
    if (!event.shiftKey && /^[1-9]$/.test(key)) {
      const id = digitSessionId(order, key);
      if (id) {
        act(() => openSession(id));
      }
      return;
    }
  }

  function onRepoChange() {
    persistFor(lastRoot);
    lastRoot = resolveRepo().root;
    // Only a screen with no sessions can swap layouts without stranding live terminals.
    if (order.length === 0) {
      loadSavedFor(lastRoot);
      activePaneId = panes(layout)[0]?.paneId ?? 'pane-1';
      syncOrder();
      attachWanted();
      renderLayoutDom();
      render();
    }
  }

  function onWindowResize() {
    if (!screen.hidden) {
      fitVisible();
    }
  }

  function persistNow() {
    clearTimeout(persistTimer);
    persistTimer = null;
    persistFor(resolveRepo().root);
  }

  /* -------------------------------------------------------------------- boot */

  buildToolbar();
  renderLayoutDom();
  screen.addEventListener('keydown', onKeydown, true);
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('beforeunload', persistNow);
  repoSelect?.addEventListener('change', onRepoChange);
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => {
      if (!screen.hidden) {
        fitVisible();
      }
    });
    resizeObserver.observe(panesEl);
  }

  return {
    /** The screen became visible: restore once, then fit and focus the active pane. */
    activate() {
      ensureRestored();
      renderLayoutDom();
      render();
      fitVisible();
      const sessionId = activeSessionId();
      if (sessionId) {
        views.get(sessionId)?.term.focus();
      }
    },

    applyTheme() {
      for (const view of views.values()) {
        view.term.options.theme = readTheme();
      }
    },

    newSession,
    openAgentSession,
    runPreset,
    listSessions,
    openSession,

    destroy() {
      clearTimeout(persistTimer);
      persistTimer = null;
      mux.dispose();
      for (const view of views.values()) {
        try {
          view.term.dispose();
        } catch {
          // Already disposed.
        }
      }
      views.clear();
      buffers.clear();
      metas.clear();
      attachedSessions.clear();
      wantedSessions.clear();
      order = [];
      layout = createLayout(newPaneId());
      resizeObserver?.disconnect();
      resizeObserver = null;
      screen.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('beforeunload', persistNow);
      repoSelect?.removeEventListener('change', onRepoChange);
      panesEl.replaceChildren();
      tabsEl.replaceChildren();
      toolbarEl.replaceChildren();
    },
  };
}

/** Find a stable child by id inside the container, creating it only when the markup lacks it. */
function ensureElement(container, id, className) {
  const existing = container.querySelector(`#${id}`);
  if (existing) {
    return existing;
  }
  const element = document.createElement('div');
  element.id = id;
  element.className = className;
  container.append(element);
  return element;
}
