import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SessionMeta } from '../../src/terminal/protocol.ts';
import { createPtySession, normalizeOscTitle } from '../../src/terminal/session.ts';
import type { PtyProcess, PtySpawner } from '../../src/terminal/session.ts';

test('normalizeOscTitle rejects paths, shell names, and bare executables', () => {
  assert.equal(normalizeOscTitle('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), null);
  assert.equal(normalizeOscTitle('D:\\source\\AssistantApplication'), null);
  assert.equal(normalizeOscTitle('\\\\server\\share\\dir'), null);
  assert.equal(normalizeOscTitle('/usr/bin/bash'), null);
  assert.equal(normalizeOscTitle('Windows PowerShell'), null);
  assert.equal(normalizeOscTitle('cmd.exe'), null);
  assert.equal(normalizeOscTitle('-bash'), null);
  assert.equal(normalizeOscTitle('   '), null);
});

test('normalizeOscTitle keeps and tidies a meaningful title', () => {
  assert.equal(normalizeOscTitle('npm test'), 'npm test');
  assert.equal(normalizeOscTitle('  vim   src/server.ts '), 'vim src/server.ts');
  assert.equal(normalizeOscTitle('Administrator: npm test'), 'npm test');
  assert.equal(normalizeOscTitle('user@host: ~/project'), 'user@host: ~/project');
  assert.equal(normalizeOscTitle('x'.repeat(200))?.length, 80);
});

function capturingPty(): { spawner: PtySpawner; emit: (data: string) => void } {
  let dataListener: ((data: string) => void) | null = null;
  const process: PtyProcess = {
    pid: 4242,
    onData(listener) {
      dataListener = listener;
    },
    onExit() {},
    write() {},
    resize() {},
    kill() {},
  };
  return { spawner: () => process, emit: (data) => dataListener?.(data) };
}

function meta(): SessionMeta {
  const now = new Date().toISOString();
  return {
    id: 's1',
    title: 'AssistantApplication',
    kind: 'shell',
    cwd: '/repo',
    repo: '/repo',
    pid: null,
    cols: 80,
    rows: 24,
    createdAt: now,
    lastActivity: now,
    status: 'running',
    exitCode: null,
    seq: 0,
  };
}

test('a noisy OSC title is ignored and the assigned title is kept', async () => {
  const { spawner, emit } = capturingPty();
  const session = await createPtySession({ meta: meta(), env: {}, spawner });
  const titles: string[] = [];
  session.onTitle((title) => titles.push(title));

  emit('\x1b]0;C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\x07');

  assert.deepEqual(titles, []);
  assert.equal(session.meta.title, 'AssistantApplication');
});

test('a meaningful OSC title renames the session everywhere', async () => {
  const { spawner, emit } = capturingPty();
  const session = await createPtySession({ meta: meta(), env: {}, spawner });
  const titles: string[] = [];
  session.onTitle((title) => titles.push(title));

  emit('\x1b]0;npm test\x07');

  assert.deepEqual(titles, ['npm test']);
  assert.equal(session.meta.title, 'npm test');
});
