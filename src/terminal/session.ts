import { resolveExecutable } from './executable.ts';
import type { BacklogSlice, SessionMeta, TerminalSession } from './protocol.ts';
import { TERMINAL_LIMITS } from './protocol.ts';

/** Minimal surface of a spawned PTY this module drives; structurally matches `node-pty`'s `IPty`. */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void } | void;
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void } | void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtySpawnOptions {
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

/**
 * Spawns one PTY. Tests inject a fake so the registry runs without a native build; the
 * default resolves `node-pty` lazily, keeping a broken native module from breaking import.
 */
export type PtySpawner = (
  file: string,
  args: string[],
  options: PtySpawnOptions,
) => PtyProcess | Promise<PtyProcess>;

async function defaultSpawner(file: string, args: string[], options: PtySpawnOptions): Promise<PtyProcess> {
  // `node-pty` is an optional dependency: an install that could not build it still maps and
  // reviews, and only the Terminal screen says why it cannot start a shell.
  const pty = await import('node-pty').catch(() => {
    throw new Error('The in-app terminal needs the optional native module node-pty, which is not installed.');
  });
  // ConPTY does not search PATH; resolve the command first so a bare `opencode`, `claude`,
  // or `npm` launches the same way it would from a shell.
  return pty.spawn(resolveExecutable(file, options.env), args, {
    name: 'xterm-color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
  });
}

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: [] };
  }
  return { file: process.env.SHELL || '/bin/bash', args: [] };
}

function resolveCommand(meta: SessionMeta, argv: string[] | undefined): { file: string; args: string[] } {
  const first = argv?.[0];
  if (meta.kind !== 'shell' && first) {
    return { file: first, args: argv?.slice(1) ?? [] };
  }
  return defaultShell();
}

const OSC_TAIL_LIMIT = 8 * 1024;

/**
 * Pull OSC 0/2 titles out of a chunk, holding back any trailing sequence that may be
 * completed by the next chunk. Titles are not stripped from the data: xterm consumes them.
 */
function scanTitles(text: string): { titles: string[]; tail: string } {
  const titles: string[] = [];
  const pattern = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let lastEnd = 0;
  let match = pattern.exec(text);
  while (match) {
    titles.push(match[1] ?? '');
    lastEnd = pattern.lastIndex;
    match = pattern.exec(text);
  }
  const remainder = text.slice(lastEnd);
  const oscStart = remainder.lastIndexOf('\x1b]');
  const keepFrom = oscStart !== -1 ? oscStart : remainder.endsWith('\x1b') ? remainder.length - 1 : -1;
  const tail = keepFrom === -1 ? '' : remainder.slice(keepFrom);
  return { titles, tail: tail.length > OSC_TAIL_LIMIT ? '' : tail };
}

/**
 * Console titles that name a shell rather than a task. A tab gains nothing from "Windows
 * PowerShell" or "cmd.exe", so these are dropped and the session keeps its assigned name.
 */
const SHELL_TITLE_NOISE = new Set([
  'windows powershell',
  'command prompt',
  'powershell',
  'pwsh',
  'cmd',
  'cmd.exe',
  'bash',
  'zsh',
  'sh',
  'fish',
  'nu',
  '-bash',
  '-zsh',
  '-sh',
  'node',
  'python',
  'python3',
]);

function isPathLikeTitle(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\') || /^\/(?:[^/]|$)/.test(value);
}

/**
 * Turn an OSC 0/2 title into a tab-worthy name, or null when it is noise.
 *
 * Shells and the Windows console routinely set the title to a full executable or directory
 * path — `C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`, or the current
 * directory — or to a bare shell name. Showing either as a tab is worse than showing the
 * session's own name, so a path-like or shell-name title is rejected and the caller keeps the
 * assigned title. Anything else is kept, whitespace-collapsed and capped.
 */
export function normalizeOscTitle(raw: string): string | null {
  const collapsed = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return null;
  }
  const withoutPrefix = collapsed.replace(/^administrator:\s*/i, '').trim();
  const candidate = withoutPrefix || collapsed;
  if (isPathLikeTitle(candidate)) {
    return null;
  }
  if (SHELL_TITLE_NOISE.has(candidate.toLowerCase())) {
    return null;
  }
  if (!candidate.includes(' ') && /\.(exe|com|bat|cmd|ps1)$/i.test(candidate)) {
    return null;
  }
  return candidate.slice(0, 80);
}

