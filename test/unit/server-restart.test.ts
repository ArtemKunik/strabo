import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Server } from 'node:http';

import { createRestart } from '../../src/server-restart.ts';

test('createRestart closes the server, spawns the same command detached, and exits', () => {
  let closed = false;
  let unrefed = false;
  let spawned: { command: string; args: readonly string[]; options: Record<string, unknown> } | null = null;
  let exitCode: number | null = null;

  const server = {
    close(callback: () => void) {
      closed = true;
      callback();
    },
    closeAllConnections() {},
  } as unknown as Server;

  const child = {
    unref: () => {
      unrefed = true;
    },
  };

  const restart = createRestart(server, {
    execPath: '/usr/bin/node',
    argv: ['bin/strabo.js', '--host', '127.0.0.1'],
    cwd: '/repo',
    env: { PORT: '3000' },
    spawn: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      spawned = { command, args, options };
      return child;
    }) as never,
    exit: (code: number) => {
      exitCode = code;
    },
  });

  restart();

  assert.equal(closed, true);
  assert.equal(unrefed, true);
  assert.equal(spawned?.command, '/usr/bin/node');
  assert.deepEqual(spawned?.args, ['bin/strabo.js', '--host', '127.0.0.1']);
  assert.equal(spawned?.options.detached, true);
  assert.equal(spawned?.options.cwd, '/repo');
  assert.equal(spawned?.options.stdio, 'ignore');
  assert.equal(exitCode, 0);
});

test('createRestart drops open connections so the close callback is not held open', () => {
  let dropped = false;
  const server = {
    close(callback: () => void) {
      callback();
    },
    closeAllConnections() {
      dropped = true;
    },
  } as unknown as Server;

  const restart = createRestart(server, {
    spawn: (() => ({ unref: () => {} })) as never,
    exit: () => {},
  });
  restart();

  assert.equal(dropped, true);
});

test('createRestart relaunches even while a WebSocket upgrade holds a socket open', async () => {
  const http = await import('node:http');
  const { WebSocketServer, WebSocket } = await import('ws');
  const server = http.createServer((_request, response) => response.end('ok'));
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => wss.handleUpgrade(request, socket, head, () => {}));
  let exited: number | null = null;
  let spawned = false;
  const restart = createRestart(server, {
    spawn: (() => {
      spawned = true;
      return { unref: () => {} };
    }) as never,
    exit: (code: number) => {
      exited = code;
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const client = new WebSocket(`ws://127.0.0.1:${port}/`);
  await new Promise((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });

  restart();
  // Before the fix the upgraded socket kept `server.close` waiting forever.
  for (let i = 0; i < 50 && exited === null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(spawned, true);
  assert.equal(exited, 0);
  client.terminate();
  wss.close();
});
