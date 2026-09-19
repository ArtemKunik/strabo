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
    // Online risk lookup is opt-in: it is the only feature that contacts a third party.
    riskOnline: isEnabled(env.STRABO_RISK),
    deniedLicenses: env.STRABO_RISK_DENY?.split(',').map((entry) => entry.trim()).filter(Boolean),
  };
}

function isEnabled(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'online' || value?.toLowerCase() === 'true';
}

/** Build the server configuration object from resolved environment values. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): StraboConfig {
  const { root, configPath, scanCeiling, riskOnline, deniedLicenses } = readEnv(env);
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
