import os from 'node:os';

import type { StraboConfig } from '../types.ts';

/** Minimal surface of `node-pty`'s spawned process this module uses. */
interface PtyProcess {
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** A single persistent terminal session: one PTY, shared by every connected socket. */
export interface TerminalSession {
  onData(callback: (data: string) => void): () => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Recent output, replayed to a socket that just (re)connected. */
  readonly backlog: string;
}

const BACKLOG_LIMIT = 64 * 1024;

let session: TerminalSession | null = null;
let sessionError: string | null = null;

function defaultShell(): { file: string; args: string[] } {
  if (os.platform() === 'win32') {
    return { file: 'powershell.exe', args: [] };
  }
  return { file: process.env.SHELL || '/bin/bash', args: [] };
}

/**
 * Returns the process-wide terminal session, spawning it on first use.
 *
 * `node-pty` is required lazily so a missing/broken native build only breaks the Terminal
 * screen — surfaced here as a thrown error the WebSocket layer can report to the client —
 * rather than crashing the whole server at import time.
 */
export async function getOrCreateSession(config: StraboConfig): Promise<TerminalSession> {
  if (session) {
    return session;
  }
  if (sessionError) {
    throw new Error(sessionError);
  }
  try {
    const pty = await import('node-pty');
    const shell = defaultShell();
    const proc: PtyProcess = pty.spawn(shell.file, shell.args, {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: config.workspaceRoot,
      env: process.env as Record<string, string>,
    });

    const listeners = new Set<(data: string) => void>();
    let backlog = '';

    proc.onData((data) => {
      backlog = (backlog + data).slice(-BACKLOG_LIMIT);
      for (const listener of listeners) {
        listener(data);
      }
    });
    proc.onExit(() => {
      session = null;
    });

    session = {
      get backlog() {
        return backlog;
      },
      onData(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      write(data) {
        proc.write(data);
      },
      resize(cols, rows) {
        if (cols > 0 && rows > 0) {
          proc.resize(cols, rows);
        }
      },
    };
    return session;
  } catch (error) {
    sessionError = error instanceof Error ? error.message : 'failed to start a terminal session';
    throw new Error(sessionError);
  }
}
