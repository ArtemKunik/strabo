import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  closePane,
  countPanes,
  createLayout,
  detachSession,
  emptyPaneIds,
  findPane,
  firstEmptyPane,
  geometry,
  movePane,
  paneForSession,
  paneIds,
  panes,
  sanitizeLayout,
  setPaneSession,
  setRatio,
  splitPane,
} from '../../ui/strabo-terminal-split.js';
import {
  cycleSessionId,
  digitSessionId,
  inactiveSessionIds,
  moveInOrder,
  orderSessions,
  sessionTabLabel,
  tabBadge,
  tabLabels,
} from '../../ui/strabo-terminal-tabs.js';
import { findCitations } from '../../ui/strabo-terminal-linkify.js';
import {
  acceptOutput,
  backlogDelta,
  createTerminalMultiplexer,
  encodeClientMessage,
  nextReconnectDelay,
  parseServerMessage,
} from '../../ui/terminal-multiplexer.js';
import { filterSessions, fuzzyScore } from '../../ui/strabo-terminal-switcher.js';
import { loadPresets, normalizePresets, presetId, presetLabel } from '../../ui/strabo-terminal-presets.js';
import { terminalMenuItems } from '../../ui/strabo-terminal-menu.js';

/* --------------------------------------------------------------- split model */

test('splitPane makes a row split that lays its children out side by side', () => {
  const root = createLayout('p1');
  const split = splitPane(root, 'p1', 'row', 'p2');

  assert.equal(countPanes(split), 2);
  assert.deepEqual(paneIds(split), ['p1', 'p2']);

  const rects = geometry(split, { width: 206, height: 100 }, { splitter: 6 });
  assert.deepEqual(
    rects.map((rect) => [rect.paneId, rect.x, rect.width]),
    [
      ['p1', 0, 100],
      ['p2', 106, 100],
    ],
  );
  assert.ok(rects.every((rect) => rect.height === 100));
});

test('splitPane stacks a column split and carves the splitter out of the span', () => {
  const split = splitPane(createLayout('p1'), 'p1', 'column', 'p2');
  const rects = geometry(split, { width: 80, height: 206 }, { splitter: 6 });

  assert.deepEqual(
    rects.map((rect) => [rect.paneId, rect.y, rect.height]),
    [
      ['p1', 0, 100],
      ['p2', 106, 100],
    ],
  );
  // `vertical` is the alias for a column split.
  const alias = splitPane(createLayout('p1'), 'p1', 'vertical', 'p2');
  assert.equal(findPane(alias, 'p2')?.paneId, 'p2');
  assert.equal(alias.type === 'split' ? alias.direction : null, 'column');
});

test('closePane collapses the parent so no empty split survives', () => {
  const root = createLayout('p1');
  const split = splitPane(root, 'p1', 'row', 'p2');
  const closed = closePane(split, 'p2');

  assert.equal(closed?.type, 'leaf');
  assert.equal(closed?.paneId, 'p1');
  assert.equal(closePane(closed, 'p1'), null);
});

test('closePane keeps the sibling subtree when a nested pane closes', () => {
  const root = splitPane(createLayout('p1'), 'p1', 'row', 'p2');
  const nested = splitPane(root, 'p2', 'column', 'p3');
  const closed = closePane(nested, 'p2');

  assert.deepEqual(paneIds(closed), ['p1', 'p3']);
  // The nested split collapsed, but the row split remains.
  assert.equal(closed?.type, 'split');
});

test('setRatio clamps so a pane can never be dragged to zero', () => {
  const split = splitPane(createLayout('p1'), 'p1', 'row', 'p2');
  const splitId = split?.id;
  const squeezed = setRatio(split, splitId, 0);
  assert.equal(squeezed.ratio, 0.05);
  const stretched = setRatio(split, splitId, 5);
  assert.equal(stretched.ratio, 0.95);
});

test('setPaneSession, paneForSession, detachSession, and firstEmptyPane agree', () => {
  let root = createLayout('p1');
  assert.equal(firstEmptyPane(root)?.paneId, 'p1');

  root = setPaneSession(root, 'p1', 's1');
  assert.equal(paneForSession(root, 's1')?.paneId, 'p1');
  assert.equal(firstEmptyPane(root), null);

  root = detachSession(root, 's1');
  assert.equal(paneForSession(root, 's1'), null);
  assert.equal(firstEmptyPane(root)?.paneId, 'p1');
});

test('movePane refuses to strand a target that lived in the removed subtree', () => {
  const root = splitPane(createLayout('p1'), 'p1', 'row', 'p2');
  // Moving p1 beside itself is a no-op, and moving a pane into its own subtree is refused.
  assert.equal(movePane(root, 'p1', 'p1', 'row'), root);
  const moved = movePane(root, 'p1', 'p2', 'column', 'p1');
  assert.deepEqual(paneIds(moved).sort(), ['p1', 'p2']);
});

