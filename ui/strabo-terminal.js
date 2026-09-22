/**
 * The Terminal screen: a real, PTY-backed shell rendered with xterm.js.
 *
 * The `Terminal` instance and its socket are created once and never torn down — switching
 * away to the Graph screen only hides the container (see `strabo.js`'s screen-tab wiring),
 * so scrollback and the live connection both survive a tab switch. The server keeps the
 * shell process alive the same way, so even a dropped socket reconnects into the same
 * session rather than a fresh one.
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const RECONNECT_MIN_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 8000;

export function initTerminalScreen(container) {
  const background = getComputedStyle(document.documentElement).getPropertyValue('--bg-1').trim();
  const term = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    theme: background ? { background } : undefined,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  let socket = null;
  let reconnectDelay = RECONNECT_MIN_DELAY_MS;
  let reconnectTimer = null;
  let closedByPage = false;

  term.onData((data) => {
    sendMessage({ type: 'input', data });
  });

  function sendMessage(message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function sendResize() {
    if (term.cols > 0 && term.rows > 0) {
      sendMessage({ type: 'resize', cols: term.cols, rows: term.rows });
    }
  }

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/api/strabo/terminal`);

    socket.addEventListener('open', () => {
      reconnectDelay = RECONNECT_MIN_DELAY_MS;
      sendResize();
    });

    socket.addEventListener('message', (event) => {
      term.write(event.data);
    });

    socket.addEventListener('close', () => {
      if (closedByPage) {
        return;
      }
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
    });

    socket.addEventListener('error', () => {
      socket.close();
    });
  }

  connect();
  window.addEventListener('beforeunload', () => {
    closedByPage = true;
    clearTimeout(reconnectTimer);
    socket?.close();
  });
  window.addEventListener('resize', () => {
    if (container.offsetParent !== null) {
      fitAddon.fit();
      sendResize();
    }
  });

  return {
    /** Call each time the Terminal screen becomes visible: `fit()` needs a laid-out container. */
    activate() {
      fitAddon.fit();
      sendResize();
      term.focus();
    },
  };
}
