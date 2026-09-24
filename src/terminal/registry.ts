import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { isInside, resolveRepositoryRoot, StraboScopeError } from '../boundary/repository-root.ts';
import type { StraboConfig } from '../types.ts';
import { createHostSessionManager } from './host-client.ts';
import type {
  CreateSessionOptions,
  SessionManager,
  SessionMeta,
  TerminalSession,
} from './protocol.ts';
import { TERMINAL_LIMITS } from './protocol.ts';
import { listPresets, type TerminalPreset } from './presets.ts';
import { createPtySession, type PtySpawner } from './session.ts';
import { withTerminalShimPath } from './shim.ts';

export interface SessionManagerOptions {
  /** Injected PTY factory for tests; the default lazily imports `node-pty`. */
  spawn?: PtySpawner;
}

class Registry implements SessionManager {
  private readonly config: StraboConfig;
  private readonly spawner: PtySpawner | undefined;
  private readonly scanCeiling: string;
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(config: StraboConfig, spawner?: PtySpawner) {
    this.config = config;
    this.spawner = spawner;
    this.scanCeiling = config.scanCeiling ?? config.workspaceRoot;
  }

  list(): SessionMeta[] {
    return [...this.sessions.values()].map((session) => session.meta);
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  async create(options: CreateSessionOptions): Promise<TerminalSession> {
    if (this.sessions.size >= TERMINAL_LIMITS.maxSessions) {
      throw new Error(`terminal session limit of ${TERMINAL_LIMITS.maxSessions} reached`);
    }
    const resolved = resolveRepositoryRoot({
      workspaceRoot: this.config.workspaceRoot,
      scanCeiling: this.scanCeiling,
      requested: options.repo,
    });
    // An id the repo no longer derives is treated as absent: a shell is the safe fallback.
    const preset = options.preset
      ? listPresets(resolved.root).find((entry) => entry.id === options.preset)
      : undefined;
    const kind = options.kind ?? preset?.kind ?? 'shell';
    const cwd = this.resolveCwd(resolved.root, options.cwd ?? preset?.cwd);
    const requestedArgv = options.argv && options.argv.length > 0 ? options.argv : preset?.argv;
    const argv = kind === 'shell' ? undefined : requestedArgv;
    const id = randomUUID();
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id,
      title: resolveTitle(options, preset, argv, cwd),
      kind,
      cwd,
      repo: resolved.root,
      pid: null,
      cols: 80,
      rows: 24,
      createdAt: now,
      lastActivity: now,
      status: 'running',
      exitCode: null,
      seq: 0,
    };
    if (options.origin) {
      meta.origin = options.origin;
    }
    const session = await createPtySession({
      meta,
      argv,
      env: buildEnv(id, resolved.root, options.env),
      spawner: this.spawner,
      onExit: () => this.cull(),
    });
    this.sessions.set(id, session);
    this.cull();
    return session;
  }

  rename(id: string, title: string): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    session.meta.title = title.trim().slice(0, TERMINAL_LIMITS.maxTitleChars);
    session.meta.lastActivity = new Date().toISOString();
    return true;
  }

  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    session.kill();
    this.sessions.delete(id);
    return true;
  }

  shutdown(): void {
    for (const session of this.sessions.values()) {
      session.kill();
    }
    this.sessions.clear();
  }

  private resolveCwd(root: string, requested: string | undefined): string {
    if (!requested) {
      return root;
    }
    const candidate = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(root, requested);
    if (!isInside(candidate, this.scanCeiling)) {
      throw new StraboScopeError(`Working directory "${requested}" is outside the configured scan ceiling.`);
    }
    return candidate;
  }

  private cull(): void {
    if (this.totalBacklogChars() <= TERMINAL_LIMITS.totalBacklogChars) {
      return;
    }
    const exited = [...this.sessions.values()]
      .filter((session) => session.meta.status === 'exited')
      .sort((a, b) => Date.parse(a.meta.lastActivity) - Date.parse(b.meta.lastActivity));
    for (const session of exited) {
      if (this.totalBacklogChars() <= TERMINAL_LIMITS.totalBacklogChars) {
        return;
      }
      session.kill();
      this.sessions.delete(session.meta.id);
    }
  }

  private totalBacklogChars(): number {
    let total = 0;
    for (const session of this.sessions.values()) {
      total += session.backlog(0).data.length;
    }
    return total;
  }
}

function resolveTitle(
  options: CreateSessionOptions,
  preset: TerminalPreset | undefined,
  argv: string[] | undefined,
  cwd: string,
): string {
  const explicit = options.title?.trim();
  const candidate = explicit || preset?.label || options.preset || argv?.[0] || path.basename(cwd);
  return candidate.slice(0, TERMINAL_LIMITS.maxTitleChars);
}

function buildEnv(id: string, repo: string, extra: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  if (extra) {
    Object.assign(env, extra);
  }
  env.STRABO_SESSION_ID = id;
  env.STRABO_REPO = repo;
  // Put the `strabo` control shim on PATH so a session can drive the map from the shell.
  withTerminalShimPath(env);
  return env;
}

let manager: SessionManager | null = null;

/**
 * The process-wide session registry; the first caller's config wins.
 *
 * With `terminalDaemon` on, this is a synchronous proxy to the detached daemon instead.
 * Its `shutdown()` only disconnects the proxy — the sessions stay alive in the daemon —
 * which is exactly what lets them survive a server restart. The proxy falls back to the
 * in-process registry when the daemon cannot start.
 */
export function getSessionManager(config: StraboConfig): SessionManager {
  if (!manager) {
    manager = config.terminalDaemon
      ? createHostSessionManager(config, {
          fallback: () => createSessionManager(config),
          onLog: (message: string) => config.serverLog?.(message),
        })
      : createSessionManager(config);
    process.once('exit', () => manager?.shutdown());
  }
  return manager;
}

export function resetSessionManagerForTests(): void {
  manager?.shutdown();
  manager = null;
}

/** Build a registry. Tests pass an injected `spawn`; production uses `getSessionManager`. */
export function createSessionManager(config: StraboConfig, options: SessionManagerOptions = {}): SessionManager {
  return new Registry(config, options.spawn);
}
