/**
 * The IPC contract between a Strabo server and the detached terminal daemon.
 *
 * The daemon (`strabo-termd`) owns the PTYs, so sessions outlive any single server process.
 * A server connects over a local socket — a Unix domain socket, or a named pipe on Windows —
 * and speaks newline-delimited JSON. Every line is exactly one {@link HostMessage}; terminal
 * payloads are JSON strings, so their own newlines arrive escaped and never break framing.
 *
 * Requests are correlated by a client-chosen numeric `id`. The daemon answers each with a
 * {@link HostResponse} and, independently, pushes {@link HostEvent}s: output, title changes,
 * exits, and the session list. The daemon only streams a session's output to connections that
 * have subscribed to it; `sessions`/`created`/`closed` go to every authenticated connection so
 * each client can keep its metadata mirror current.
 *
 * Like `protocol.ts`, this module is transport- and platform-free so both sides share one
 * definition and it is cheap to unit-test.
 */
import type { BacklogSlice, CreateSessionOptions, SessionMeta } from './protocol.ts';

/** Bumped when the message shapes change incompatibly; the daemon refuses a mismatch. */
export const HOST_PROTOCOL_VERSION = 1;

/** A connection must authenticate within this window or the daemon closes it. */
export const HOST_AUTH_TIMEOUT_MS = 5000;

/** Largest accepted single frame, guarding the line buffer against a runaway peer. */
export const HOST_FRAME_LIMIT = 8 * 1024 * 1024;

/** Requests a client sends to the daemon. */
export type HostRequest =
  | { id: number; method: 'auth'; token: string; version: number }
  | { id: number; method: 'ping' }
  | { id: number; method: 'list' }
  | { id: number; method: 'create'; options: CreateSessionOptions }
  | { id: number; method: 'rename'; sessionId: string; title: string }
  | { id: number; method: 'kill'; sessionId: string }
  | { id: number; method: 'backlog'; sessionId: string; fromSeq: number }
  | { id: number; method: 'write'; sessionId: string; data: string }
  | { id: number; method: 'resize'; sessionId: string; cols: number; rows: number }
  | { id: number; method: 'subscribe'; sessionId: string; fromSeq?: number }
  | { id: number; method: 'unsubscribe'; sessionId: string }
  | { id: number; method: 'stop' };

/** The typed payload of a successful {@link HostResponse}. */
export type HostResult =
  | { method: 'auth'; ok: true }
  | { method: 'ping'; pong: true }
  | { method: 'list'; sessions: SessionMeta[] }
  | { method: 'create'; session: SessionMeta }
  | { method: 'rename'; renamed: boolean }
  | { method: 'kill'; killed: boolean }
  | { method: 'backlog'; slice: BacklogSlice }
  | { method: 'write'; ok: true }
  | { method: 'resize'; ok: true }
  | { method: 'subscribe'; ok: true }
  | { method: 'unsubscribe'; ok: true }
  | { method: 'stop'; ok: true };

/** A reply to one request, matched by `id`. */
export type HostResponse =
  | { id: number; ok: true; result: HostResult }
  | { id: number; ok: false; error: string };

/** Unsolicited pushes from the daemon. */
export type HostEvent =
  | { event: 'backlog'; sessionId: string; fromSeq: number; seq: number; data: string }
  | { event: 'output'; sessionId: string; seq: number; data: string }
  | { event: 'title'; sessionId: string; title: string }
  | { event: 'exit'; sessionId: string; code: number }
  | { event: 'created'; meta: SessionMeta }
  | { event: 'closed'; sessionId: string }
  | { event: 'sessions'; sessions: SessionMeta[] };

export type HostMessage = HostResponse | HostEvent;

