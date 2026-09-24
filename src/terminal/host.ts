/**
 * The detached terminal daemon host (`strabo-termd`).
 *
 * This process owns the PTYs and serves them over a local socket — a Unix domain socket on
 * POSIX, a named pipe on Windows — speaking the newline-delimited JSON contract in
 * `host-protocol.ts`. It is deliberately transport-light: `net` hides the platform
 * difference, so the same `socketPath` works on both.
 *
 * Sessions outlive any single server. A server process connects, authenticates with the
 * shared token, and mirrors session metadata; output is only streamed to connections that
 * explicitly subscribed. The daemon exits on its own once it is idle — no connections and no
 * sessions for `idleMs` — so a forgotten process does not linger forever.
 *
 * Request validation lives in `host-protocol.ts` (`parseHostRequest`) so the daemon and the
 * client cannot drift on what a well-formed frame is.
 */
import fs from 'node:fs';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

import type { StraboConfig } from '../types.ts';
import type { HostEvent, HostMessage, HostRequest, HostResult } from './host-protocol.ts';
import {
  createLineDecoder,
  encodeHostMessage,
  HOST_AUTH_TIMEOUT_MS,
  HOST_PROTOCOL_VERSION,
  parseHostRequest,
} from './host-protocol.ts';
import type { SessionManager, TerminalSession } from './protocol.ts';
import { createSessionManager } from './registry.ts';
import type { PtySpawner } from './session.ts';

/** No connections and no sessions for this long and the daemon exits; 0 disables it. */
const DEFAULT_IDLE_MS = 30 * 60 * 1000;

export interface TerminalHostOptions {
  socketPath: string;
  token: string;
  config: StraboConfig;
  /** Injected PTY factory for tests; production leaves it to the registry's lazy `node-pty`. */
  spawn?: PtySpawner;
  /** Idle window before self-exit; defaults to 30 minutes, `0` disables. */
  idleMs?: number;
  onLog?: (message: string) => void;
  /**
   * Terminates the process. Injected by tests so an idle or `stop` shutdown can be observed
   * without ending the test runner; production defaults to `process.exit`.
   */
  exit?: (code: number) => void;
}

export interface TerminalHost {
  readonly socketPath: string;
  close(): Promise<void>;
}

interface Connection {
  readonly socket: net.Socket;
  authenticated: boolean;
  authTimer: NodeJS.Timeout | null;
  /** sessionId -> detach of this connection's data/exit/title listeners. */
  readonly subscriptions: Map<string, () => void>;
  /** Last request id seen, so an auth timeout can name a frame it is refusing. */
  lastId: number;
}

