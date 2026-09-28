import fs from 'node:fs';
import path from 'node:path';

import { run } from '../process.ts';
import { resolveExecutable } from '../terminal/executable.ts';

/**
 * Detect the repository's own coverage command and, on request, run it so a measured report
 * exists for {@link computeMeasuredCoverage} to read.
 *
 * Nothing here runs automatically. `detectCoverageCommand` only reads `package.json` and the
 * lockfiles beside it and names the conventional script; the caller decides whether to run it.
 * A run is bounded by a timeout and a buffer cap, and its output is truncated, so a runaway
 * suite cannot hold a request open or exhaust memory.
 */

export type CoverageRunner = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** A coverage script declared in `package.json`, with the package manager that runs it. */
export interface CoverageCommand {
  runner: CoverageRunner;
  /** The `scripts` key, e.g. `test:coverage`. */
  script: string;
  /** The command line a surface can show, e.g. `npm run test:coverage`. */
  command: string;
}

/** The detected command, plus whether the server will run it when a caller asks. */
export interface CoverageRefreshHint extends CoverageCommand {
  allowed: boolean;
}

export type CoverageRefreshReason =
  | 'no-manifest'
  | 'no-script'
  | 'spawn-failed'
  | 'timed-out'
  | 'failed';

/** The outcome of a refresh attempt; `ok` is true only after a clean exit. */
export interface CoverageRefreshResult {
  ok: boolean;
  /** The command line that was attempted, or that would have been, empty when none exists. */
  command: string;
  /** The `package.json` script name when one was detected, else null. */
  script: string | null;
  /** The process exit code when it ran, else null. */
  exitCode: number | null;
  /** Why it did not run cleanly, absent on success. */
  reason?: CoverageRefreshReason;
  /** A one-line explanation, absent on success. */
  detail?: string;
  /** The tail of the command's combined output, bounded. */
  output: string;
}

/** Coverage script names to try, most specific first. */
export const COVERAGE_SCRIPT_NAMES: readonly string[] = [
  'test:coverage',
  'test:cov',
  'coverage',
  'cov',
  'test:coverage:ci',
  'test:coverage:unit',
];

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const OUTPUT_TAIL_CHARS = 4000;

/** The options a run accepts; a subset of `execFile`'s, plus an injected executor for tests. */
export interface CoverageExecOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

