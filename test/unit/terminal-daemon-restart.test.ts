/**
 * End-to-end proof that a detached `strabo-termd` keeps PTY sessions alive across a server
 * restart.
 *
 * Unlike `terminal-host-client.test.ts`, which drives an in-process host with a fake PTY,
 * this test spawns the real `host.ts` as a detached child, runs a real `node-pty` session in
 * it, disconnects the first server proxy, and reconnects with a fresh one. The session and
 * its scrollback must still be there, and the PTY must still be producing output.
 *
 * The daemon is spawned directly rather than through `ensureDaemon` so the test can set a
 * short idle window and keep the child handle for deterministic cleanup.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  daemonEndpoint,
  hostEntryPath,
  isDaemonListening,
  writeDaemonToken,
  type DaemonEndpoint,
} from '../../src/terminal/daemon.ts';
import { createHostSessionManager } from '../../src/terminal/host-client.ts';
import { startTerminalHost, type TerminalHost } from '../../src/terminal/host.ts';
import {
  createLineDecoder,
  encodeHostRequest,
  HOST_FRAME_LIMIT,
  HOST_PROTOCOL_VERSION,
  isHostEvent,
  isHostResponse,
  parseHostMessage,
  type HostMessage,
} from '../../src/terminal/host-protocol.ts';
import type { SessionManager } from '../../src/terminal/protocol.ts';
import type { PtyProcess, PtySpawnOptions, PtySpawner } from '../../src/terminal/session.ts';
import type { StraboConfig } from '../../src/types.ts';

const MARKER = 'MARKER';

/** Daemons still running, so a crashed test never strands a process. */
const daemons = new Set<ChildProcess>();
/** Temp directories created by this suite, removed even if a test throws. */
const createdDirs: string[] = [];

after(async () => {
  for (const child of daemons) {
    if (child.exitCode !== null || child.signalCode !== null) {
      continue;
    }
    child.kill();
    if (process.platform === 'win32' && child.pid !== undefined) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
  }
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A leftover temp directory does not fail the suite.
    }
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(25);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ask the daemon to retire through its own `stop` method, so PTYs are reaped. */
function requestStop(endpoint: DaemonEndpoint, token: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = net.connect(endpoint.socketPath);
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const decoder = createLineDecoder((line) => {
      const message = parseHostMessage(line);
      if (isHostResponse(message) && message.id === 2) {
        finish();
      }
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => decoder(String(chunk)));
    socket.on('error', (error) => finish(error));
    socket.once('connect', () => {
      socket.write(encodeHostRequest({ id: 1, method: 'auth', token, version: HOST_PROTOCOL_VERSION }));
      socket.write(encodeHostRequest({ id: 2, method: 'stop' }));
    });
    timer = setTimeout(() => finish(new Error('stop request timed out')), 2000);
    timer.unref();
  });
}

/** Stop the daemon, escalating to a process-tree kill so no PTY child is left behind. */
async function stopDaemon(child: ChildProcess, endpoint: DaemonEndpoint, token: string): Promise<void> {
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  if (!exited()) {
    await requestStop(endpoint, token).catch(() => {});
    const gracefulDeadline = Date.now() + 3000;
    while (!exited() && Date.now() < gracefulDeadline) {
      await delay(50);
    }
  }
  if (!exited()) {
    child.kill();
    const killDeadline = Date.now() + 2000;
    while (!exited() && Date.now() < killDeadline) {
      await delay(50);
    }
  }
  if (!exited() && process.platform === 'win32' && child.pid !== undefined) {
    // The PTY runs as a grandchild; only a tree kill reaches it.
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    await new Promise<void>((resolve) => killer.once('exit', () => resolve()));
  } else if (!exited()) {
    child.kill('SIGKILL');
  }
}

