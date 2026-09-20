import path from 'node:path';

import type { StraboConfig } from './types.ts';

export interface CliEnv {
  root: string;
  configPath?: string;
  scanCeiling: string;
  port: number;
  riskOnline: boolean;
  deniedLicenses?: string[];
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
    port: Number.parseInt(env.PORT ?? '3000', 10),
    // Online risk lookup is opt-in: it is the only feature that contacts a third party.
    riskOnline: isEnabled(env.STRABO_RISK),
    deniedLicenses: env.STRABO_RISK_DENY?.split(',').map((entry) => entry.trim()).filter(Boolean),
  };
}

/** First non-flag argument, so `strabo /path/to/repo` works and `strabo --help` is ignored. */
function firstPositional(argv: readonly string[]): string | undefined {
  const value = argv.find((arg) => !arg.startsWith('-'))?.trim();
  return value || undefined;
}

function isEnabled(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'online' || value?.toLowerCase() === 'true';
}

/** Build the server configuration object from resolved environment values. */
export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = [],
): StraboConfig {
  const { root, configPath, scanCeiling, riskOnline, deniedLicenses } = readEnv(env, argv);
  return {
    workspaceRoot: root,
    configPath,
    scanCeiling,
    risk: {
      online: riskOnline,
      ...(deniedLicenses && deniedLicenses.length > 0 ? { deniedLicenses } : {}),
    },
    serverLog: (message, error) => {
      if (error) {
        console.error(`[strabo] ${message}`, error);
      } else {
        console.log(`[strabo] ${message}`);
      }
    },
  };
}
