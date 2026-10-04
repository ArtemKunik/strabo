import path from 'node:path';

import type { StraboConfig } from './types.ts';

export interface CliEnv {
  root: string;
  configPath?: string;
  scanCeiling: string;
  host: string;
  port: number;
  riskOnline: boolean;
  allowCeilingWidening: boolean;
  autoRebuild: boolean;
  /** Detached terminal daemon, on by default; see `StraboConfig.terminalDaemon`. */
  terminalDaemon: boolean;
  /** Terminal and delegation for non-loopback peers; see `StraboConfig.allowRemoteTerminal`. */
  allowRemoteTerminal: boolean;
  deniedLicenses?: string[];
  /** Explicit coverage report paths, overriding the conventional auto-detected locations. */
  coverageReports?: string[];
  /** Opt-in permission for `POST /analysis/coverage/refresh` to run the repository's script. */
  allowCoverageRefresh: boolean;
  narratorEndpoint?: string;
  narratorModel?: string;
  narratorKeyEnv?: string;
  narratorBudget?: number;
  narratorSendSource: boolean;
}

/**
 * Read CLI/server configuration from a path argument, the documented environment
 * variables, and the working directory, in that order of precedence.
 *
 * `argv` defaults to empty rather than `process.argv` so that an embedder passing a
 * synthetic environment never picks up the host process's arguments; the CLI passes
 * its own arguments explicitly.
 */
export function readEnv(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = [],
): CliEnv {
  // Running `strabo` inside a repository should map that repository, so the working
  // directory is the fallback rather than an error.
  const root = firstPositional(argv) ?? env.STRABO_ROOT?.trim() ?? '';
  const resolvedRoot = path.resolve(root || process.cwd());
  return {
    root: resolvedRoot,
    configPath: env.STRABO_CONFIG?.trim() || undefined,
    scanCeiling: path.resolve(env.STRABO_SCAN_CEILING?.trim() || resolvedRoot),
    // The server is an operator tool with full read access inside the ceiling, so it
    // binds loopback by default and only leaves it when the operator says so twice:
    // once here, and once past the Host-header check with a matching Host.
    host: flagValue(argv, 'host') || env.STRABO_HOST?.trim() || '127.0.0.1',
    port: Number.parseInt(flagValue(argv, 'port') ?? env.PORT ?? '3000', 10),
    // Online risk lookup is opt-in: it is the only feature that contacts a third party.
    riskOnline: isEnabled(env.STRABO_RISK),
    // Runtime ceiling widening is a startup-only opt-in. It is never accepted from a
    // request, so a request cannot grant itself a wider read boundary.
    allowCeilingWidening: isEnabled(env.STRABO_ALLOW_CEILING_WIDENING) || hasFlag(argv, 'allow-ceiling-widening'),
    // Background rebuilds are on unless the operator turns them off; a status poll can then
    // observe HEAD moving without forcing a synchronous scan on the next request.
    autoRebuild: !isDisabled(env.STRABO_AUTO_REBUILD),
    // Sessions must survive a restart, so the detached terminal daemon is on unless the
    // operator turns it off: it owns the PTYs so a server restart cannot take them with it.
    // `STRABO_TERMINAL_DAEMON=0` or `--no-terminal-daemon` restores the in-process registry.
    terminalDaemon: !isDisabled(env.STRABO_TERMINAL_DAEMON) && !hasFlag(argv, 'no-terminal-daemon'),
    // A shell is never served to the network by accident: leaving loopback for the map does
    // not also hand out a terminal. Docker-style setups opt in explicitly.
    allowRemoteTerminal:
      isEnabled(env.STRABO_ALLOW_REMOTE_TERMINAL) || hasFlag(argv, 'allow-remote-terminal'),
    deniedLicenses: env.STRABO_RISK_DENY?.split(',').map((entry) => entry.trim()).filter(Boolean),
    // An explicit report path (or a comma-separated list) overrides auto-detection; it is
    // still read only inside the scan ceiling.
    coverageReports: env.STRABO_COVERAGE_REPORT?.split(',').map((entry) => entry.trim()).filter(Boolean),
    // Running the repository's own coverage script is the one analysis that executes code, so
    // it is off unless the operator opts in; the detected command is still shown when it is off.
    allowCoverageRefresh:
      isEnabled(env.STRABO_ALLOW_COVERAGE_REFRESH) || hasFlag(argv, 'allow-coverage-refresh'),
    // The narrator is a second opt-in provider; without an endpoint and model it is inert.
    narratorEndpoint: env.STRABO_NARRATOR_ENDPOINT?.trim() || undefined,
    narratorModel: env.STRABO_NARRATOR_MODEL?.trim() || undefined,
    narratorKeyEnv: env.STRABO_NARRATOR_KEY_ENV?.trim() || undefined,
    narratorBudget: positiveInt(env.STRABO_NARRATOR_BUDGET),
    narratorSendSource: isEnabled(env.STRABO_NARRATOR_SEND_SOURCE),
  };
}