/** Serialise one message to a single framed line. */
export function encodeHostMessage(message: HostMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** Serialise one request to a single framed line. */
export function encodeHostRequest(request: HostRequest): string {
  return `${JSON.stringify(request)}\n`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
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
    const parsedOrigin: CreateSessionOptions['origin'] = {};
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
 * Parse one frame into a {@link HostRequest}, or null when it is not a request this protocol
 * defines. Lenient in the same way as {@link parseHostMessage}: a malformed or unknown frame
 * is dropped rather than thrown, so one bad line cannot take down the daemon.
 */
export function parseHostRequest(line: string): HostRequest | null {
  const trimmed = line.trim();
  if (trimmed === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const message = asRecord(parsed);
  if (!message) {
    return null;
  }
  const id = asNonNegativeInt(message.id);
  const method = asString(message.method);
  if (id === null || method === null) {
    return null;
  }
  switch (method) {
    case 'auth': {
      const token = asString(message.token);
      const version = asNonNegativeInt(message.version);
      return token !== null && version !== null ? { id, method: 'auth', token, version } : null;
    }
    case 'ping':
      return { id, method: 'ping' };
    case 'list':
      return { id, method: 'list' };
    case 'create':
      return { id, method: 'create', options: parseCreateOptions(message.options) };
    case 'rename': {
      const sessionId = asString(message.sessionId);
      const title = asString(message.title);
      return sessionId !== null && title !== null ? { id, method: 'rename', sessionId, title } : null;
    }
    case 'kill': {
      const sessionId = asString(message.sessionId);
      return sessionId !== null ? { id, method: 'kill', sessionId } : null;
    }
    case 'backlog': {
      const sessionId = asString(message.sessionId);
      const fromSeq = asNonNegativeInt(message.fromSeq);
      return sessionId !== null && fromSeq !== null ? { id, method: 'backlog', sessionId, fromSeq } : null;
    }
    case 'write': {
      const sessionId = asString(message.sessionId);
      const data = asString(message.data);
      return sessionId !== null && data !== null ? { id, method: 'write', sessionId, data } : null;
    }
    case 'resize': {
      const sessionId = asString(message.sessionId);
      const cols = asPositiveInt(message.cols);
      const rows = asPositiveInt(message.rows);
      return sessionId !== null && cols !== null && rows !== null
        ? { id, method: 'resize', sessionId, cols, rows }
        : null;
    }
    case 'subscribe': {
      const sessionId = asString(message.sessionId);
      if (sessionId === null) {
        return null;
      }
      const fromSeq = asNonNegativeInt(message.fromSeq);
      return fromSeq === null ? { id, method: 'subscribe', sessionId } : { id, method: 'subscribe', sessionId, fromSeq };
    }
    case 'unsubscribe': {
      const sessionId = asString(message.sessionId);
      return sessionId !== null ? { id, method: 'unsubscribe', sessionId } : null;
    }
    case 'stop':
      return { id, method: 'stop' };
    default:
      return null;
  }
}

/**
 * Parse one frame into a {@link HostMessage}, or null when it is not one this protocol
 * defines. Both sides drop unknown lines rather than throwing, so a stray frame from a peer
 * running a newer build cannot tear down the connection.
 */
export function parseHostMessage(line: string): HostMessage | null {
  const trimmed = line.trim();
  if (trimmed === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const message = asRecord(parsed);
  if (!message) {
    return null;
  }
  if (typeof message.id === 'number' && typeof message.ok === 'boolean') {
    if (message.ok === true && asRecord(message.result)) {
      return parsed as HostResponse;
    }
    if (message.ok === false && typeof message.error === 'string') {
      return parsed as HostResponse;
    }
    return null;
  }
  if (typeof message.event === 'string') {
    return parsed as HostEvent;
  }
  return null;
}

export function isHostResponse(message: HostMessage): message is HostResponse {
  return 'id' in message && 'ok' in message;
}

export function isHostEvent(message: HostMessage): message is HostEvent {
  return 'event' in message;
}

/**
 * A streaming line splitter. Feed it decoded socket chunks; it calls `onLine` once per
 * complete line and holds a partial trailing line until the next chunk completes it. The
 * buffer is capped at {@link HOST_FRAME_LIMIT}; an over-long line resets the buffer so a
 * corrupt peer cannot grow it without bound.
 */
export function createLineDecoder(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      onLine(line);
      newline = buffer.indexOf('\n');
    }
    if (buffer.length > HOST_FRAME_LIMIT) {
      buffer = '';
    }
  };
}