export type CoverageExec = (
  file: string,
  args: readonly string[],
  options?: CoverageExecOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface CoverageRefreshOptions {
  /** Wall-clock cap on the run. Defaults to fifteen minutes. */
  timeoutMs?: number;
  /** Cap on captured output before the child is killed. Defaults to 64 MiB. */
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Invoke the package manager through the Windows command interpreter. Required on Windows,
   * where `npm`/`pnpm`/`yarn`/`bun` are `.cmd` shims `execFile` cannot launch directly
   * (`EINVAL`). Defaults to true on Windows and false elsewhere. The interpreter string
   * carries only our fixed runner and script names, never caller input.
   */
  shell?: boolean;
  /** Injected executor; defaults to the bounded `run` helper. */
  exec?: CoverageExec;
  /** Injected executable resolver; defaults to `PATH`/`PATHEXT` lookup. */
  resolveExecutable?: (file: string, env?: Record<string, string | undefined>) => string;
  /** Skip the cache when re-detecting after a manifest change. */
  fresh?: boolean;
}

interface Manifest {
  scripts: Record<string, string>;
  packageManager: string | null;
}

interface DetectedCacheEntry {
  stamp: number | null;
  command: CoverageCommand | null;
}

const detectionCache = new Map<string, DetectedCacheEntry>();

/** Drop the detection cache; tests call this so one case cannot read another's manifest. */
export function clearCoverageCommandCache(): void {
  detectionCache.clear();
}

/**
 * The conventional coverage command for `root`, or null when `package.json` declares none.
 *
 * A manifest is read from the repository root only. The script is the first of
 * {@link COVERAGE_SCRIPT_NAMES} the manifest declares; the runner comes from the
 * `packageManager` field when present, else the lockfile beside the manifest.
 */
export function detectCoverageCommand(root: string, options: CoverageRefreshOptions = {}): CoverageCommand | null {
  const manifestPath = path.join(root, 'package.json');
  const stamp = modifiedAt(manifestPath);
  if (!options.fresh) {
    const cached = detectionCache.get(root);
    if (cached && cached.stamp === stamp) {
      return cached.command;
    }
  }
  const manifest = readManifest(manifestPath);
  const command = manifest ? commandFromManifest(root, manifest) : null;
  detectionCache.set(root, { stamp, command });
  return command;
}

/** Detect the command and run it; `no-script` when the manifest declares no coverage script. */
export async function refreshCoverage(
  root: string,
  options: CoverageRefreshOptions = {},
): Promise<CoverageRefreshResult> {
  const command = detectCoverageCommand(root, options);
  if (!command) {
    const hasManifest = modifiedAt(path.join(root, 'package.json')) !== null;
    return {
      ok: false,
      command: '',
      script: null,
      exitCode: null,
      reason: hasManifest ? 'no-script' : 'no-manifest',
      detail: hasManifest
        ? `package.json declares no coverage script (looked for ${COVERAGE_SCRIPT_NAMES.join(', ')})`
        : 'no package.json at the repository root',
      output: '',
    };
  }
  return runCoverageScript(root, command, options);
}

/** Run a detected coverage command in `root`, bounded by the timeout and output cap. */
export async function runCoverageScript(
  root: string,
  command: CoverageCommand,
  options: CoverageRefreshOptions = {},
): Promise<CoverageRefreshResult> {
  const env = options.env ?? process.env;
  const viaShell = options.shell ?? process.platform === 'win32';
  const resolve = options.resolveExecutable ?? resolveExecutable;
  const exec: CoverageExec = options.exec ?? ((file, args, execOptions) => run(file, args, execOptions));
  const execOptions = {
    cwd: root,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    env,
  };
  const exitCodeBase = { command: command.command, script: command.script };
  // `cmd.exe` resolves the `.cmd` shim from PATH; POSIX runs the manager directly. Either way
  // the argument is only a fixed runner name, so nothing here interpolates caller input.
  const invocation: { file: string; args: string[] } = viaShell
    ? { file: commandInterpreter(env), args: ['/d', '/s', '/c', `${command.runner} run ${command.script}`] }
    : { file: resolve(command.runner, env), args: ['run', command.script] };

  try {
    const result = await exec(invocation.file, invocation.args, execOptions);
    return {
      ok: true,
      ...exitCodeBase,
      exitCode: 0,
      output: tail(`${result.stdout}${result.stderr}`),
    };
  } catch (error) {
    const failure = error as {
      code?: number | string | null;
      killed?: boolean;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const output = tail(`${failure.stdout ?? ''}${failure.stderr ?? ''}`);
    if (failure.killed === true || failure.signal) {
      return {
        ok: false,
        ...exitCodeBase,
        exitCode: typeof failure.code === 'number' ? failure.code : null,
        reason: 'timed-out',
        detail: `the command did not finish within ${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 60000)} minute(s)`,
        output,
      };
    }
    if (typeof failure.code === 'number') {
      return {
        ok: false,
        ...exitCodeBase,
        exitCode: failure.code,
        reason: 'failed',
        detail: `the command exited ${failure.code}`,
        output,
      };
    }
    return {
      ok: false,
      ...exitCodeBase,
      exitCode: null,
      reason: 'spawn-failed',
      detail: failure.message ?? 'the command could not be started',
      output,
    };
  }
}

function commandFromManifest(root: string, manifest: Manifest): CoverageCommand | null {
  const script = COVERAGE_SCRIPT_NAMES.find((name) => isNonEmptyString(manifest.scripts[name]));
  if (!script) {
    return null;
  }
  const runner = runnerFor(root, manifest.packageManager);
  return { runner, script, command: `${runner} run ${script}` };
}

function runnerFor(root: string, declared: string | null): CoverageRunner {
  const name = declared?.split('@')[0]?.toLowerCase();
  if (isRunner(name)) {
    return name;
  }
  if (exists(path.join(root, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (exists(path.join(root, 'yarn.lock'))) {
    return 'yarn';
  }
  if (exists(path.join(root, 'bun.lockb')) || exists(path.join(root, 'bun.lock'))) {
    return 'bun';
  }
  return 'npm';
}

function isRunner(value: string | undefined): value is CoverageRunner {
  return value === 'npm' || value === 'pnpm' || value === 'yarn' || value === 'bun';
}

/** The Windows command interpreter to run a `.cmd` shim through; `ComSpec` names it. */
function commandInterpreter(env: NodeJS.ProcessEnv): string {
  return env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
}

function readManifest(manifestPath: string): Manifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      scripts?: unknown;
      packageManager?: unknown;
    };
    const scripts: Record<string, string> = {};
    if (parsed.scripts && typeof parsed.scripts === 'object') {
      for (const [name, value] of Object.entries(parsed.scripts)) {
        if (typeof value === 'string') {
          scripts[name] = value;
        }
      }
    }
    return {
      scripts,
      packageManager: typeof parsed.packageManager === 'string' ? parsed.packageManager : null,
    };
  } catch {
    return null;
  }
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function exists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function modifiedAt(candidate: string): number | null {
  try {
    return fs.statSync(candidate).mtimeMs;
  } catch {
    return null;
  }
}

/** The last {@link OUTPUT_TAIL_CHARS} characters, so a wall of output stays bounded. */
function tail(output: string): string {
  return output.length > OUTPUT_TAIL_CHARS ? output.slice(output.length - OUTPUT_TAIL_CHARS) : output;
}