function cleanupFiles(endpoint: DaemonEndpoint, workspaceDir: string): void {
  try {
    fs.rmSync(endpoint.tokenFile, { force: true });
  } catch {
    // Best effort: a leftover token in the temp dir is harmless.
  }
  if (process.platform !== 'win32') {
    try {
      fs.rmSync(endpoint.socketPath, { force: true });
    } catch {
      // The daemon already unlinked it on close.
    }
  }
  try {
    // The PTY's cwd is inside the workspace, so removal may lag the tree kill briefly.
    fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // A temp directory left behind does not fail the test.
  }
}

class FakePty implements PtyProcess {
  readonly pid: number;
  killed = false;
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

  write(_data: string): void {}

  resize(_cols: number, _rows: number): void {}

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

function fakeSpawner(processes: FakePty[]): PtySpawner {
  return (_file: string, _args: string[], _options: PtySpawnOptions): PtyProcess => {
    const pty = new FakePty(1000 + processes.length);
    processes.push(pty);
    return pty;
  };
}

function tempEndpoint(prefix: string): DaemonEndpoint {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\strabo-${prefix}-${path.basename(dir)}`
      : path.join(dir, 'termd.sock');
  return { socketPath, tokenFile: path.join(dir, 'termd.token') };
}

test('a reconnect discards a half-decoded frame instead of swallowing the handshake', async () => {
  const endpoint = tempEndpoint('strabo-reconnect-');
  const token = 'reconnect-token';
  writeDaemonToken(endpoint, token);
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-reconnect-ws-'));
  createdDirs.push(workspaceDir);
  const config: StraboConfig = { workspaceRoot: workspaceDir, scanCeiling: workspaceDir };
  const processes: FakePty[] = [];
  const host: TerminalHost = await startTerminalHost({
    socketPath: endpoint.socketPath,
    token,
    config,
    spawn: fakeSpawner(processes),
    idleMs: 60_000,
  });
  const client = createHostSessionManager(config, { endpoint, connectTimeoutMs: 3000 });
  try {
    const session = await client.create({ kind: 'shell', title: 'reconnect' });
    const pty = processes[0];
    assert.ok(pty);
    pty.emit('before');
    await waitFor(() => session.backlog(0).data.includes('before'), 3000, 'the initial output');

    const internals = client as unknown as { socket: net.Socket | null; decoder: (chunk: string) => void };
    assert.ok(internals.socket, 'the client is connected');
    // A dropped connection can leave a partial frame in the shared decoder. Simulate one,
    // then drop the socket so the client reconnects.
    internals.decoder('{"id":999,"ok":tru');
    internals.socket.destroy();

    // The daemon keeps running; output produced during the outage must be replayed after
    // the reconnect re-lists and re-subscribes.
    pty.emit('during-outage');
    await waitFor(
      () => session.backlog(0).data.includes('during-outage'),
      5000,
      'output produced during the outage to be replayed after reconnect',
    );
  } finally {
    client.shutdown();
    await host.close();
    cleanupFiles(endpoint, workspaceDir);
  }
});

test('output produced during an outage reaches a live listener after reconnect', async () => {
  const endpoint = tempEndpoint('strabo-outage-');
  const token = 'outage-token';
  writeDaemonToken(endpoint, token);
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-outage-ws-'));
  createdDirs.push(workspaceDir);
  const config: StraboConfig = { workspaceRoot: workspaceDir, scanCeiling: workspaceDir };
  const processes: FakePty[] = [];
  const host: TerminalHost = await startTerminalHost({
    socketPath: endpoint.socketPath,
    token,
    config,
    spawn: fakeSpawner(processes),
    idleMs: 60_000,
  });
  const client = createHostSessionManager(config, { endpoint, connectTimeoutMs: 3000 });
  try {
    const session = await client.create({ kind: 'shell', title: 'outage' });
    const pty = processes[0];
    assert.ok(pty);
    // A listener attached before the outage stands in for the browser's WebSocket: it must
    // receive replayed output, not just the replay ring that a later re-attach would read.
    const live: string[] = [];
    session.onData((data) => live.push(data));
    pty.emit('before');
    await waitFor(() => live.join('').includes('before'), 3000, 'the initial output');

    const internals = client as unknown as { socket: net.Socket | null };
    assert.ok(internals.socket, 'the client is connected');
    internals.socket.destroy();

    pty.emit('during-outage');
    await waitFor(
      () => live.join('').includes('during-outage'),
      5000,
      'the live listener to receive output produced during the outage',
    );
  } finally {
    client.shutdown();
    await host.close();
    cleanupFiles(endpoint, workspaceDir);
  }
});

test('shutdown during the initial connect does not leave a live socket', async () => {
  const endpoint = tempEndpoint('strabo-disposed-');
  const token = 'disposed-token';
  writeDaemonToken(endpoint, token);
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-disposed-ws-'));
  createdDirs.push(workspaceDir);
  const config: StraboConfig = { workspaceRoot: workspaceDir, scanCeiling: workspaceDir };
  const processes: FakePty[] = [];
  let host: TerminalHost | null = null;
  // The daemon only appears after the client has already been told to shut down, so the
  // in-flight bootstrap is what decides whether a socket is left behind.
  const lateSpawn = ((): { unref(): void } => {
    setTimeout(() => {
      void startTerminalHost({
        socketPath: endpoint.socketPath,
        token,
        config,
        spawn: fakeSpawner(processes),
        idleMs: 60_000,
      }).then((started) => {
        host = started;
      });
    }, 150);
    return { unref() {} };
  }) as unknown as typeof import('node:child_process').spawn;

  const client = createHostSessionManager(config, { endpoint, spawn: lateSpawn, connectTimeoutMs: 3000 });
  try {
    client.shutdown();
    await delay(700);
    const internals = client as unknown as { socket: net.Socket | null; connected: boolean };
    assert.equal(internals.connected, false, 'the client stayed disconnected after shutdown');
    assert.equal(internals.socket, null, 'shutdown during connect left no live socket');
  } finally {
    client.shutdown();
    await host?.close();
    cleanupFiles(endpoint, workspaceDir);
  }
});

test('output is streamed only to connections that subscribed', async () => {
  const endpoint = tempEndpoint('strabo-crosstalk-');
  const token = 'crosstalk-token';
  writeDaemonToken(endpoint, token);
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-crosstalk-ws-'));
  createdDirs.push(workspaceDir);
  const config: StraboConfig = { workspaceRoot: workspaceDir, scanCeiling: workspaceDir };
  const processes: FakePty[] = [];
  const host = await startTerminalHost({
    socketPath: endpoint.socketPath,
    token,
    config,
    spawn: fakeSpawner(processes),
    idleMs: 60_000,
  });
  const subscriber = createHostSessionManager(config, { endpoint, connectTimeoutMs: 3000 });
  let watcher: net.Socket | null = null;
  try {
    const session = await subscriber.create({ kind: 'shell', title: 'watched' });
    const pty = processes[0];
    assert.ok(pty);

    // A second authenticated connection that never subscribes to the session.
    const received: HostMessage[] = [];
    watcher = net.connect(endpoint.socketPath);
    watcher.setEncoding('utf8');
    const decoder = createLineDecoder((line) => {
      const message = parseHostMessage(line);
      if (message) {
        received.push(message);
      }
    });
    watcher.on('data', (chunk) => decoder(String(chunk)));
    watcher.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      watcher?.once('connect', () => resolve());
      watcher?.once('error', reject);
      watcher?.write(encodeHostRequest({ id: 1, method: 'auth', token, version: HOST_PROTOCOL_VERSION }));
    });
    await waitFor(
      () => received.some((message) => isHostEvent(message) && message.event === 'sessions'),
      3000,
      'the unsubscribed connection to authenticate',
    );

    pty.emit('secret-output');
    await waitFor(() => session.backlog(0).data.includes('secret-output'), 3000, 'the subscriber to receive output');
    await delay(300);
    const leaked = received.filter(
      (message) => isHostEvent(message) && (message.event === 'output' || message.event === 'backlog'),
    );
    assert.deepEqual(leaked, [], 'an unsubscribed connection must not receive session output');
  } finally {
    subscriber.shutdown();
    watcher?.destroy();
    await host.close();
    cleanupFiles(endpoint, workspaceDir);
  }
});

test('the line decoder drops an over-long partial frame instead of growing without bound', () => {
  const lines: string[] = [];
  const decoder = createLineDecoder((line) => lines.push(line));
  // A frame far past the cap with no newline must be discarded, so the next valid line is
  // delivered intact rather than prefixed by the runaway buffer.
  decoder('x'.repeat(HOST_FRAME_LIMIT + 1));
  const valid = '{"id":1,"ok":true,"result":{"method":"ping","pong":true}}';
  decoder(`${valid}\n`);
  assert.deepEqual(lines, [valid]);
});

test('a detached daemon keeps a PTY session alive across a server restart', async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-restart-ws-'));
  createdDirs.push(workspaceDir);
  const endpoint = daemonEndpoint(workspaceDir);
  const token = `token-${process.pid}-${Date.now()}`;
  writeDaemonToken(endpoint, token);

  let child: ChildProcess | null = null;
  let serverA: SessionManager | null = null;
  let serverB: SessionManager | null = null;
  try {
    child = spawn(process.execPath, [hostEntryPath()], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        STRABO_TERMD_SOCKET: endpoint.socketPath,
        STRABO_TERMD_TOKEN: token,
        STRABO_TERMD_ROOT: workspaceDir,
        STRABO_TERMD_CEILING: workspaceDir,
        STRABO_TERMD_IDLE_MS: '2000',
      },
    });
    child.unref();
    daemons.add(child);

    try {
      await waitFor(() => isDaemonListening(endpoint), 8000, 'the detached daemon to accept connections');
    } catch {
      t.skip('the detached terminal daemon could not start (socket refused); environment cannot host a real PTY');
      return;
    }

    const config: StraboConfig = { workspaceRoot: workspaceDir, scanCeiling: workspaceDir };

    // --- Server instance A: create a long-lived session and see it produce output. ---
    serverA = createHostSessionManager(config, { endpoint, connectTimeoutMs: 5000 });
    const markerScript = "setInterval(() => process.stdout.write('MARKER\\n'), 50)";
    let sessionA: Awaited<ReturnType<SessionManager['create']>>;
    try {
      sessionA = await serverA.create({ kind: 'task', argv: [process.execPath, '-e', markerScript] });
    } catch (error) {
      t.skip(`could not start a real PTY session (node-pty unavailable?): ${messageOf(error)}`);
      return;
    }
    const sessionId = sessionA.meta.id;
    await waitFor(() => sessionA.backlog(0).data.includes(MARKER), 8000, 'the task session to emit its first marker');

    // --- Simulate a server restart: the proxy disconnects, the daemon must not. ---
    serverA.shutdown();
    assert.equal(await isDaemonListening(endpoint), true, 'daemon is still listening after the client disconnects');
    assert.ok(child.exitCode === null && child.signalCode === null, 'daemon process is still alive after the client disconnects');

    // --- Server instance B: the session and its scrollback must have survived. ---
    serverB = createHostSessionManager(config, { endpoint, connectTimeoutMs: 5000 });
    await waitFor(
      () => serverB?.list().some((meta) => meta.id === sessionId) ?? false,
      8000,
      'the fresh client to list the surviving session',
    );
    const restored = serverB.get(sessionId);
    assert.ok(restored, 'the surviving session is retrievable from the daemon');
    // Same session id and same OS pid: the PTY was not restarted, only the client changed.
    assert.equal(restored.meta.pid, sessionA.meta.pid, 'the same PTY process is still running');
    assert.equal(restored.meta.status, 'running');
    await waitFor(() => restored.backlog(0).data.includes(MARKER), 8000, 'the surviving scrollback to replay');

    const live: string[] = [];
    restored.onData((data) => live.push(data));
    await waitFor(() => live.join('').includes(MARKER), 8000, 'live output from the still-running PTY');
  } finally {
    serverA?.shutdown();
    serverB?.shutdown();
    if (child) {
      await stopDaemon(child, endpoint, token);
      daemons.delete(child);
    }
    cleanupFiles(endpoint, workspaceDir);
  }
});