test('sanitizeLayout rejects corrupt storage and falls back to one pane', () => {
  const fallback = sanitizeLayout(null, 'pane-9');
  assert.equal(fallback.type, 'leaf');
  assert.equal(fallback.paneId, 'pane-9');

  const duplicate = sanitizeLayout(
    { type: 'split', id: 's', direction: 'row', ratio: 0.5, a: { type: 'leaf', paneId: 'x' }, b: { type: 'leaf', paneId: 'x' } },
    'pane-9',
  );
  assert.equal(duplicate.paneId, 'pane-9');

  const restored = sanitizeLayout(
    {
      type: 'split',
      id: 's',
      direction: 'column',
      ratio: 0.7,
      a: { type: 'leaf', paneId: 'a', sessionId: 's1' },
      b: { type: 'leaf', paneId: 'b' },
    },
    'pane-9',
  );
  assert.deepEqual(paneIds(restored), ['a', 'b']);
  assert.equal(findPane(restored, 'a')?.sessionId, 's1');
});

/* ------------------------------------------------------------------- tabs */

test('inactiveSessionIds picks the exited sessions, sparing the active and the kept panes', () => {
  const sessions = [
    { id: 'a', status: 'running' },
    { id: 'b', status: 'exited', exitCode: 0 },
    { id: 'c', status: 'exited', exitCode: 130 },
    { id: 'd', status: 'running' },
    { id: 'e', status: 'exited', exitCode: 0 },
  ];
  // The active session ('a') and the other visible pane ('d') stay, running or not.
  assert.deepEqual(inactiveSessionIds(sessions, 'a', ['d']), ['b', 'c', 'e']);
  // With no active session and nothing kept, every non-running session goes.
  assert.deepEqual(inactiveSessionIds(sessions, null), ['b', 'c', 'e']);
  assert.deepEqual(inactiveSessionIds([], 'a'), []);
  // A running session is never inactive, even when it is neither active nor kept.
  assert.deepEqual(inactiveSessionIds([{ id: 'z', status: 'running' }], null), []);
});

test('emptyPaneIds names the unbound slots and closePane collapses them away', () => {
  // Two sessions bound and two blank slots, the shape a few stray splits leave behind.
  let root = createLayout('p1');
  root = setPaneSession(root, 'p1', 's1');
  root = splitPane(root, 'p1', 'row', 'p2');
  root = splitPane(root, 'p2', 'column', 'p3');
  root = splitPane(root, 'p3', 'row', 'p4');
  assert.deepEqual(emptyPaneIds(root), ['p2', 'p3', 'p4']);

  let collapsed = root;
  for (const paneId of emptyPaneIds(root)) {
    collapsed = closePane(collapsed, paneId);
  }
  assert.equal(countPanes(collapsed), 1);
  assert.equal(findPane(collapsed, 'p1')?.sessionId, 's1');
});

test('orderSessions follows the saved order and appends unknown sessions', () => {
  const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(orderSessions(sessions, ['c', 'a']).map((s) => s.id), ['c', 'a', 'b']);
});

