import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';

/**
 * Injection points so a test can observe the relaunch without spawning a real process.
 * Every field defaults to the running process's own values.
 */
export interface RestartDeps {
  spawn: typeof spawn;
  exit: (code: number) => void;
  execPath: string;
  argv: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Relaunch the standalone server and exit the current process.
 *
 * The listening socket is closed and its open connections (keep-alive and the terminal
 * WebSocket) are dropped before the replacement is spawned, so the child can bind the same
 * port; the child is detached and unref'd so it outlives this process. Only the standalone
 * CLI wires this up — an embedded host owns its own process and leaves `config.restart`
 * unset, so the Settings route reports `restartAvailable: false` and refuses.
 */
export function createRestart(server: Server, deps: Partial<RestartDeps> = {}): () => void {
  const spawnProcess = deps.spawn ?? spawn;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const execPath = deps.execPath ?? process.execPath;
  const argv = deps.argv ?? process.argv.slice(1);
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;

  // `closeAllConnections` only reaches sockets the HTTP parser still owns; a socket upgraded
  // to a WebSocket (the Terminal screen's) is detached from it, so it stayed open, the close
  // callback never ran, and the process sat alive with no listener and no replacement. Every
  // raw socket is tracked from its `connection` event so the relaunch can drop them all.
  const sockets = new Set<Socket>();
  server.on?.('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  return () => {
    server.close(() => {
      const child = spawnProcess(execPath, [...argv], {
        cwd,
        env,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      exit(0);
    });
    // Drop keep-alive and WebSocket connections so the close callback is not held open.
    server.closeAllConnections?.();
    for (const socket of sockets) {
      socket.destroy();
    }
  };
}
