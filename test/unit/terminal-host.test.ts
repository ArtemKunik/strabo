import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { HostEvent, HostMessage, HostRequest, HostResponse } from '../../src/terminal/host-protocol.ts';
import {
  createLineDecoder,
  encodeHostMessage,
  HOST_PROTOCOL_VERSION,
  isHostEvent,
  isHostResponse,
  parseHostMessage,
} from '../../src/terminal/host-protocol.ts';
import type { TerminalHost } from '../../src/terminal/host.ts';
import { startTerminalHost } from '../../src/terminal/host.ts';
import type { CreateSessionOptions } from '../../src/terminal/protocol.ts';
import type { PtyProcess, PtySpawner } from '../../src/terminal/session.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'sample-repo');
const TOKEN = 'test-token';

class FakePty implements PtyProcess {
  readonly pid: number;
  killed = false;
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number }) => void>();

  constructor(pid: number) {
    this.pid = pid;
  }

  onData(callback: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(callback);
    return { dispose: () => this.dataListeners.delete(callback) };
  }

  onExit(callback: (event: { exitCode: number }) => void): { dispose(): void } {
    this.exitListeners.add(callback);
    return { dispose: () => this.exitListeners.delete(callback) };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    if (this.killed) {
      return;
    }
    this.killed = true;
    this.exit(0);
  }

  emit(data: string): void {
    for (const callback of [...this.dataListeners]) {
      callback(data);
    }
  }

  exit(code: number): void {
    for (const callback of [...this.exitListeners]) {
      callback({ exitCode: code });
    }
  }
}

interface Harness {
  host: TerminalHost;
  processes: FakePty[];
  socketPath: string;
  exitSignal: Promise<number>;
}

let socketCounter = 0;
const hosts: TerminalHost[] = [];
const clients: TestClient[] = [];

after(async () => {
  for (const client of clients) {
    client.close();
  }
  for (const host of hosts) {
    await host.close();
  }
});