export async function startTerminalHost(options: TerminalHostOptions): Promise<TerminalHost> {
  const { socketPath, token, config } = options;
  const idleMs = options.idleMs === undefined ? DEFAULT_IDLE_MS : options.idleMs;
  const onLog = options.onLog ?? (() => {});
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const manager: SessionManager = createSessionManager(config, options.spawn ? { spawn: options.spawn } : {});

  const connections = new Set<Connection>();
  /** sessionId -> detach of the host's own exit watcher. */
  const known = new Map<string, () => void>();
  let idleTimer: NodeJS.Timeout | null = null;
  let closed = false;
  let closing = false;

  function send(conn: Connection, message: HostMessage): void {
    if (conn.socket.destroyed || conn.socket.writableEnded) {
      return;
    }
    try {
      conn.socket.write(encodeHostMessage(message));
    } catch {
      // The peer went away between the check and the write; its close handler cleans up.
    }
  }

  function sendResult(conn: Connection, id: number, result: HostResult): void {
    send(conn, { id, ok: true, result });
  }

  function sendError(conn: Connection, id: number, error: string): void {
    send(conn, { id, ok: false, error });
  }

  function broadcast(event: HostEvent): void {
    if (closing) {
      return;
    }
    for (const conn of connections) {
      if (conn.authenticated) {
        send(conn, event);
      }
    }
  }

  function broadcastSessions(): void {
    broadcast({ event: 'sessions', sessions: manager.list() });
  }

  /**
   * Attach a subscriber in the one order that cannot lose or duplicate output:
   *
   *   1. install the data/exit/title listeners and buffer any output they see;
   *   2. read the backlog slice (which may already include buffered chunks);
   *   3. send `backlog`;
   *   4. flush only the buffered chunks newer than the slice, so the boundary chunk appears
   *      exactly once;
   *   5. stream subsequent output live.
   */
  function attachSubscription(conn: Connection, session: TerminalSession, fromSeq: number | undefined): void {
    const id = session.meta.id;
    conn.subscriptions.get(id)?.();

    const pending: Array<{ seq: number; data: string }> = [];
    let streaming = false;

    const onData = (data: string, seq: number): void => {
      if (streaming) {
        send(conn, { event: 'output', sessionId: id, seq, data });
      } else {
        pending.push({ seq, data });
      }
    };
    const onExit = (code: number): void => {
      send(conn, { event: 'exit', sessionId: id, code });
    };
    const onTitle = (title: string): void => {
      send(conn, { event: 'title', sessionId: id, title });
    };

    const detachData = session.onData(onData);
    const detachExit = session.onExit(onExit);
    const detachTitle = session.onTitle(onTitle);

    const slice = session.backlog(fromSeq ?? 0);
    send(conn, { event: 'backlog', sessionId: id, fromSeq: slice.fromSeq, seq: slice.seq, data: slice.data });
    for (const item of pending) {
      if (item.seq > slice.seq) {
        send(conn, { event: 'output', sessionId: id, seq: item.seq, data: item.data });
      }
    }
    pending.length = 0;
    streaming = true;

    conn.subscriptions.set(id, () => {
      detachData();
      detachExit();
      detachTitle();
    });
  }

  function watch(session: TerminalSession): void {
    const id = session.meta.id;
    if (known.has(id)) {
      return;
    }
    const detach = session.onExit(() => {
      // Run after the registry's own exit handling, so a session it culls on exit is already
      // gone and reconcile can report `closed`. The per-subscription listener has already
      // pushed `exit` by the time this microtask runs.
      queueMicrotask(() => {
        if (closed) {
          return;
        }
        reconcile();
        broadcastSessions();
      });
    });
    known.set(id, detach);
  }

  /**
   * Bring the host's view in line with the registry. The registry removes sessions silently
   * when it culls an exited one, so after any create/exit/kill we diff and announce `closed`
   * for whatever vanished, detaching every subscriber from it.
   */
  function reconcile(): void {
    const current = new Map(manager.list().map((meta) => [meta.id, meta] as const));
    for (const [id, detach] of known) {
      if (current.has(id)) {
        continue;
      }
      detach();
      known.delete(id);
      for (const conn of connections) {
        const unsubscribe = conn.subscriptions.get(id);
        if (unsubscribe) {
          unsubscribe();
          conn.subscriptions.delete(id);
        }
      }
      broadcast({ event: 'closed', sessionId: id });
    }
    for (const meta of current.values()) {
      if (known.has(meta.id)) {
        continue;
      }
      const session = manager.get(meta.id);
      if (session) {
        watch(session);
      }
    }
    refreshIdle();
  }

  function clearIdle(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function refreshIdle(): void {
    if (closed || idleMs <= 0) {
      return;
    }
    // Any open connection counts, not just authenticated ones: a client that is mid-handshake
    // must not have the daemon retire out from under it (idleMs can be shorter than the auth
    // window). Unauthenticated sockets are destroyed by the auth timeout, so this cannot pin
    // the daemon open indefinitely.
    const hasConnection = connections.size > 0;
    if (hasConnection || manager.list().length > 0) {
      clearIdle();
      return;
    }
    if (idleTimer) {
      return;
    }
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (closed) {
        return;
      }
      if (connections.size > 0 || manager.list().length > 0) {
        refreshIdle();
        return;
      }
      onLog('idle: no connections and no sessions');
      void close().then(() => exit(0));
    }, idleMs);
    // The listening server is what keeps the process alive; the idle timer only observes.
    idleTimer.unref();
  }

  function detachConnection(conn: Connection): void {
    if (conn.authTimer) {
      clearTimeout(conn.authTimer);
      conn.authTimer = null;
    }
    for (const unsubscribe of conn.subscriptions.values()) {
      unsubscribe();
    }
    conn.subscriptions.clear();
  }

  async function close(): Promise<void> {
    if (closed) {
      return;
    }
    closed = true;
    closing = true;
    clearIdle();
    for (const conn of connections) {
      detachConnection(conn);
      conn.socket.destroy();
    }
    connections.clear();
    for (const detach of known.values()) {
      detach();
    }
    known.clear();
    manager.shutdown();
    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // The socket file is already gone; nothing to clean up.
      }
    }
  }

  function handleLine(conn: Connection, line: string): void {
    const request = parseHostRequest(line);
    if (!request) {
      return;
    }
    conn.lastId = request.id;

    if (request.method === 'auth') {
      if (request.token === token && request.version === HOST_PROTOCOL_VERSION) {
        if (!conn.authenticated) {
          conn.authenticated = true;
          if (conn.authTimer) {
            clearTimeout(conn.authTimer);
            conn.authTimer = null;
          }
          sendResult(conn, request.id, { method: 'auth', ok: true });
          // Give the fresh client a metadata snapshot before it has to ask.
          send(conn, { event: 'sessions', sessions: manager.list() });
          refreshIdle();
        } else {
          sendResult(conn, request.id, { method: 'auth', ok: true });
        }
      } else {
        sendError(conn, request.id, 'unauthorized');
        conn.socket.destroy();
      }
      return;
    }

    // Frames before a successful auth are dropped, not answered: the peer may simply be
    // racing its auth frame.
    if (!conn.authenticated) {
      return;
    }

    void dispatch(conn, request).catch((error: unknown) => {
      sendError(conn, request.id, error instanceof Error ? error.message : 'request failed');
    });
  }

  async function dispatch(conn: Connection, request: HostRequest): Promise<void> {
    switch (request.method) {
      case 'ping':
        sendResult(conn, request.id, { method: 'ping', pong: true });
        return;
      case 'list':
        sendResult(conn, request.id, { method: 'list', sessions: manager.list() });
        return;
      case 'create': {
        try {
          const session = await manager.create(request.options);
          watch(session);
          reconcile();
          sendResult(conn, request.id, { method: 'create', session: session.meta });
          broadcast({ event: 'created', meta: session.meta });
          broadcastSessions();
        } catch (error) {
          sendError(conn, request.id, error instanceof Error ? error.message : 'failed to create session');
        }
        return;
      }
      case 'rename': {
        const renamed = manager.rename(request.sessionId, request.title);
        sendResult(conn, request.id, { method: 'rename', renamed });
        if (renamed) {
          broadcastSessions();
        }
        return;
      }
      case 'kill': {
        const killed = manager.kill(request.sessionId);
        if (killed) {
          reconcile();
          broadcastSessions();
        }
        sendResult(conn, request.id, { method: 'kill', killed });
        return;
      }
      case 'backlog': {
        const session = manager.get(request.sessionId);
        if (!session) {
          sendError(conn, request.id, `unknown session ${request.sessionId}`);
          return;
        }
        sendResult(conn, request.id, { method: 'backlog', slice: session.backlog(request.fromSeq) });
        return;
      }
      case 'write': {
        const session = manager.get(request.sessionId);
        if (!session) {
          sendError(conn, request.id, `unknown session ${request.sessionId}`);
          return;
        }
        session.write(request.data);
        sendResult(conn, request.id, { method: 'write', ok: true });
        return;
      }
      case 'resize': {
        const session = manager.get(request.sessionId);
        if (!session) {
          sendError(conn, request.id, `unknown session ${request.sessionId}`);
          return;
        }
        session.resize(request.cols, request.rows);
        sendResult(conn, request.id, { method: 'resize', ok: true });
        return;
      }
      case 'subscribe': {
        const session = manager.get(request.sessionId);
        if (!session) {
          sendError(conn, request.id, `unknown session ${request.sessionId}`);
          return;
        }
        sendResult(conn, request.id, { method: 'subscribe', ok: true });
        attachSubscription(conn, session, request.fromSeq);
        return;
      }
      case 'unsubscribe': {
        const unsubscribe = conn.subscriptions.get(request.sessionId);
        if (unsubscribe) {
          unsubscribe();
          conn.subscriptions.delete(request.sessionId);
        }
        sendResult(conn, request.id, { method: 'unsubscribe', ok: true });
        return;
      }
      case 'stop': {
        sendResult(conn, request.id, { method: 'stop', ok: true });
        // Acknowledge before the process disappears: write an empty chunk and tear down from
        // its callback, which fires once the response ahead of it has reached the kernel.
        let stopped = false;
        const finishStop = (): void => {
          if (stopped) {
            return;
          }
          stopped = true;
          void close().then(() => exit(0));
        };
        conn.socket.write('', finishStop);
        const fallback = setTimeout(finishStop, 250);
        fallback.unref();
        return;
      }
    }
  }

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    const conn: Connection = {
      socket,
      authenticated: false,
      authTimer: null,
      subscriptions: new Map(),
      lastId: 0,
    };
    connections.add(conn);

    const decoder = createLineDecoder((line) => handleLine(conn, line));
    socket.on('data', (chunk) => decoder(String(chunk)));
    socket.on('error', () => {
      // A reset peer is expected; cleanup happens on 'close'.
    });
    socket.on('close', () => {
      detachConnection(conn);
      connections.delete(conn);
      if (!closed) {
        refreshIdle();
      }
    });

    conn.authTimer = setTimeout(() => {
      if (conn.authenticated || conn.socket.destroyed) {
        return;
      }
      sendError(conn, conn.lastId, 'unauthorized');
      conn.socket.destroy();
    }, HOST_AUTH_TIMEOUT_MS);

    refreshIdle();
  });

  await removeStaleSocket(socketPath);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
  // Only the owner may reach a Unix socket; Windows pipe ACLs are not file modes.
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {
      // Best effort: a socket without the tighter mode still works, just less private.
    }
  }
  server.on('error', (error) => {
    onLog(`server error: ${error.message}`);
  });
  onLog(`listening on ${socketPath}`);
  refreshIdle();

  return { socketPath, close };
}

