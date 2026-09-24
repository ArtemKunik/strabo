/**
 * A remote terminal daemon presented as a local {@link SessionManager}.
 *
 * The browser talks to one server over a WebSocket and expects a synchronous registry, but
 * the PTYs may live in a detached daemon. This proxy bridges the two: it keeps a local mirror
 * of every session's metadata and a bounded replay ring of its output, fed by the daemon's
 * pushed events, so `list`, `get`, and `backlog` answer without a round trip. Mutating calls
 * (`create`) await the daemon; `write`, `resize`, `kill`, and `rename` are fire-and-forget.
 *
 * The connection is established in the background. If the daemon cannot be reached and a
 * `fallback` manager is supplied, the proxy permanently degrades to it — the graceful path
 * for an embedded host or a broken native build. A dropped connection reconnects with
 * exponential backoff; re-subscribing each session replays whatever was produced while the
 * server was away. `shutdown` only drops this client's socket, never the daemon or its
 * sessions, so restarting a server preserves the terminals.
 */
import net from 'node:net';

import type { StraboConfig } from '../types.ts';
import type {
  BacklogSlice,
  CreateSessionOptions,
  SessionManager,
  SessionMeta,
  TerminalSession,
} from './protocol.ts';
import { TERMINAL_LIMITS } from './protocol.ts';
import {
  HOST_PROTOCOL_VERSION,
  createLineDecoder,
  encodeHostRequest,
  isHostEvent,
  isHostResponse,
  parseHostMessage,
  type HostEvent,
  type HostRequest,
  type HostResult,
} from './host-protocol.ts';
import { daemonEndpoint, ensureDaemon, readDaemonToken, type DaemonEndpoint } from './daemon.ts';

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

/** Reconnect backoff bounds: half a second doubling to an eight-second ceiling. */
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 8000;

/** The delay before the `attempt`-th reconnect; attempt 0 is the first retry. */
export function reconnectDelay(attempt: number): number {
  if (attempt <= 0) {
    return RECONNECT_BASE_MS;
  }
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
}

/**
 * One contiguous span of output. `data` covers the sequence range `(fromSeq, seq]`. A live
 * chunk advances by one, so its `fromSeq` is `seq - 1`; a host backlog event may span many
 * sequences and carries the daemon's own boundary.
 */
export interface OutputChunk {
  fromSeq: number;
  seq: number;
  data: string;
}

/** A bounded replay buffer; `seq` is the highest sequence number observed. */
export interface OutputRing {
  chunks: OutputChunk[];
  chars: number;
  seq: number;
}

export function createOutputRing(): OutputRing {
  return { chunks: [], chars: 0, seq: 0 };
}

/**
 * Append a chunk, ignoring anything at or below the highest sequence already seen. That
 * makes replay idempotent across a reconnect: a replayed span that overlaps what we hold is
 * dropped rather than duplicated.
 */
export function appendOutputChunk(ring: OutputRing, chunk: OutputChunk): void {
  if (chunk.seq <= ring.seq) {
    return;
  }
  if (chunk.data.length > 0) {
    ring.chunks.push(chunk);
    ring.chars += chunk.data.length;
    trimOutputRing(ring);
  }
  ring.seq = chunk.seq;
}

/** Drop the oldest output once the ring exceeds the per-session replay cap. */
function trimOutputRing(ring: OutputRing): void {
  while (ring.chars > TERMINAL_LIMITS.backlogChars && ring.chunks.length > 1) {
    const removed = ring.chunks.shift();
    if (removed) {
      ring.chars -= removed.data.length;
    }
  }
  const first = ring.chunks[0];
  if (first && ring.chars > TERMINAL_LIMITS.backlogChars) {
    const excess = ring.chars - TERMINAL_LIMITS.backlogChars;
    first.data = first.data.slice(excess);
    ring.chars -= excess;
  }
}

/** Replay everything newer than `fromSeq`, mirroring the daemon's own slice shape. */
export function sliceOutputRing(ring: OutputRing, fromSeq: number): BacklogSlice {
  const held = ring.chunks.filter((chunk) => chunk.seq > fromSeq);
  const data = held.map((chunk) => chunk.data).join('');
  const start = held[0] ? held[0].fromSeq : ring.seq;
  return { fromSeq: start, seq: ring.seq, data };
}

/** How a session proxy reaches the connection for fire-and-forget requests. */
interface SessionTransport {
  fireRequest(build: (id: number) => HostRequest): void;
  subscribeSession(sessionId: string, fromSeq: number): void;
}