test('moveInOrder drops a dragged tab where its target was', () => {
  assert.deepEqual(moveInOrder(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(moveInOrder(['a', 'b', 'c'], 'a', 'c'), ['b', 'a', 'c']);
  assert.deepEqual(moveInOrder(['a', 'b'], 'a', 'a'), ['a', 'b']);
});

test('cycleSessionId wraps in both directions and digitSessionId maps Ctrl+1..9', () => {
  assert.equal(cycleSessionId(['a', 'b', 'c'], 'c', 1), 'a');
  assert.equal(cycleSessionId(['a', 'b', 'c'], 'a', -1), 'c');
  assert.equal(cycleSessionId([], 'a', 1), null);
  assert.equal(digitSessionId(['a', 'b'], '2'), 'b');
  assert.equal(digitSessionId(['a', 'b'], '3'), null);
  assert.equal(digitSessionId(['a', 'b'], '0'), null);
});

test('sessionTabLabel falls back to the kind and tabBadge names the exit code', () => {
  assert.equal(sessionTabLabel({ title: 'api server', kind: 'shell' }), 'api server');
  assert.equal(sessionTabLabel({ title: '  ', kind: 'agent' }), 'Agent');
  assert.deepEqual(tabBadge({ status: 'running', kind: 'shell' }), { className: 'is-running', label: 'running' });
  assert.deepEqual(tabBadge({ status: 'running', kind: 'watch' }), { className: 'is-watch', label: 'watching' });
  assert.deepEqual(tabBadge({ status: 'exited', exitCode: 0 }), { className: 'is-exited', label: 'exited' });
  assert.deepEqual(tabBadge({ status: 'exited', exitCode: 130 }), {
    className: 'is-exited is-error',
    label: 'exited 130',
  });
});

/* --------------------------------------------------------------- citations */

test('findCitations matches POSIX, Windows, and stack-frame citations', () => {
  const posix = findCitations('see src/foo.ts:12:3 now');
  assert.deepEqual(
    posix.map((citation) => [citation.path, citation.line, citation.column]),
    [['src/foo.ts', 12, 3]],
  );
  assert.equal(posix[0].index, 4);

  const windows = findCitations('C:\\repo\\src\\main.ts:7');
  assert.deepEqual(
    windows.map((citation) => [citation.path, citation.line, citation.column]),
    [['C:\\repo\\src\\main.ts', 7, null]],
  );

  const frame = findCitations('    at run (/home/dev/app/lib/run.js:10:15)');
  assert.deepEqual(
    frame.map((citation) => [citation.path, citation.line, citation.column]),
    [['/home/dev/app/lib/run.js', 10, 15]],
  );
});

test('findCitations rejects URLs and node_modules paths', () => {
  assert.deepEqual(findCitations('https://example.com/a.ts:1'), []);
  assert.deepEqual(findCitations('open node_modules/pkg/index.ts:3'), []);
  assert.deepEqual(findCitations('ws://host:8080/socket.ts:1'), []);
});

test('findCitations returns every citation on a line in order', () => {
  const found = findCitations('src/a.ts:1 and src/b.ts:2:4');
  assert.deepEqual(found.map((citation) => citation.path), ['src/a.ts', 'src/b.ts']);
  assert.equal(found[1].column, 4);
  assert.deepEqual(findCitations(''), []);
});

/* ------------------------------------------------------------- multiplexer */

test('nextReconnectDelay doubles from the floor and caps at the ceiling', () => {
  assert.equal(nextReconnectDelay(0), 500);
  assert.equal(nextReconnectDelay(500), 1000);
  assert.equal(nextReconnectDelay(4000), 8000);
  assert.equal(nextReconnectDelay(8000), 8000);
});

test('acceptOutput and backlogDelta never replay an already-drawn sequence', () => {
  assert.equal(acceptOutput(0, 1), true);
  assert.equal(acceptOutput(3, 3), false);
  assert.equal(acceptOutput(3, 2), false);
  assert.equal(acceptOutput(3, 4), true);

  assert.deepEqual(backlogDelta(0, { fromSeq: 0, seq: 3, data: 'abc' }), { data: 'abc', seq: 3, reset: false });
  assert.deepEqual(backlogDelta(3, { fromSeq: 3, seq: 5, data: 'de' }), { data: 'de', seq: 5, reset: false });
  assert.equal(backlogDelta(5, { fromSeq: 3, seq: 5, data: 'dupe' }), null);
  // The cursor is behind the slice start, so the caller must reset and replay, not duplicate.
  assert.deepEqual(backlogDelta(4, { fromSeq: 2, seq: 6, data: 'full' }), { data: 'full', seq: 6, reset: true });
  assert.equal(backlogDelta(0, null), null);
});

test('parseServerMessage accepts the known frames and drops malformed ones', () => {
  assert.deepEqual(parseServerMessage('{"type":"list"}'), null);
  assert.deepEqual(parseServerMessage(JSON.stringify({ type: 'output', id: 's', seq: 2, data: 'x' })), {
    type: 'output',
    id: 's',
    seq: 2,
    data: 'x',
  });
  assert.deepEqual(parseServerMessage(JSON.stringify({ type: 'closed', id: 's', code: 0 })), {
    type: 'closed',
    id: 's',
    code: 0,
  });
  assert.equal(parseServerMessage('{"type":"output","id":"s"}'), null);
  assert.equal(parseServerMessage('not json'), null);
  assert.equal(parseServerMessage(42), null);
  assert.equal(encodeClientMessage({ type: 'list' }), '{"type":"list"}');
});

test('the multiplexer requests backlog from the last-seen seq and dedupes output', () => {
  const sent = [];
  const listeners = new Map();
  const socket = {
    readyState: 1,
    send(frame) {
      sent.push(JSON.parse(frame));
    },
    close() {},
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
  };
  const events = [];
  const mux = createTerminalMultiplexer({
    url: 'ws://test/api/strabo/terminal',
    onEvent: (event) => events.push(event),
    socketFactory: () => socket,
  });

  socket.readyState = 1;
  for (const listener of listeners.get('open') ?? []) {
    listener({});
  }
  assert.deepEqual(
    sent.filter((frame) => frame.type === 'hello' || frame.type === 'list').map((frame) => frame.type),
    ['hello', 'list'],
  );

  mux.attach('s1');
  const attach = sent.find((frame) => frame.type === 'attach');
  assert.deepEqual(attach, { type: 'attach', id: 's1', fromSeq: 0 });

  const deliver = (message) => {
    for (const listener of listeners.get('message') ?? []) {
      listener({ data: JSON.stringify(message) });
    }
  };
  deliver({ type: 'backlog', id: 's1', fromSeq: 0, seq: 3, data: 'abc' });
  deliver({ type: 'output', id: 's1', seq: 3, data: 'dupe' });
  deliver({ type: 'output', id: 's1', seq: 4, data: 'd' });

  assert.deepEqual(
    events.filter((event) => event.type === 'output').map((event) => event.data),
    ['abc', 'd'],
  );

  mux.dispose();
});

/* ---------------------------------------------------------------- switcher */

test('fuzzyScore ranks contiguous matches and rejects non-subsequences', () => {
  assert.equal(fuzzyScore('src/api/service.ts', 'api') > fuzzyScore('alpha-pipeline', 'api'), true);
  assert.equal(fuzzyScore('anything', 'zzz'), -1);
  assert.equal(fuzzyScore('anything', ''), 0);
});

test('filterSessions matches title, kind, repo, and origin', () => {
  const sessions = [
    { id: '1', title: 'api server', kind: 'shell', repo: 'demo' },
    { id: '2', title: 'tests', kind: 'task', repo: 'other', origin: { commit: 'abc123' } },
  ];
  assert.deepEqual(filterSessions(sessions, 'api').map((s) => s.id), ['1']);
  assert.deepEqual(filterSessions(sessions, 'abc123').map((s) => s.id), ['2']);
  assert.deepEqual(filterSessions(sessions, 'agent'), []);
  assert.equal(filterSessions(sessions, '').length, 2);
});

/* ----------------------------------------------------------------- presets */

test('normalizePresets accepts strings and objects, dropping entries without an id', () => {
  const presets = normalizePresets({
    presets: ['build', { id: 'test', title: 'Run tests', description: 'vitest' }, { title: 'no id' }],
  });
  assert.deepEqual(presets, [
    { id: 'build', label: 'build', detail: '' },
    { id: 'test', label: 'Run tests', detail: 'vitest' },
  ]);
  assert.deepEqual(normalizePresets(null), []);
});

test('presetId and presetLabel read both shapes', () => {
  assert.equal(presetId('build'), 'build');
  assert.equal(presetId({ id: 'test' }), 'test');
  assert.equal(presetLabel({ id: 'test', label: 'Run tests' }), 'Run tests');
});

test('loadPresets fetches through API_PATH and surfaces an error on failure', async () => {
  let requested = '';
  const ok = await loadPresets('demo', {
    fetchImpl: async (url) => {
      requested = url;
      return { ok: true, json: async () => ({ presets: [{ id: 'build', title: 'Build' }] }) };
    },
  });
  assert.match(requested, /\/api\/strabo\/terminal\/presets\?repo=demo$/);
  assert.deepEqual(ok, [{ id: 'build', label: 'Build', detail: '' }]);

  await assert.rejects(
    loadPresets('demo', { fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /Presets unavailable \(503\)/,
  );
});

/* --------------------------------------------------------- context menu */

test('terminalMenuItems offers copy, paste, and select-all, gating copy on a selection', () => {
  const items = terminalMenuItems({ hasSelection: false });
  const byId = (id: string) => items.find((item) => item.id === id);

  assert.equal(byId('copy')?.label, '⧉ Copy');
  assert.ok(byId('copy')?.title, 'copy must explain why it is inactive without a selection');
  assert.equal(byId('paste')?.label, '⤓ Paste');
  assert.equal(byId('select-all')?.label, 'Select all');
  assert.equal(items.filter((item) => item.separator).length, 1);

  const selected = terminalMenuItems({ hasSelection: true });
  assert.equal(selected.find((item) => item.id === 'copy')?.title, undefined);
});

test('tabLabels disambiguates duplicate names with an ordinal', () => {
  const sessions = [
    { id: 'a', title: 'AssistantApplication', kind: 'shell' },
    { id: 'b', title: 'AssistantApplication', kind: 'shell' },
    { id: 'c', title: 'npm test', kind: 'task' },
    { id: 'd', title: 'AssistantApplication', kind: 'shell' },
  ];
  const labels = tabLabels(sessions);
  assert.equal(labels.get('a'), 'AssistantApplication 1');
  assert.equal(labels.get('b'), 'AssistantApplication 2');
  assert.equal(labels.get('c'), 'npm test');
  assert.equal(labels.get('d'), 'AssistantApplication 3');
});