/** A live daemon at `socketPath` would answer; anything else is a leftover file. */
function socketIsLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const finish = (live: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(live);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }
  if (!fs.existsSync(socketPath)) {
    return;
  }
  if (await socketIsLive(socketPath)) {
    return;
  }
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // A racing daemon may have removed it already.
  }
}

/**
 * Bootstrap when `host.ts` is the process entry point. The parent (the server) passes the
 * socket, token, root, and optional ceiling through the environment; the daemon writes only
 * to stderr so it never contaminates a stdio channel.
 */
function bootstrapFromEnv(): void {
  const socketPath = process.env.STRABO_TERMD_SOCKET?.trim();
  const token = process.env.STRABO_TERMD_TOKEN?.trim();
  const root = process.env.STRABO_TERMD_ROOT?.trim();
  const ceiling = process.env.STRABO_TERMD_CEILING?.trim();
  if (!socketPath || !token || !root) {
    process.stderr.write(
      '[strabo-termd] fatal: STRABO_TERMD_SOCKET, STRABO_TERMD_TOKEN and STRABO_TERMD_ROOT are required\n',
    );
    process.exit(1);
  }
  const config: StraboConfig = {
    workspaceRoot: root,
    ...(ceiling ? { scanCeiling: ceiling } : {}),
    serverLog: (message: string, error?: unknown) => {
      process.stderr.write(`[strabo-termd] ${message}\n`);
      if (error) {
        process.stderr.write(`[strabo-termd] ${String(error)}\n`);
      }
    },
  };
  // A short idle window lets a test (or a scripted cleanup) retire the daemon on its own.
  const idleRaw = process.env.STRABO_TERMD_IDLE_MS?.trim();
  const idleMs = idleRaw === undefined ? undefined : Number.parseInt(idleRaw, 10);
  void startTerminalHost({
    socketPath,
    token,
    config,
    ...(idleMs !== undefined && Number.isFinite(idleMs) && idleMs >= 0 ? { idleMs } : {}),
    onLog: (message) => process.stderr.write(`[strabo-termd] ${message}\n`),
  }).catch((error: unknown) => {
    process.stderr.write(`[strabo-termd] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  bootstrapFromEnv();
}