class HostSessionProxy implements TerminalSession {
  readonly meta: SessionMeta;
  private readonly transport: SessionTransport;
  private readonly ring = createOutputRing();
  private readonly dataListeners = new Set<(data: string, seq: number) => void>();
  private readonly exitListeners = new Set<(code: number) => void>();
  private readonly titleListeners = new Set<(title: string) => void>();
  private closed = false;

  constructor(meta: SessionMeta, transport: SessionTransport) {
    this.meta = meta;
    this.transport = transport;
  }

  onData(callback: (data: string, seq: number) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (code: number) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  onTitle(callback: (title: string) => void): () => void {
    this.titleListeners.add(callback);
    return () => {
      this.titleListeners.delete(callback);
    };
  }

  write(data: string): void {
    this.transport.fireRequest((id) => ({ id, method: 'write', sessionId: this.meta.id, data }));
  }

  resize(cols: number, rows: number): void {
    this.transport.fireRequest((id) => ({ id, method: 'resize', sessionId: this.meta.id, cols, rows }));
  }

  backlog(fromSeq: number): BacklogSlice {
    return sliceOutputRing(this.ring, fromSeq);
  }

  kill(): void {
    if (this.closed) {
      return;
    }
    this.transport.fireRequest((id) => ({ id, method: 'kill', sessionId: this.meta.id }));
  }

  /** The highest sequence this proxy holds, so a (re)subscribe asks only for what is new. */
  get sessionSeq(): number {
    return this.ring.seq;
  }

  /** Copy refreshed metadata onto the shared object, preserving its identity for callers. */
  applyMeta(meta: SessionMeta): void {
    Object.assign(this.meta, meta);
  }

  ingestBacklog(fromSeq: number, seq: number, data: string): void {
    const previousSeq = this.ring.seq;
    appendOutputChunk(this.ring, { fromSeq, seq, data });
    // A backlog replayed after a reconnect is output produced while this client was away. A
    // live listener (the browser's WebSocket) must receive it too, not just the replay ring,
    // or the terminal silently loses everything that happened during the outage. Initial
    // priming runs with no listeners attached, so this is a no-op there.
    if (data.length > 0 && seq > previousSeq && this.dataListeners.size > 0) {
      for (const listener of [...this.dataListeners]) {
        listener(data, seq);
      }
    }
  }

  ingestOutput(seq: number, data: string): void {
    appendOutputChunk(this.ring, { fromSeq: seq - 1, seq, data });
    for (const listener of [...this.dataListeners]) {
      listener(data, seq);
    }
  }

  emitExit(code: number): void {
    this.closed = true;
    for (const listener of [...this.exitListeners]) {
      listener(code);
    }
  }

  emitTitle(title: string): void {
    for (const listener of [...this.titleListeners]) {
      listener(title);
    }
  }

  /** Detach every listener on shutdown; the remote session itself is left untouched. */
  clear(): void {
    this.closed = true;
    this.dataListeners.clear();
    this.exitListeners.clear();
    this.titleListeners.clear();
  }
}

export interface HostClientOptions {
  endpoint?: DaemonEndpoint;
  fallback?: () => SessionManager;
  spawn?: typeof import('node:child_process').spawn;
  execPath?: string;
  hostEntry?: string;
  connectTimeoutMs?: number;
  onLog?: (message: string) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class HostClient implements SessionManager, SessionTransport {
  private readonly config: StraboConfig;
  private readonly options: HostClientOptions;
  private readonly endpoint: DaemonEndpoint;
  private readonly sessions = new Map<string, HostSessionProxy>();
  private readonly pending = new Map<number, { resolve: (result: HostResult) => void; reject: (error: Error) => void }>();
  private decoder = createLineDecoder((line) => this.onLine(line));
  private readonly ready: Promise<void>;
  private resolveReady: () => void = () => {};
  private rejectReady: (error: Error) => void = () => {};
  private readySettled = false;
  private socket: net.Socket | null = null;
  private connected = false;
  private disposed = false;
  private localMode = false;
  private local: SessionManager | null = null;
  private nextId = 1;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;

  constructor(config: StraboConfig, options: HostClientOptions) {
    this.config = config;
    this.options = options;
    this.endpoint = options.endpoint ?? daemonEndpoint(config.workspaceRoot);
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Nothing may await `ready` until `create` is called; keep an unobserved rejection from
    // crashing the process while still surfacing the error to the first `create` caller.
    void this.ready.catch(() => {});
    void this.bootstrap();
  }

  list(): SessionMeta[] {
    if (this.local) {
      return this.local.list();
    }
    return [...this.sessions.values()].map((proxy) => proxy.meta);
  }

  get(id: string): TerminalSession | undefined {
    if (this.local) {
      return this.local.get(id);
    }
    return this.sessions.get(id);
  }

  async create(options: CreateSessionOptions): Promise<TerminalSession> {
    await this.ready;
    if (this.local) {
      return this.local.create(options);
    }
    const result = await this.request((id) => ({ id, method: 'create', options }));
    if (result.method !== 'create') {
      throw new Error('terminal daemon returned an unexpected create response');
    }
    const proxy = this.upsert(result.session);
    // The daemon also broadcasts `created`, but subscribing here is what seeds the replay ring.
    this.subscribeSession(proxy.meta.id, proxy.sessionSeq);
    return proxy;
  }

  rename(id: string, title: string): boolean {
    if (this.local) {
      return this.local.rename(id, title);
    }
    const proxy = this.sessions.get(id);
    if (!proxy) {
      return false;
    }
    proxy.meta.title = title.trim().slice(0, TERMINAL_LIMITS.maxTitleChars);
    proxy.meta.lastActivity = new Date().toISOString();
    this.fireRequest((rid) => ({ id: rid, method: 'rename', sessionId: id, title }));
    return true;
  }

  kill(id: string): boolean {
    if (this.local) {
      return this.local.kill(id);
    }
    const proxy = this.sessions.get(id);
    if (!proxy) {
      return false;
    }
    proxy.kill();
    this.sessions.delete(id);
    return true;
  }

  /**
   * Disconnect this client only. The daemon and its PTYs keep running, which is the whole
   * point of the detached host: a server restart must not kill the operator's terminals.
   */
  shutdown(): void {
    if (this.local) {
      this.local.shutdown();
      return;
    }
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const proxy of this.sessions.values()) {
      proxy.clear();
    }
    this.sessions.clear();
    this.failPending(new Error('terminal host client shut down'));
    this.closeSocket();
  }

