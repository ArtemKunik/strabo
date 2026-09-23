import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';

import { WebSocketServer, type WebSocket } from 'ws';

import { isAllowedHostHeader, isSameOriginHeader } from '../api/http.ts';
import type { StraboConfig } from '../types.ts';
import type { ClientMessage, ServerMessage, TerminalSession } from './protocol.ts';
import { encodeServerMessage, parseClientMessage } from './protocol.ts';
import { getSessionManager } from './registry.ts';

const TERMINAL_PATH = '/api/strabo/terminal';

interface Connection {
  /** id -> data unsubscribe, for sessions this socket is streaming. */
  readonly attached: Map<string, () => void>;
  /** id -> exit/title unsubscribe, for every session this socket should hear about. */
  readonly tracked: Map<string, () => void>;
}

/**
 * Attach the Terminal screen's multiplexed WebSocket endpoint to a listening HTTP server.
 *
 * A WS upgrade bypasses Express middleware — it is handled on the raw `http.Server`'s
 * `'upgrade'` event — so the DNS-rebinding Host guard and an Origin check (browsers don't
 * enforce same-origin on `ws://`) are re-applied here, mirroring `src/api/http.ts`.
 */
export function attachTerminal(httpServer: HttpServer, config: StraboConfig): void {
  const manager = getSessionManager(config);
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Map<WebSocket, Connection>();

  httpServer.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(request.url ?? '', 'http://localhost');
    if (url.pathname !== TERMINAL_PATH) {
      return;
    }
    if (
      !isAllowedHostHeader(request.headers.host, config.host) ||
      !isSameOriginHeader(request.headers.host, request.headers.origin)
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  function send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(encodeServerMessage(message));
    }
  }

  function sendError(ws: WebSocket, error: unknown, id?: string): void {
    const message = error instanceof Error ? error.message : 'terminal request failed';
    send(ws, id === undefined ? { type: 'error', message } : { type: 'error', message, id });
  }

  function track(ws: WebSocket, connection: Connection, session: TerminalSession): void {
    const id = session.meta.id;
    if (connection.tracked.has(id)) {
      return;
    }
    const unsubscribeExit = session.onExit((code) => {
      connection.tracked.get(id)?.();
      connection.tracked.delete(id);
      connection.attached.get(id)?.();
      connection.attached.delete(id);
      send(ws, { type: 'closed', id, code });
      send(ws, { type: 'sessions', sessions: manager.list() });
    });
    const unsubscribeTitle = session.onTitle((title) => {
      send(ws, { type: 'title', id, title });
    });
    connection.tracked.set(id, () => {
      unsubscribeExit();
      unsubscribeTitle();
    });
  }

  function broadcastSessions(): void {
    const sessions = manager.list();
    for (const [ws, connection] of connections) {
      for (const meta of sessions) {
        const session = manager.get(meta.id);
        if (session) {
          track(ws, connection, session);
        }
      }
      send(ws, { type: 'sessions', sessions });
    }
  }

  async function handle(ws: WebSocket, connection: Connection, message: ClientMessage): Promise<void> {
    switch (message.type) {
      case 'hello':
      case 'list': {
        for (const meta of manager.list()) {
          const session = manager.get(meta.id);
          if (session) {
            track(ws, connection, session);
          }
        }
        send(ws, { type: 'sessions', sessions: manager.list() });
        return;
      }
      case 'create': {
        try {
          const session = await manager.create(message.options);
          track(ws, connection, session);
          send(ws, { type: 'created', session: session.meta });
          broadcastSessions();
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'failed to start a terminal session';
          if (ws.readyState === ws.OPEN) {
            ws.send(`\r\n\x1b[31mTerminal unavailable: ${reason}\x1b[0m\r\n`);
            sendError(ws, error);
          }
        }
        return;
      }
      case 'attach': {
        const session = manager.get(message.id);
        if (!session) {
          sendError(ws, new Error(`unknown session ${message.id}`), message.id);
          return;
        }
        connection.attached.get(message.id)?.();
        // Resume from the client's cursor so a reconnect never re-sends what it already drew.
        const slice = session.backlog(message.fromSeq ?? 0);
        send(ws, {
          type: 'backlog',
          id: message.id,
          fromSeq: slice.fromSeq,
          seq: slice.seq,
          data: slice.data,
        });
        const unsubscribe = session.onData((data, seq) => {
          send(ws, { type: 'output', id: message.id, seq, data });
        });
        connection.attached.set(message.id, unsubscribe);
        track(ws, connection, session);
        return;
      }
      case 'detach': {
        connection.attached.get(message.id)?.();
        connection.attached.delete(message.id);
        return;
      }
      case 'input': {
        manager.get(message.id)?.write(message.data);
        return;
      }
      case 'resize': {
        manager.get(message.id)?.resize(message.cols, message.rows);
        return;
      }
      case 'rename': {
        if (!manager.rename(message.id, message.title)) {
          sendError(ws, new Error(`unknown session ${message.id}`), message.id);
          return;
        }
        const title = manager.get(message.id)?.meta.title ?? message.title;
        send(ws, { type: 'title', id: message.id, title });
        broadcastSessions();
        return;
      }
      case 'kill': {
        const session = manager.get(message.id);
        if (!session) {
          sendError(ws, new Error(`unknown session ${message.id}`), message.id);
          return;
        }
        const code = session.meta.exitCode ?? 0;
        // Untrack first so this socket does not also receive the exit-driven `closed`.
        connection.tracked.get(message.id)?.();
        connection.tracked.delete(message.id);
        connection.attached.get(message.id)?.();
        connection.attached.delete(message.id);
        manager.kill(message.id);
        send(ws, { type: 'closed', id: message.id, code });
        broadcastSessions();
        return;
      }
    }
  }

  wss.on('connection', (ws: WebSocket) => {
    const connection: Connection = { attached: new Map(), tracked: new Map() };
    connections.set(ws, connection);

    ws.on('message', (raw) => {
      const message = parseClientMessage(raw.toString());
      if (!message) {
        return;
      }
      void handle(ws, connection, message).catch((error: unknown) => {
        sendError(ws, error);
      });
    });

    ws.on('close', () => {
      for (const unsubscribe of connection.attached.values()) {
        unsubscribe();
      }
      for (const unsubscribe of connection.tracked.values()) {
        unsubscribe();
      }
      connection.attached.clear();
      connection.tracked.clear();
      connections.delete(ws);
    });
  });
}
