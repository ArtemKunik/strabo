/**
 * The browser's multiplexer for the terminal WebSocket.
 *
 * One socket at `/api/strabo/terminal` carries every session, mirroring the unions in
 * `src/terminal/protocol.ts`. The transport concerns — reconnect with exponential backoff and
 * sequence-aware replay — are isolated from the DOM so they can be unit-tested, and the
 * module only ever speaks JSON to the server.
 *
 * Sequence handling is the subtle part: each session has a highest-seen `seq`, advanced only
 * by output the client actually wrote. On attach (and on reconnect, which re-attaches) the
 * client asks the server to replay from that seq and writes only the delta, so a reconnect
 * never duplicates scrollback.
 */

export const RECONNECT_MIN_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 8000;

/** The next backoff delay: double the last one, capped. A missing/zero delay is the floor. */
export function nextReconnectDelay(previous, { min = RECONNECT_MIN_DELAY_MS, max = RECONNECT_MAX_DELAY_MS } = {}) {
  if (!Number.isFinite(previous) || previous <= 0) {
    return min;
  }
  return Math.min(previous * 2, max);
}

/** True when an output frame advances a session's cursor and should be written. */
export function acceptOutput(lastSeq, seq) {
  return Number.isFinite(seq) && seq > (Number.isFinite(lastSeq) ? lastSeq : 0);
}

/**
 * The part of a backlog slice the client has not drawn yet.
 *
 * A slice covers `(fromSeq, seq]`. When the server honours the requested cursor,
 * `fromSeq === lastSeq` and the whole slice is new (`reset: false`). When `seq` is not past
 * `lastSeq` there is nothing to draw. A slice that starts before the cursor cannot be split
 * by sequence — the data has no per-character seq — so the caller must reset the terminal and
 * replay the whole slice (`reset: true`) rather than either duplicating output or losing the
 * frames produced while disconnected. The current server always replays from zero, so this
 * branch is the normal reconnect path.
 */
export function backlogDelta(lastSeq, slice) {
  if (!slice || typeof slice.data !== 'string') {
    return null;
  }
  const from = Number.isFinite(slice.fromSeq) ? slice.fromSeq : 0;
  const to = Number.isFinite(slice.seq) ? slice.seq : 0;
  const cursor = Number.isFinite(lastSeq) ? lastSeq : 0;
  if (to <= cursor) {
    return null;
  }
  return { data: slice.data, seq: to, reset: from < cursor };
}

function asRecord(value) {
  return typeof value === 'object' && value !== null ? value : null;
}

function asString(value) {
  return typeof value === 'string' ? value : null;
}

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Parse one server frame into a normalised message, or null when it is not one we handle. */
export function parseServerMessage(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  let parsed;
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
    case 'sessions':
      return Array.isArray(message.sessions) ? { type: 'sessions', sessions: message.sessions } : null;
    case 'created': {
      const session = asRecord(message.session);
      return session ? { type: 'created', session } : null;
    }
    case 'closed': {
      const id = asString(message.id);
      const code = asNumber(message.code);
      return id === null || code === null ? null : { type: 'closed', id, code };
    }
    case 'output': {
      const id = asString(message.id);
      const seq = asNumber(message.seq);
      const data = asString(message.data);
      return id === null || seq === null || data === null ? null : { type: 'output', id, seq, data };
    }
    case 'backlog': {
      const id = asString(message.id);
      const fromSeq = asNumber(message.fromSeq);
      const seq = asNumber(message.seq);
      const data = asString(message.data);
      return id === null || fromSeq === null || seq === null || data === null
        ? null
        : { type: 'backlog', id, fromSeq, seq, data };
    }
    case 'title': {
      const id = asString(message.id);
      const title = asString(message.title);
      return id === null || title === null ? null : { type: 'title', id, title };
    }
    case 'error':
      return typeof message.message === 'string'
        ? { type: 'error', message: message.message, id: asString(message.id) ?? undefined }
        : null;
    default:
      return null;
  }
}

/** Serialise a client message to the frame sent over the socket. */
export function encodeClientMessage(message) {
  return JSON.stringify(message);
}

function defaultUrl() {
  const protocol = globalThis.location?.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = globalThis.location?.host ?? 'localhost';
  return `${protocol}//${host}/api/strabo/terminal`;
}

/**
 * Create the multiplexer. `onEvent` receives every emitted event (see the module docs); the
 * returned API is the one the terminal screen drives. `socketFactory` is injectable so a test
 * can supply a fake socket without a network.
 */