  fireRequest(build: (id: number) => HostRequest): void {
    this.request(build).catch((error) => {
      this.options.onLog?.(`terminal host request failed: ${messageOf(error)}`);
    });
  }

  subscribeSession(sessionId: string, fromSeq: number): void {
    this.fireRequest((id) => ({ id, method: 'subscribe', sessionId, fromSeq }));
  }

  private async bootstrap(): Promise<void> {
    try {
      await this.connectOnce();
      this.settleReady(null);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (this.options.fallback && !this.disposed) {
        this.options.onLog?.(`terminal host unavailable, using local sessions: ${failure.message}`);
        this.enterLocalMode();
        this.settleReady(null);
      } else {
        this.settleReady(failure);
      }
    }
  }

  private enterLocalMode(): void {
    this.localMode = true;
    this.local = this.options.fallback?.() ?? null;
    this.closeSocket();
  }

  private settleReady(error: Error | null): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    if (error) {
      this.rejectReady(error);
    } else {
      this.resolveReady();
    }
  }

  private async connectOnce(): Promise<void> {
    const timeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    await ensureDaemon(this.config, this.endpoint, {
      ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
      ...(this.options.execPath ? { execPath: this.options.execPath } : {}),
      ...(this.options.hostEntry ? { hostEntry: this.options.hostEntry } : {}),
      timeoutMs,
      ...(this.options.onLog ? { onLog: this.options.onLog } : {}),
    });
    // A shutdown can land while the daemon is still starting; do not establish a socket
    // for a client that has already been disposed.
    if (this.disposed) {
      throw new Error('terminal host client shut down');
    }

    const token = readDaemonToken(this.endpoint);
    if (!token) {
      throw new Error(`terminal daemon token missing at ${this.endpoint.tokenFile}`);
    }

    const socket = await this.openSocket(timeoutMs);
    if (this.disposed) {
      socket.destroy();
      throw new Error('terminal host client shut down');
    }
    this.socket = socket;
    this.connected = true;
    this.reconnectAttempt = 0;
    // A dropped connection can leave a half-decoded frame in the shared decoder. Start each
    // connection clean so a stale partial line cannot swallow the new handshake.
    this.decoder = createLineDecoder((line) => this.onLine(line));
    socket.on('data', (chunk: Buffer | string) => {
      this.decoder(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    socket.on('close', () => this.onSocketClose());
    socket.on('error', (error) => {
      this.options.onLog?.(`terminal host socket error: ${error.message}`);
    });

    const auth = await this.request((id) => ({
      id,
      method: 'auth',
      token,
      version: HOST_PROTOCOL_VERSION,
    })).catch((error: unknown) => {
      // A failed handshake must not leave a half-open socket behind.
      this.closeSocket();
      throw error;
    });
    if (!(auth.method === 'auth' && auth.ok)) {
      this.closeSocket();
      throw new Error('terminal daemon rejected authentication');
    }
    try {
      await this.refreshSessions();
    } catch (error) {
      this.closeSocket();
      throw error;
    }
  }

  private openSocket(timeoutMs: number): Promise<net.Socket> {
    return new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect(this.endpoint.socketPath);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        reject(new Error(`timed out connecting to terminal daemon at ${this.endpoint.socketPath}`));
      }, timeoutMs);
      socket.once('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      });
      socket.once('connect', () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(socket);
      });
    });
  }

  private async refreshSessions(): Promise<void> {
    const result = await this.request((id) => ({ id, method: 'list' }));
    if (result.method !== 'list') {
      throw new Error('terminal daemon returned an unexpected list response');
    }
    const seen = new Set<string>();
    for (const meta of result.sessions) {
      seen.add(meta.id);
      this.upsert(meta);
    }
    for (const id of [...this.sessions.keys()]) {
      if (!seen.has(id)) {
        this.sessions.delete(id);
      }
    }
    await Promise.all(
      [...this.sessions.values()].map((proxy) =>
        this.request((id) => ({ id, method: 'subscribe', sessionId: proxy.meta.id, fromSeq: proxy.sessionSeq }))
          .then(() => undefined)
          .catch((error: unknown) => {
            this.options.onLog?.(`terminal host subscribe failed: ${messageOf(error)}`);
          }),
      ),
    );
  }

  private request(build: (id: number) => HostRequest): Promise<HostResult> {
    const socket = this.socket;
    if (!socket || !this.connected) {
      return Promise.reject(new Error('terminal host is not connected'));
    }
    const id = this.nextId;
    this.nextId += 1;
    const message = build(id);
    return new Promise<HostResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        socket.write(encodeHostRequest(message));
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private onLine(line: string): void {
    const message = parseHostMessage(line);
    if (!message) {
      return;
    }
    if (isHostResponse(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error));
      }
      return;
    }
    if (isHostEvent(message)) {
      this.onEvent(message);
    }
  }

  private onEvent(event: HostEvent): void {
    switch (event.event) {
      case 'sessions': {
        const seen = new Set<string>();
        for (const meta of event.sessions) {
          seen.add(meta.id);
          this.upsert(meta);
        }
        for (const id of [...this.sessions.keys()]) {
          if (!seen.has(id)) {
            this.sessions.delete(id);
          }
        }
        break;
      }
      case 'created':
        this.upsert(event.meta);
        break;
      case 'closed':
        this.sessions.delete(event.sessionId);
        break;
      case 'backlog':
        this.sessions.get(event.sessionId)?.ingestBacklog(event.fromSeq, event.seq, event.data);
        break;
      case 'output':
        this.sessions.get(event.sessionId)?.ingestOutput(event.seq, event.data);
        break;
      case 'title': {
        const proxy = this.sessions.get(event.sessionId);
        if (proxy) {
          proxy.meta.title = event.title;
          proxy.emitTitle(event.title);
        }
        break;
      }
      case 'exit': {
        const proxy = this.sessions.get(event.sessionId);
        if (proxy) {
          proxy.meta.status = 'exited';
          proxy.meta.exitCode = event.code;
          proxy.emitExit(event.code);
        }
        break;
      }
      default:
        break;
    }
  }

  private upsert(meta: SessionMeta): HostSessionProxy {
    const existing = this.sessions.get(meta.id);
    if (existing) {
      existing.applyMeta(meta);
      return existing;
    }
    const proxy = new HostSessionProxy(meta, this);
    this.sessions.set(meta.id, proxy);
    return proxy;
  }

  private onSocketClose(): void {
    this.connected = false;
    this.socket = null;
    this.failPending(new Error('terminal host connection closed'));
    if (this.disposed || this.localMode) {
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    const delay = reconnectDelay(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.options.onLog?.(`terminal host disconnected; reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.disposed || this.localMode) {
      return;
    }
    try {
      await this.connectOnce();
      this.options.onLog?.('terminal host reconnected');
    } catch {
      this.connected = false;
      this.socket = null;
      this.scheduleReconnect();
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    if (socket) {
      // Drop the close listener first: a deliberate close must not schedule a reconnect.
      socket.removeAllListeners();
      socket.destroy();
    }
  }
}

/** Build a synchronous proxy over the workspace's daemon; it connects in the background. */
export function createHostSessionManager(config: StraboConfig, options: HostClientOptions = {}): SessionManager {
  return new HostClient(config, options);
}