function positiveInt(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Flags that take a value, across every subcommand. A `--name value` pair is one option, so
 * its value is never mistaken for the repository path (`strabo report --base main`).
 */
const VALUE_FLAGS = new Set([
  'base',
  'baseline',
  'block-prefix',
  'expect',
  'fail-on',
  'file',
  'folder',
  'format',
  'host',
  'out',
  'port',
  'repository',
  'threshold',
  'view',
]);

/** The arguments that are neither flags nor the value of a `--name value` flag. */
export function positionals(argv: readonly string[]): string[] {
  const found: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg.startsWith('-')) {
      if (VALUE_FLAGS.has(arg.slice(2)) && !(argv[index + 1] ?? '-').startsWith('-')) {
        index += 1;
      }
      continue;
    }
    found.push(arg);
  }
  return found;
}

/** First positional argument, so `strabo /path/to/repo` works and `strabo --help` is ignored. */
function firstPositional(argv: readonly string[]): string | undefined {
  const value = positionals(argv)[0]?.trim();
  return value || undefined;
}

/** A `--name value` or `--name=value` flag; empty means absent. */
function flagValue(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length).trim();
      return value || undefined;
    }
    if (arg === `--${name}`) {
      const value = (argv[index + 1] ?? '').trim();
      return value.startsWith('-') || !value ? undefined : value;
    }
  }
  return undefined;
}

/** A bare `--name` switch. */
function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
}

function isEnabled(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'online' || value?.toLowerCase() === 'true';
}

function isDisabled(value: string | undefined): boolean {
  const normalised = value?.toLowerCase();
  return normalised === '0' || normalised === 'false' || normalised === 'off';
}

/** Build the server configuration object from resolved environment values. */
export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = [],
): StraboConfig {
  const {
    root,
    configPath,
    scanCeiling,
    host,
    riskOnline,
    allowCeilingWidening,
    autoRebuild,
    terminalDaemon,
    allowRemoteTerminal,
    deniedLicenses,
    coverageReports,
    allowCoverageRefresh,
    narratorEndpoint,
    narratorModel,
    narratorKeyEnv,
    narratorBudget,
    narratorSendSource,
  } = readEnv(env, argv);
  const narrator =
    narratorEndpoint || narratorModel
      ? {
          ...(narratorEndpoint ? { endpoint: narratorEndpoint } : {}),
          ...(narratorModel ? { model: narratorModel } : {}),
          ...(narratorKeyEnv ? { apiKeyEnv: narratorKeyEnv } : {}),
          ...(narratorBudget ? { requestBudget: narratorBudget } : {}),
          ...(narratorSendSource ? { sendSource: true } : {}),
        }
      : undefined;
  return {
    workspaceRoot: root,
    configPath,
    scanCeiling,
    host,
    allowCeilingWidening,
    autoRebuild,
    terminalDaemon,
    allowRemoteTerminal,
    risk: {
      online: riskOnline,
      ...(deniedLicenses && deniedLicenses.length > 0 ? { deniedLicenses } : {}),
    },
    ...(coverageReports && coverageReports.length > 0 ? { coverageReports } : {}),
    allowCoverageRefresh,
    ...(narrator ? { narrator } : {}),
    serverLog: (message, error) => {
      if (error) {
        console.error(`[strabo] ${message}`, error);
      } else {
        console.log(`[strabo] ${message}`);
      }
    },
  };
}