function makeSocketPath(): string {
  socketCounter += 1;
  const name = `strabo-termd-${process.pid}-${Date.now()}-${socketCounter}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

async function startHarness(idleMs = 0): Promise<Harness> {
  const processes: FakePty[] = [];
  const spawner: PtySpawner = () => {
    const pty = new FakePty(1000 + processes.length);
    processes.push(pty);
    return pty;
  };
  let resolveExit: (code: number) => void = () => {};
  const exitSignal = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const socketPath = makeSocketPath();
  const host = await startTerminalHost({
    socketPath,
    token: TOKEN,
    config: { workspaceRoot: fixture, scanCeiling: fixture },
    spawn: spawner,
    idleMs,
    exit: (code) => resolveExit(code),
  });
  hosts.push(host);
  return { host, processes, socketPath, exitSignal };
}

let requestCounter = 0;
function nextId(): number {
  requestCounter += 1;
  return requestCounter;
}

class TestClient {
  readonly socket: net.Socket;
  readonly name: string;
  private readonly messages: HostMessage[] = [];
  private readonly waiters: Array<{
    match: (message: HostMessage) => boolean;
    resolve: (message: HostMessage) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(socket: net.Socket, name: string) {
    this.socket = socket;
    this.name = name;
    socket.setEncoding('utf8');
    socket.on('error', () => {
      // The host tears sockets down on close/stop; that is not a test failure.
    });
    const decoder = createLineDecoder((line) => this.onLine(line));
    socket.on('data', (chunk) => decoder(String(chunk)));
  }

  static connect(socketPath: string, name = 'client'): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      const onError = (error: Error): void => {
        socket.removeListener('connect', onConnect);
        reject(error);
      };
      const onConnect = (): void => {
        socket.removeListener('error', onError);
        const client = new TestClient(socket, name);
        clients.push(client);
        resolve(client);
      };
      socket.once('error', onError);
      socket.once('connect', onConnect);
    });
  }

  private onLine(line: string): void {
    const message = parseHostMessage(line);
    if (!message) {
      return;
    }
    for (let index = 0; index < this.waiters.length; index += 1) {
      const waiter = this.waiters[index];
      if (waiter && waiter.match(message)) {
        this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        return;
      }
    }
    this.messages.push(message);
  }

  send(request: HostRequest): void {
    // Requests share the wire framing with host messages; this is the same encoder the
    // client uses, cast because the frozen contract types the two directions separately.
    this.socket.write(encodeHostMessage(request as unknown as HostMessage));
  }

  take(match: (message: HostMessage) => boolean, timeoutMs = 2000): Promise<HostMessage> {
    const index = this.messages.findIndex(match);
    if (index !== -1) {
      const [message] = this.messages.splice(index, 1);
      return Promise.resolve(message as HostMessage);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (at !== -1) {
          this.waiters.splice(at, 1);
        }
        reject(new Error(`${this.name}: timed out waiting for a host message; queued: ${JSON.stringify(this.messages)}`));
      }, timeoutMs);
      this.waiters.push({ match, resolve, timer });
    });
  }

  async response(id: number): Promise<HostResponse> {
    return (await this.take((message) => isHostResponse(message) && message.id === id)) as HostResponse;
  }

  async event(event: HostEvent['event'], sessionId?: string): Promise<HostEvent> {
    return (await this.take(
      (message) =>
        isHostEvent(message) &&
        message.event === event &&
        (sessionId === undefined || ('sessionId' in message && message.sessionId === sessionId)),
    )) as HostEvent;
  }

  async expectNoMessage(match: (message: HostMessage) => boolean, timeoutMs = 150): Promise<void> {
    await assert.rejects(() => this.take(match, timeoutMs), /timed out/);
  }

  close(): void {
    this.socket.destroy();
  }
}

async function authenticate(client: TestClient): Promise<void> {
  const id = nextId();
  client.send({ id, method: 'auth', token: TOKEN, version: HOST_PROTOCOL_VERSION });
  const response = await client.response(id);
  assert.equal(response.ok, true);
  // The host pushes a metadata snapshot on auth; consume it so later waits are unambiguous.
  await client.event('sessions');
}

async function createSession(client: TestClient, options: CreateSessionOptions = {}): Promise<string> {
  const id = nextId();
  client.send({ id, method: 'create', options });
  const response = await client.response(id);
  assert.equal(response.ok, true);
  const meta = response.ok && response.result.method === 'create' ? response.result.session : null;
  assert.ok(meta);
  await client.event('created');
  await client.event('sessions');
  return meta.id;
}

test('an unauthenticated frame is ignored and a bad token is refused', async () => {
  const harness = await startHarness();
  try {
    const client = await TestClient.connect(harness.socketPath);

    const pingId = nextId();
    client.send({ id: pingId, method: 'ping' });
    await client.expectNoMessage((message) => isHostResponse(message) && message.id === pingId);

    const wrongVersionId = nextId();
    client.send({ id: wrongVersionId, method: 'auth', token: TOKEN, version: HOST_PROTOCOL_VERSION + 1 });
    const badVersion = await client.response(wrongVersionId);
    assert.equal(badVersion.ok, false);
    if (!badVersion.ok) {
      assert.equal(badVersion.error, 'unauthorized');
    }
  } finally {
    await harness.host.close();
  }
});

test('a wrong token is answered unauthorized and the socket is destroyed', async () => {
  const harness = await startHarness();
  try {
    const client = await TestClient.connect(harness.socketPath);
    const id = nextId();
    client.send({ id, method: 'auth', token: 'not-the-token', version: HOST_PROTOCOL_VERSION });
    const response = await client.response(id);
    assert.equal(response.ok, false);
    if (!response.ok) {
      assert.equal(response.error, 'unauthorized');
    }
    await new Promise<void>((resolve) => client.socket.once('close', () => resolve()));
  } finally {
    await harness.host.close();
  }
});

test('auth succeeds and list is empty', async () => {
  const harness = await startHarness();
  try {
    const client = await TestClient.connect(harness.socketPath);
    await authenticate(client);

    const id = nextId();
    client.send({ id, method: 'list' });
    const response = await client.response(id);
    assert.equal(response.ok, true);
    if (response.ok && response.result.method === 'list') {
      assert.deepEqual(response.result.sessions, []);
    }
  } finally {
    await harness.host.close();
  }
});

test('dispatches create, write, resize, rename, backlog, and kill', async () => {
  const harness = await startHarness();
  try {
    const client = await TestClient.connect(harness.socketPath);
    await authenticate(client);
    const sessionId = await createSession(client, { kind: 'shell' });
    const pty = harness.processes[0];
    assert.ok(pty);

    const writeId = nextId();
    client.send({ id: writeId, method: 'write', sessionId, data: 'ls\r' });
    const write = await client.response(writeId);
    assert.equal(write.ok, true);
    assert.deepEqual(pty.writes, ['ls\r']);

    const resizeId = nextId();
    client.send({ id: resizeId, method: 'resize', sessionId, cols: 100, rows: 40 });
    const resize = await client.response(resizeId);
    assert.equal(resize.ok, true);
    assert.deepEqual(pty.resizes, [{ cols: 100, rows: 40 }]);

    const renameId = nextId();
    client.send({ id: renameId, method: 'rename', sessionId, title: 'renamed' });
    const rename = await client.response(renameId);
    assert.equal(rename.ok, true);
    if (rename.ok && rename.result.method === 'rename') {
      assert.equal(rename.result.renamed, true);
    }
    await client.event('sessions');

    pty.emit('output-1');
    const backlogId = nextId();
    client.send({ id: backlogId, method: 'backlog', sessionId, fromSeq: 0 });
    const backlog = await client.response(backlogId);
    assert.equal(backlog.ok, true);
    if (backlog.ok && backlog.result.method === 'backlog') {
      assert.deepEqual(backlog.result.slice, { fromSeq: 0, seq: 1, data: 'output-1' });
    }

    const killId = nextId();
    client.send({ id: killId, method: 'kill', sessionId });
    const kill = await client.response(killId);
    assert.equal(kill.ok, true);
    if (kill.ok && kill.result.method === 'kill') {
      assert.equal(kill.result.killed, true);
    }
    assert.equal(pty.killed, true);
    const closed = await client.event('closed', sessionId);
    assert.equal(closed.event, 'closed');
  } finally {
    await harness.host.close();
  }
});

test('subscribe replays the backlog then streams output with no gap or duplicate', async () => {
  const harness = await startHarness();
  try {
    const client = await TestClient.connect(harness.socketPath);
    await authenticate(client);
    const sessionId = await createSession(client);
    const pty = harness.processes[0];
    assert.ok(pty);

    pty.emit('one');
    pty.emit('two');

    const subscribeId = nextId();
    client.send({ id: subscribeId, method: 'subscribe', sessionId, fromSeq: 0 });
    const subscribed = await client.response(subscribeId);
    assert.equal(subscribed.ok, true);

    const backlog = await client.event('backlog', sessionId);
    assert.ok(backlog.event === 'backlog');
    assert.equal(backlog.fromSeq, 0);
    assert.equal(backlog.seq, 2);
    assert.equal(backlog.data, 'onetwo');

    // The already-covered chunks must not be replayed as live output.
    await client.expectNoMessage(
      (message) => isHostEvent(message) && message.event === 'output' && message.sessionId === sessionId,
    );

    pty.emit('three');
    const output = await client.event('output', sessionId);
    assert.ok(output.event === 'output');
    assert.equal(output.seq, 3);
    assert.equal(output.data, 'three');
    await client.expectNoMessage(
      (message) => isHostEvent(message) && message.event === 'output' && message.sessionId === sessionId,
    );

    const unsubscribeId = nextId();
    client.send({ id: unsubscribeId, method: 'unsubscribe', sessionId });
    const unsubscribed = await client.response(unsubscribeId);
    assert.equal(unsubscribed.ok, true);

    pty.emit('four');
    await client.expectNoMessage(
      (message) => isHostEvent(message) && message.event === 'output' && message.sessionId === sessionId,
    );
  } finally {
    await harness.host.close();
  }
});

test('a session exit reaches subscribers and broadcasts the list', async () => {
  const harness = await startHarness();
  try {
    const client = await TestClient.connect(harness.socketPath);
    await authenticate(client);
    const sessionId = await createSession(client);
    const pty = harness.processes[0];
    assert.ok(pty);

    const subscribeId = nextId();
    client.send({ id: subscribeId, method: 'subscribe', sessionId, fromSeq: 0 });
    await client.response(subscribeId);
    await client.event('backlog', sessionId);

    pty.exit(7);

    const exit = await client.event('exit', sessionId);
    assert.ok(exit.event === 'exit');
    assert.equal(exit.code, 7);

    const sessions = await client.event('sessions');
    assert.ok(sessions.event === 'sessions');
    const meta = sessions.sessions.find((entry) => entry.id === sessionId);
    assert.equal(meta?.status, 'exited');
    assert.equal(meta?.exitCode, 7);
  } finally {
    await harness.host.close();
  }
});

test('a second authenticated connection sees created and sessions broadcasts', async () => {
  const harness = await startHarness();
  try {
    const first = await TestClient.connect(harness.socketPath, 'first');
    await authenticate(first);
    const second = await TestClient.connect(harness.socketPath, 'second');
    await authenticate(second);

    const sessionId = await createSession(first);

    const created = await second.event('created');
    assert.ok(created.event === 'created');
    assert.equal(created.meta.id, sessionId);

    const sessions = await second.event('sessions');
    assert.ok(sessions.event === 'sessions');
    assert.deepEqual(sessions.sessions.map((entry) => entry.id), [sessionId]);
  } finally {
    await harness.host.close();
  }
});

test('unknown sessions answer with an error rather than throwing', async () => {
  const harness = await startHarness();
  try {
    const client = await TestClient.connect(harness.socketPath);
    await authenticate(client);

    // These address a session directly, so a missing one is an error reply.
    for (const method of ['backlog', 'write', 'resize', 'subscribe'] as const) {
      const id = nextId();
      if (method === 'backlog') {
        client.send({ id, method, sessionId: 'missing', fromSeq: 0 });
      } else if (method === 'write') {
        client.send({ id, method, sessionId: 'missing', data: 'x' });
      } else if (method === 'resize') {
        client.send({ id, method, sessionId: 'missing', cols: 1, rows: 1 });
      } else {
        client.send({ id, method, sessionId: 'missing' });
      }
      const response = await client.response(id);
      assert.equal(response.ok, false, `${method} should fail for an unknown session`);
      if (!response.ok) {
        assert.match(response.error, /unknown session/);
      }
    }

    // These report a boolean rather than an error.
    const killId = nextId();
    client.send({ id: killId, method: 'kill', sessionId: 'missing' });
    const kill = await client.response(killId);
    assert.equal(kill.ok, true);
    if (kill.ok && kill.result.method === 'kill') {
      assert.equal(kill.result.killed, false);
    }

    const renameId = nextId();
    client.send({ id: renameId, method: 'rename', sessionId: 'missing', title: 'x' });
    const rename = await client.response(renameId);
    assert.equal(rename.ok, true);
    if (rename.ok && rename.result.method === 'rename') {
      assert.equal(rename.result.renamed, false);
    }
  } finally {
    await harness.host.close();
  }
});

test('stop acknowledges, kills sessions, and shuts the host down', async () => {
  const harness = await startHarness();
  const client = await TestClient.connect(harness.socketPath);
  await authenticate(client);
  await createSession(client);
  const pty = harness.processes[0];
  assert.ok(pty);

  const id = nextId();
  client.send({ id, method: 'stop' });
  const response = await client.response(id);
  assert.equal(response.ok, true);

  const code = await harness.exitSignal;
  assert.equal(code, 0);
  assert.equal(pty.killed, true);
  // close() is idempotent and completes after stop already tore the server down.
  await harness.host.close();
});

test('close kills every session and removes the socket file', async () => {
  const harness = await startHarness();
  const client = await TestClient.connect(harness.socketPath);
  await authenticate(client);
  await createSession(client);
  const pty = harness.processes[0];
  assert.ok(pty);

  await harness.host.close();
  assert.equal(pty.killed, true);
  if (process.platform !== 'win32') {
    assert.equal(fs.existsSync(harness.socketPath), false);
  }
});

test('an idle host closes and exits on its own', async () => {
  const harness = await startHarness(60);
  const code = await harness.exitSignal;
  assert.equal(code, 0);
  await harness.host.close();
});
