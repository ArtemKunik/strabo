import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ClientMessage, ServerMessage } from '../../src/terminal/protocol.ts';
import {
  encodeServerMessage,
  parseClientMessage,
  TERMINAL_LIMITS,
} from '../../src/terminal/protocol.ts';

test('parseClientMessage accepts every valid client message', () => {
  const cases: Array<[string, ClientMessage]> = [
    [JSON.stringify({ type: 'hello' }), { type: 'hello' }],
    [JSON.stringify({ type: 'list' }), { type: 'list' }],
    [
      JSON.stringify({
        type: 'create',
        options: {
          kind: 'agent',
          repo: 'sample-repo',
          cwd: 'src',
          title: 'agent',
          preset: 'opencode',
          argv: ['opencode', '--prompt', 'hi'],
          origin: { node: 'src/index.ts', commit: 'abc', review: 'r1' },
          env: { FOO: 'bar' },
        },
      }),
      {
        type: 'create',
        options: {
          kind: 'agent',
          repo: 'sample-repo',
          cwd: 'src',
          title: 'agent',
          preset: 'opencode',
          argv: ['opencode', '--prompt', 'hi'],
          origin: { node: 'src/index.ts', commit: 'abc', review: 'r1' },
        },
      },
    ],
    [JSON.stringify({ type: 'attach', id: 'a' }), { type: 'attach', id: 'a' }],
    [JSON.stringify({ type: 'detach', id: 'a' }), { type: 'detach', id: 'a' }],
    [JSON.stringify({ type: 'input', id: 'a', data: 'ls\r' }), { type: 'input', id: 'a', data: 'ls\r' }],
    [JSON.stringify({ type: 'resize', id: 'a', cols: 120, rows: 40 }), { type: 'resize', id: 'a', cols: 120, rows: 40 }],
    [JSON.stringify({ type: 'rename', id: 'a', title: 'shell' }), { type: 'rename', id: 'a', title: 'shell' }],
    [JSON.stringify({ type: 'kill', id: 'a' }), { type: 'kill', id: 'a' }],
  ];
  for (const [raw, expected] of cases) {
    assert.deepEqual(parseClientMessage(raw), expected, raw);
  }
});

test('parseClientMessage drops the extra fields of a create message', () => {
  const parsed = parseClientMessage(
    JSON.stringify({ type: 'create', options: { kind: 'shell', env: { A: '1' }, origin: {} } }),
  );
  assert.deepEqual(parsed, { type: 'create', options: { kind: 'shell' } });
});

test('parseClientMessage rejects non-strings, malformed JSON, and unknown types', () => {
  assert.equal(parseClientMessage(42), null);
  assert.equal(parseClientMessage({ type: 'list' }), null);
  assert.equal(parseClientMessage('not json'), null);
  assert.equal(parseClientMessage('null'), null);
  assert.equal(parseClientMessage('[]'), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'nope' })), null);
});

test('parseClientMessage rejects malformed or incomplete payloads', () => {
  assert.equal(parseClientMessage(JSON.stringify({ type: 'attach' })), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'attach', id: 3 })), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'input', id: 'a' })), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'resize', id: 'a', cols: 0, rows: 24 })), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'resize', id: 'a', cols: 80, rows: -1 })), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'resize', id: 'a', cols: 80.5, rows: 24 })), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'rename', id: 'a', title: 5 })), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'kill' })), null);
});

test('parseClientMessage rejects an oversized input frame', () => {
  const data = 'x'.repeat(TERMINAL_LIMITS.maxInputChars + 1);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'input', id: 'a', data })), null);
  const atLimit = 'x'.repeat(TERMINAL_LIMITS.maxInputChars);
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'input', id: 'a', data: atLimit })), {
    type: 'input',
    id: 'a',
    data: atLimit,
  });
});

test('encodeServerMessage round-trips every server message shape', () => {
  const messages: ServerMessage[] = [
    { type: 'sessions', sessions: [] },
    {
      type: 'created',
      session: {
        id: 'a',
        title: 'shell',
        kind: 'shell',
        cwd: '/tmp',
        repo: '/tmp',
        pid: 12,
        cols: 80,
        rows: 24,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActivity: '2026-01-01T00:00:00.000Z',
        status: 'running',
        exitCode: null,
        seq: 0,
      },
    },
    { type: 'closed', id: 'a', code: 0 },
    { type: 'output', id: 'a', seq: 3, data: 'hi' },
    { type: 'backlog', id: 'a', fromSeq: 0, seq: 3, data: 'hi' },
    { type: 'title', id: 'a', title: 'shell' },
    { type: 'error', message: 'boom' },
    { type: 'error', message: 'boom', id: 'a' },
  ];
  for (const message of messages) {
    assert.deepEqual(JSON.parse(encodeServerMessage(message)), message);
  }
});
