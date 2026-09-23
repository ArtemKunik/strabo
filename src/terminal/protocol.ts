/**
 * The terminal wire protocol and session contracts.
 *
 * One WebSocket carries every session, so this module is the single source of truth for
 * both directions of the conversation and for the shape of a session as the registry
 * exposes it. The server registry implements {@link SessionManager}; the browser's
 * multiplexer speaks the message unions below. Nothing here touches `node-pty`, Express,
 * or the DOM, so it is safe to import from anywhere and cheap to unit-test.
 */

/** What a session is for; drives title, lifecycle, and how the UI presents it. */
export type SessionKind = 'shell' | 'agent' | 'task' | 'watch';

export type SessionStatus = 'running' | 'exited';

/** Where a session came from on the map: the node, commit, or review that spawned it. */
export interface SessionOrigin {
  node?: string;
  commit?: string;
  review?: string;
}

/** The public face of a session, sent to the client and rendered as a tab. */
export interface SessionMeta {
  id: string;
  title: string;
  kind: SessionKind;
  /** Absolute working directory the shell/command was spawned in. */
  cwd: string;
  /** Repository root the session belongs to, for provenance. */
  repo: string;
  origin?: SessionOrigin;
  /** OS process id, or null before the PTY reports one. */
  pid: number | null;
  cols: number;
  rows: number;
  createdAt: string;
  lastActivity: string;
  status: SessionStatus;
  exitCode: number | null;
  /** Highest output sequence number produced so far; a client resumes from this. */
  seq: number;
}

/** Options accepted when creating a session; every field is optional. */
export interface CreateSessionOptions {
  kind?: SessionKind;
  /** Repository name, registered checkout, or allowed path; resolved through the ceiling. */
  repo?: string;
  /** Absolute or repo-relative working directory; defaults to the resolved repo root. */
  cwd?: string;
  title?: string;
  /** Id of a server-derived preset to run instead of an interactive shell. */
  preset?: string;
  /** Explicit argv for an `agent`/`task` session; validated by the registry. */
  argv?: string[];
  origin?: SessionOrigin;
  /** Extra environment for the child, merged over `process.env`. */
  env?: Record<string, string>;
}

/** A slice of replayed output: `data` covers `(fromSeq, seq]`. */
export interface BacklogSlice {
  fromSeq: number;
  seq: number;
  data: string;
}

/** One live PTY, as the WebSocket layer sees it. */
export interface TerminalSession {
  readonly meta: SessionMeta;
  /** Subscribe to output. Returns an unsubscribe function. */
  onData(callback: (data: string, seq: number) => void): () => void;
  onExit(callback: (code: number) => void): () => void;
  /** Subscribe to OSC title changes (shell-set tab names). */
  onTitle(callback: (title: string) => void): () => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Replay everything newer than `fromSeq`; `fromSeq: 0` returns the whole backlog. */
  backlog(fromSeq: number): BacklogSlice;
  kill(): void;
}

/** The process-wide session registry. */
export interface SessionManager {
  list(): SessionMeta[];
  create(options: CreateSessionOptions): Promise<TerminalSession>;
  get(id: string): TerminalSession | undefined;
  rename(id: string, title: string): boolean;
  kill(id: string): boolean;
  /** Kill every session; called on server shutdown. */
  shutdown(): void;
}

/** Messages the browser sends. */
export type ClientMessage =
  | { type: 'hello' }
  | { type: 'list' }
  | { type: 'create'; options: CreateSessionOptions }
  | { type: 'attach'; id: string; fromSeq?: number }
  | { type: 'detach'; id: string }
  | { type: 'input'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'rename'; id: string; title: string }
  | { type: 'kill'; id: string };

/** Messages the server sends. */
export type ServerMessage =
  | { type: 'sessions'; sessions: SessionMeta[] }
  | { type: 'created'; session: SessionMeta }
  | { type: 'closed'; id: string; code: number }
  | { type: 'output'; id: string; seq: number; data: string }
  | { type: 'backlog'; id: string; fromSeq: number; seq: number; data: string }
  | { type: 'title'; id: string; title: string }
  | { type: 'error'; message: string; id?: string };

/** Hard caps enforced by the registry, exported so tests and docs share one number. */
export const TERMINAL_LIMITS = {
  /** Concurrent sessions the registry will hold. */
  maxSessions: 24,
  /** Per-session replay buffer, in characters. */
  backlogChars: 64 * 1024,
  /** Total replay bytes across all sessions before idle exited ones are culled. */
  totalBacklogChars: 2 * 1024 * 1024,
  /** Longest accepted title, in characters. */
  maxTitleChars: 120,
  /** Longest accepted single input frame, in characters. */
  maxInputChars: 1024 * 1024,
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function parseCreateOptions(raw: unknown): CreateSessionOptions {
  const record = asRecord(raw) ?? {};
  const options: CreateSessionOptions = {};
  const kind = record.kind;
  if (kind === 'shell' || kind === 'agent' || kind === 'task' || kind === 'watch') {
    options.kind = kind;
  }
  for (const key of ['repo', 'cwd', 'title', 'preset'] as const) {
    const value = asString(record[key]);
    if (value !== null) {
      options[key] = value;
    }
  }
  if (Array.isArray(record.argv) && record.argv.every((entry) => typeof entry === 'string')) {
    options.argv = record.argv as string[];
  }
  const origin = asRecord(record.origin);
  if (origin) {
    const parsedOrigin: SessionOrigin = {};
    for (const key of ['node', 'commit', 'review'] as const) {
      const value = asString(origin[key]);
      if (value !== null) {
        parsedOrigin[key] = value;
      }
    }
    if (Object.keys(parsedOrigin).length > 0) {
      options.origin = parsedOrigin;
    }
  }
  return options;
}

/**
 * Parse one raw WebSocket frame into a {@link ClientMessage}, or null when it is not a
 * well-formed message this server accepts. Unknown types and malformed payloads are
 * dropped rather than throwing, so one bad frame never tears down the socket.
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'string') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const message = asRecord(parsed);
  if (!message) {
    return null;
  }
  switch (message.type) {
    case 'hello':
      return { type: 'hello' };
    case 'list':
      return { type: 'list' };
    case 'create':
      return { type: 'create', options: parseCreateOptions(message.options) };
    case 'attach': {
      const id = asString(message.id);
      if (id === null) {
        return null;
      }
      const fromSeq =
        typeof message.fromSeq === 'number' && Number.isInteger(message.fromSeq) && message.fromSeq >= 0
          ? message.fromSeq
          : undefined;
      return fromSeq === undefined ? { type: 'attach', id } : { type: 'attach', id, fromSeq };
    }
    case 'detach': {
      const id = asString(message.id);
      return id === null ? null : { type: 'detach', id };
    }
    case 'input': {
      const id = asString(message.id);
      const data = asString(message.data);
      if (id === null || data === null || data.length > TERMINAL_LIMITS.maxInputChars) {
        return null;
      }
      return { type: 'input', id, data };
    }
    case 'resize': {
      const id = asString(message.id);
      const cols = asPositiveInt(message.cols);
      const rows = asPositiveInt(message.rows);
      if (id === null || cols === null || rows === null) {
        return null;
      }
      return { type: 'resize', id, cols, rows };
    }
    case 'rename': {
      const id = asString(message.id);
      const title = asString(message.title);
      return id === null || title === null ? null : { type: 'rename', id, title };
    }
    case 'kill': {
      const id = asString(message.id);
      return id === null ? null : { type: 'kill', id };
    }
    default:
      return null;
  }
}

/** Serialise a server message to the frame sent over the socket. */
export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}
