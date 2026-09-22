import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';

import { WebSocketServer, type WebSocket } from 'ws';

import { isAllowedHostHeader, isSameOriginHeader } from '../api/http.ts';
import type { StraboConfig } from '../types.ts';
import { getOrCreateSession } from './pty.ts';

const TERMINAL_PATH = '/api/strabo/terminal';

interface InputMessage {
  type: 'input';
  data: string;
}

interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

type ClientMessage = InputMessage | ResizeMessage;

function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'string') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) {
    return null;
  }
  const message = parsed as Record<string, unknown>;
  if (message.type === 'input' && typeof message.data === 'string') {
    return { type: 'input', data: message.data };
  }
  if (message.type === 'resize' && typeof message.cols === 'number' && typeof message.rows === 'number') {
    return { type: 'resize', cols: message.cols, rows: message.rows };
  }
  return null;
}

/**
 * Attach the Terminal screen's WebSocket endpoint to an already-listening HTTP server.
 *
 * A WS upgrade bypasses Express middleware entirely — it is handled on the raw
 * `http.Server`'s `'upgrade'` event — so the DNS-rebinding Host guard and an Origin check
 * (browsers don't enforce same-origin on `ws://` the way they do for `fetch`) are
 * re-applied here explicitly, mirroring `isAllowedHost`/`isSameOriginRequest` in
 * `src/api/http.ts`.
 */
export function attachTerminal(httpServer: HttpServer, config: StraboConfig): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(request.url ?? '', 'http://localhost');
    if (url.pathname !== TERMINAL_PATH) {
      return;
    }
    if (!isAllowedHostHeader(request.headers.host, config.host) || !isSameOriginHeader(request.headers.host, request.headers.origin)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    let detach: (() => void) | null = null;

    getOrCreateSession(config)
      .then((session) => {
        if (ws.readyState !== ws.OPEN) {
          return;
        }
        if (session.backlog) {
          ws.send(session.backlog);
        }
        detach = session.onData((data) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(data);
          }
        });
        ws.on('message', (raw) => {
          const message = parseClientMessage(raw.toString());
          if (!message) {
            return;
          }
          if (message.type === 'input') {
            session.write(message.data);
          } else {
            session.resize(message.cols, message.rows);
          }
        });
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : 'failed to start a terminal session';
        if (ws.readyState === ws.OPEN) {
          ws.send(`\r\n\x1b[31mTerminal unavailable: ${reason}\x1b[0m\r\n`);
        }
      });

    ws.on('close', () => {
      detach?.();
    });
  });
}
