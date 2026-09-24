/**
 * Where the detached terminal daemon lives, and how a server starts one.
 *
 * The daemon owns the PTYs so terminal sessions survive a server restart. Its endpoint is
 * derived deterministically from the workspace root, so every server process for the same
 * repository finds the same daemon and the same shared token. Starting one is deliberately
 * idempotent: a server only spawns a daemon when nothing is already listening, which keeps a
 * restart from stranding live sessions in an orphaned process.
 *
 * Everything that touches the outside world (the clock, the socket, the child process) is
 * injectable so the bootstrap can be unit-tested without a real daemon.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { StraboConfig } from '../types.ts';

/** How long a liveness probe waits before giving up on the socket. */
const PROBE_TIMEOUT_MS = 300;

/** How long the initial spawn waits for the daemon to accept connections. */
const DEFAULT_START_TIMEOUT_MS = 4000;

/** The per-workspace location of the daemon socket and its shared token. */
export interface DaemonEndpoint {
  socketPath: string;
  tokenFile: string;
}

/** The directory that holds every daemon's socket and token, in the OS temp area. */
function endpointDir(): string {
  return path.join(os.tmpdir(), 'strabo-termd');
}

/**
 * Derive the daemon endpoint for one workspace. The key is a short hash of the resolved
 * root so the socket path stays within the platform's length limits. On Windows the
 * filesystem is case-insensitive, so the path is lower-cased before hashing to keep
 * `D:\Repo` and `d:\repo` pointing at the same daemon.
 */
export function daemonEndpoint(workspaceRoot: string): DaemonEndpoint {
  const resolved = path.resolve(workspaceRoot);
  const normalised = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const key = createHash('sha1').update(normalised).digest('hex').slice(0, 12);
  const dir = endpointDir();
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\strabo-termd-${key}`
      : path.join(dir, `termd-${key}.sock`);
  return {
    socketPath,
    tokenFile: path.join(dir, `termd-${key}.token`),
  };
}

/**
 * The compiled `host` module that sits next to this one. A daemon is spawned as a separate
 * Node process, so the entry must match how this module is running: `host.ts` from source,
 * `host.js` from `dist`. Only the extension is swapped, so a `.mts`/`.mjs` build still works.
 */
export function hostEntryPath(): string {
  const self = fileURLToPath(import.meta.url);
  return path.join(path.dirname(self), `host${path.extname(self)}`);
}

/** Read the shared token, or null when it is absent or unreadable. */
export function readDaemonToken(endpoint: DaemonEndpoint): string | null {
  try {
    const token = fs.readFileSync(endpoint.tokenFile, 'utf8').trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Persist the shared token for a workspace. The file is created `0o600` on POSIX so only the
 * owning user can authenticate to the daemon; Windows ignores the mode, which is acceptable
 * because the named pipe is already scoped to the current user's session.
 */
export function writeDaemonToken(endpoint: DaemonEndpoint, token: string): void {
  fs.mkdirSync(path.dirname(endpoint.tokenFile), { recursive: true });
  fs.writeFileSync(endpoint.tokenFile, token, { encoding: 'utf8', mode: 0o600 });
  // `mode` only applies when the file is created; tighten an existing file too, so a token
  // left by an older run or a different umask is never world-readable.
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(endpoint.tokenFile, 0o600);
    } catch {
      // Best-effort: a filesystem without POSIX modes is not a failure.
    }
  }
}

/**
 * Probe the socket for a live daemon. A refused connection or a missing socket both mean
 * "not listening"; so does a timeout, which covers a peer that accepts but never speaks.
 */
export function isDaemonListening(endpoint: DaemonEndpoint, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect(endpoint.socketPath);
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

export interface EnsureDaemonOptions {
  spawn?: typeof import('node:child_process').spawn;
  execPath?: string;
  hostEntry?: string;
  timeoutMs?: number;
  onLog?: (message: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Make sure a daemon is listening for this workspace, spawning one if needed.
 *
 * The token is generated once and reused, so a daemon that is already running still accepts
 * the caller. The child is detached with ignored stdio and unref'd, so it outlives the
 * server that started it. Startup is confirmed by polling the socket with a short backoff
 * rather than trusting the child's own exit code, because the daemon may be replacing a
 * stale listener.
 */
export async function ensureDaemon(
  config: StraboConfig,
  endpoint: DaemonEndpoint,
  options: EnsureDaemonOptions = {},
): Promise<void> {
  if (await isDaemonListening(endpoint)) {
    return;
  }

  const token = readDaemonToken(endpoint) ?? randomBytes(32).toString('hex');
  writeDaemonToken(endpoint, token);

  const spawnFn = options.spawn ?? nodeSpawn;
  const execPath = options.execPath ?? process.execPath;
  const hostEntry = options.hostEntry ?? hostEntryPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;

  options.onLog?.(`starting terminal daemon on ${endpoint.socketPath}`);
  const child = spawnFn(execPath, [hostEntry], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      STRABO_TERMD_SOCKET: endpoint.socketPath,
      STRABO_TERMD_TOKEN: token,
      STRABO_TERMD_ROOT: config.workspaceRoot,
      STRABO_TERMD_CEILING: config.scanCeiling ?? config.workspaceRoot,
    },
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  let backoff = 50;
  while (Date.now() < deadline) {
    await sleep(backoff);
    if (await isDaemonListening(endpoint)) {
      options.onLog?.('terminal daemon is listening');
      return;
    }
    backoff = Math.min(Math.round(backoff * 1.5), 500);
  }

  if (await isDaemonListening(endpoint)) {
    return;
  }
  throw new Error(
    `terminal daemon did not start within ${timeoutMs}ms (socket: ${endpoint.socketPath})`,
  );
}
