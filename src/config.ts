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
  deniedLicenses?: string[];
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
    port: Number.parseInt(env.PORT ?? '3000', 10),
    // Online risk lookup is opt-in: it is the only feature that contacts a third party.
    riskOnline: isEnabled(env.STRABO_RISK),
    // Runtime ceiling widening is a startup-only opt-in. It is never accepted from a
    // request, so a request cannot grant itself a wider read boundary.
    allowCeilingWidening: isEnabled(env.STRABO_ALLOW_CEILING_WIDENING) || hasFlag(argv, 'allow-ceiling-widening'),
    // Background rebuilds are on unless the operator turns them off; a status poll can then
    // observe HEAD moving without forcing a synchronous scan on the next request.
    autoRebuild: !isDisabled(env.STRABO_AUTO_REBUILD),
    deniedLicenses: env.STRABO_RISK_DENY?.split(',').map((entry) => entry.trim()).filter(Boolean),
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

/** First non-flag argument, so `strabo /path/to/repo` works and `strabo --help` is ignored. */
function firstPositional(argv: readonly string[]): string | undefined {
  const value = argv.find((arg) => !arg.startsWith('-'))?.trim();
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
    deniedLicenses,
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
    risk: {
      online: riskOnline,
      ...(deniedLicenses && deniedLicenses.length > 0 ? { deniedLicenses } : {}),
    },
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