export interface CreatePtySessionParams {
  meta: SessionMeta;
  argv?: string[];
  env: Record<string, string>;
  spawner?: PtySpawner;
  /** Called once when the process exits, so the registry can cull and broadcast. */
  onExit?: (session: TerminalSession) => void;
}

class PtySession implements TerminalSession {
  readonly meta: SessionMeta;
  private readonly pty: PtyProcess;
  private readonly registryExit: ((session: TerminalSession) => void) | undefined;
  private readonly dataListeners = new Set<(data: string, seq: number) => void>();
  private readonly exitListeners = new Set<(code: number) => void>();
  private readonly titleListeners = new Set<(title: string) => void>();
  private readonly chunks: Array<{ seq: number; data: string }> = [];
  private backlogChars = 0;
  private seq = 0;
  private oscTail = '';
  private exited = false;
  private killed = false;

  constructor(meta: SessionMeta, pty: PtyProcess, registryExit?: (session: TerminalSession) => void) {
    this.meta = meta;
    this.pty = pty;
    this.registryExit = registryExit;
    this.meta.pid = pty.pid;
    pty.onData((data) => this.ingest(data));
    pty.onExit((event) => this.finish(event.exitCode));
  }

  onData(callback: (data: string, seq: number) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (code: number) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  onTitle(callback: (title: string) => void): () => void {
    this.titleListeners.add(callback);
    return () => {
      this.titleListeners.delete(callback);
    };
  }

  write(data: string): void {
    if (this.exited) {
      return;
    }
    this.meta.lastActivity = new Date().toISOString();
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0 && !this.exited) {
      this.pty.resize(cols, rows);
    }
  }

  backlog(fromSeq: number): BacklogSlice {
    const held = this.chunks.filter((chunk) => chunk.seq > fromSeq);
    const data = held.map((chunk) => chunk.data).join('');
    const start = held[0] ? held[0].seq - 1 : this.seq;
    return { fromSeq: start, seq: this.seq, data };
  }

  kill(): void {
    if (this.killed || this.exited) {
      return;
    }
    this.killed = true;
    this.pty.kill();
  }

  private ingest(data: string): void {
    if (this.exited) {
      return;
    }
    this.seq += 1;
    const seq = this.seq;
    this.chunks.push({ seq, data });
    this.backlogChars += data.length;
    this.trimBacklog();
    const { titles, tail } = scanTitles(this.oscTail + data);
    this.oscTail = tail;
    this.meta.seq = seq;
    this.meta.lastActivity = new Date().toISOString();
    for (const title of titles) {
      const clean = normalizeOscTitle(title);
      if (!clean) {
        continue;
      }
      // Update the shared meta too, so `list()`/`sessions` broadcasts carry the same clean
      // title the `title` event announced instead of reverting the tab to its default.
      this.meta.title = clean;
      for (const listener of [...this.titleListeners]) {
        listener(clean);
      }
    }
    for (const listener of [...this.dataListeners]) {
      listener(data, seq);
    }
  }

  private trimBacklog(): void {
    while (this.backlogChars > TERMINAL_LIMITS.backlogChars && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      if (removed) {
        this.backlogChars -= removed.data.length;
      }
    }
    const first = this.chunks[0];
    if (first && this.backlogChars > TERMINAL_LIMITS.backlogChars) {
      const excess = this.backlogChars - TERMINAL_LIMITS.backlogChars;
      first.data = first.data.slice(excess);
      this.backlogChars -= excess;
    }
  }

  private finish(code: number): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.meta.status = 'exited';
    this.meta.exitCode = code;
    this.meta.lastActivity = new Date().toISOString();
    for (const listener of [...this.exitListeners]) {
      listener(code);
    }
    this.registryExit?.(this);
  }
}

/** Spawn one PTY-backed session and return it once the process exists. */
export async function createPtySession(params: CreatePtySessionParams): Promise<TerminalSession> {
  const command = resolveCommand(params.meta, params.argv);
  const spawner = params.spawner ?? defaultSpawner;
  const pty = await spawner(command.file, command.args, {
    cwd: params.meta.cwd,
    cols: params.meta.cols,
    rows: params.meta.rows,
    env: params.env,
  });
  return new PtySession(params.meta, pty, params.onExit);
}
