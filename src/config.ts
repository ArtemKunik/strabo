import path from 'node:path';

import type { StraboConfig } from './types.ts';

export interface CliEnv {
  root: string;
  configPath?: string;
  scanCeiling: string;
  port: number;
}

/** Read CLI/server configuration from the documented environment variables. */
export function readEnv(env: NodeJS.ProcessEnv = process.env): CliEnv {
  const root = env.STRABO_ROOT?.trim();
  if (!root) {
    throw new Error('STRABO_ROOT is required (path to the repository to scan).');
  }
  const resolvedRoot = path.resolve(root);
  return {
    root: resolvedRoot,
    configPath: env.STRABO_CONFIG?.trim() || undefined,
    scanCeiling: path.resolve(env.STRABO_SCAN_CEILING?.trim() || resolvedRoot),
    port: Number.parseInt(env.PORT ?? '3000', 10),
  };
}

/** Build the server configuration object from resolved environment values. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): StraboConfig {
  const { root, configPath, scanCeiling } = readEnv(env);
  return {
    workspaceRoot: root,
    configPath,
    scanCeiling,
    serverLog: (message, error) => {
      if (error) {
        console.error(`[strabo] ${message}`, error);
      } else {
        console.log(`[strabo] ${message}`);
      }
    },
  };
}