export function createTerminalMultiplexer({ url, onEvent, socketFactory } = {}) {
  const listeners = new Set();
  if (typeof onEvent === 'function') {
    listeners.add(onEvent);
  }
  const makeSocket = socketFactory ?? ((target) => new WebSocket(target));
  const endpoint = url ?? defaultUrl();

  /** Highest output seq the client has written, per session. */
  const lastSeq = new Map();
  const metas = new Map();
  const attached = new Set();
  const pendingCreates = [];

  let socket = null;
  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_MIN_DELAY_MS;
  let disposed = false;

  function emit(event) {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A subscriber throwing must not tear down the socket or the other subscribers.
      }
    }
  }

  function send(message) {
    if (socket && socket.readyState === 1) {
      socket.send(encodeClientMessage(message));
    }
  }

  function attachFrame(id) {
    const cursor = lastSeq.get(id) ?? 0;
    // `fromSeq` is an additive field on the frozen `attach` shape: the server replays from it
    // and a server that ignores it still cannot make us duplicate, thanks to `backlogDelta`.
    send({ type: 'attach', id, fromSeq: cursor });
  }

  function resolveCreate(session) {
    const resolve = pendingCreates.shift();
    resolve?.(session);
  }

  function handleMessage(raw) {
    const message = parseServerMessage(raw);
    if (!message) {
      return;
    }
    switch (message.type) {
      case 'sessions': {
        const ids = new Set();
        for (const session of message.sessions) {
          if (session && typeof session.id === 'string') {
            metas.set(session.id, session);
            ids.add(session.id);
          }
        }
        for (const id of [...metas.keys()]) {
          if (!ids.has(id)) {
            metas.delete(id);
          }
        }
        emit({ type: 'sessions', sessions: [...metas.values()] });
        return;
      }
      case 'created':
        metas.set(message.session.id, message.session);
        emit({ type: 'created', session: message.session });
        resolveCreate(message.session);
        return;
      case 'closed': {
        const meta = metas.get(message.id);
        if (meta) {
          metas.set(message.id, { ...meta, status: 'exited', exitCode: message.code });
        }
        emit({ type: 'closed', id: message.id, code: message.code });
        return;
      }
      case 'output': {
        if (acceptOutput(lastSeq.get(message.id) ?? 0, message.seq)) {
          lastSeq.set(message.id, message.seq);
          emit({ type: 'output', id: message.id, data: message.data });
        }
        return;
      }
      case 'backlog': {
        const delta = backlogDelta(lastSeq.get(message.id) ?? 0, message);
        if (delta) {
          lastSeq.set(message.id, delta.seq);
          emit({ type: 'output', id: message.id, data: delta.data, replay: true, reset: delta.reset });
        }
        return;
      }
      case 'title': {
        const meta = metas.get(message.id);
        if (meta) {
          metas.set(message.id, { ...meta, title: message.title });
        }
        emit({ type: 'title', id: message.id, title: message.title });
        return;
      }
      case 'error':
        emit({ type: 'error', message: message.message, id: message.id });
        return;
      default:
        return;
    }
  }

  function scheduleReconnect() {
    if (disposed) {
      return;
    }
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = nextReconnectDelay(reconnectDelay);
  }

  function connect() {
    if (disposed) {
      return;
    }
    socket = makeSocket(endpoint);
    socket.addEventListener('open', () => {
      if (disposed) {
        return;
      }
      reconnectDelay = RECONNECT_MIN_DELAY_MS;
      emit({ type: 'open' });
      send({ type: 'hello' });
      send({ type: 'list' });
      for (const id of attached) {
        attachFrame(id);
      }
    });
    socket.addEventListener('message', (event) => handleMessage(event.data));
    socket.addEventListener('close', () => {
      socket = null;
      emit({ type: 'close' });
      if (!disposed) {
        scheduleReconnect();
      }
    });
    socket.addEventListener('error', () => {
      socket?.close();
    });
  }

  connect();

  return {
    attach(id) {
      if (typeof id !== 'string' || id === '') {
        return;
      }
      attached.add(id);
      attachFrame(id);
    },
    detach(id) {
      attached.delete(id);
      send({ type: 'detach', id });
    },
    sendInput(id, data) {
      if (typeof data === 'string' && data !== '') {
        send({ type: 'input', id, data });
      }
    },
    resize(id, cols, rows) {
      if (cols > 0 && rows > 0) {
        send({ type: 'resize', id, cols, rows });
      }
    },
    create(options = {}) {
      return new Promise((resolve) => {
        pendingCreates.push(resolve);
        send({ type: 'create', options });
        // A create that is never answered must not hang the caller forever.
        setTimeout(() => {
          const index = pendingCreates.indexOf(resolve);
          if (index !== -1) {
            pendingCreates.splice(index, 1);
            resolve(null);
          }
        }, 15000);
      });
    },
    rename(id, title) {
      send({ type: 'rename', id, title });
    },
    kill(id) {
      attached.delete(id);
      send({ type: 'kill', id });
    },
    list() {
      send({ type: 'list' });
    },
    /** The last known metas, keyed by id. */
    getMeta(id) {
      return metas.get(id) ?? null;
    },
    snapshot() {
      return [...metas.values()];
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      for (const resolve of pendingCreates.splice(0)) {
        resolve(null);
      }
      listeners.clear();
      try {
        socket?.close();
      } catch {
        // A socket already closing is fine.
      }
      socket = null;
    },
  };
}
