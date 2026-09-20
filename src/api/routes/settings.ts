import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';

import type { StraboConfig } from '../../types.ts';
import { sendError } from '../http.ts';

/**
 * The server settings the operator can read and change at runtime.
 *
 * Unlike every other route these are not read-only: `scanCeiling` and the online risk
 * switch may be updated while the server runs. The change is process-local — a restart
 * returns to the values from the environment — so the panel labels it that way rather
 * than implying it persists.
 */
export interface StraboSettings {
  /** Repository root the process started with; never changed by a request. */
  workspaceRoot: string;
  /** The boundary every path is resolved through, currently in force. */
  scanCeiling: string;
  /** The ceiling configured at startup, restored when the ceiling is reset. */
  defaultScanCeiling: string;
  /** Path to the workspace config, when one was given. */
  configPath: string | null;
  /** Whether OSV.dev / deps.dev lookups are enabled. */
  riskOnline: boolean;
  /** SPDX ids the license policy denies, or null for the built-in policy. */
  riskDeniedLicenses: string[] | null;
}

function currentCeiling(config: StraboConfig): string {
  return config.scanCeiling ?? config.workspaceRoot;
}

function settingsView(config: StraboConfig, defaultCeiling: string): StraboSettings {
  return {
    workspaceRoot: config.workspaceRoot,
    scanCeiling: currentCeiling(config),
    defaultScanCeiling: defaultCeiling,
    configPath: config.configPath ?? null,
    riskOnline: Boolean(config.risk?.online),
    riskDeniedLicenses: config.risk?.deniedLicenses ?? null,
  };
}

/**
 * Resolve and validate a requested scan ceiling.
 *
 * The ceiling is a security boundary, so this deliberately does not accept an arbitrary
 * string: it must name an existing directory. It *can* widen the boundary — that is the
 * point of an editable ceiling — so it is bounded only by what the server process may
 * already read, and never by a parent of `STRABO_SCAN_CEILING` beyond that. Passing null
 * or an empty string restores the startup ceiling.
 */
export function resolveScanCeiling(
  requested: unknown,
  defaultCeiling: string,
): { ceiling: string } | { error: string } {
  if (requested === null || requested === undefined || requested === '') {
    return { ceiling: defaultCeiling };
  }
  if (typeof requested !== 'string') {
    return { error: 'scanCeiling must be a string path, or null to reset.' };
  }
  const resolved = path.resolve(requested.trim());
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { error: `Scan ceiling "${requested}" does not exist or is not a directory.` };
  }
  return { ceiling: resolved };
}

/**
 * Read and update the server's runtime settings.
 *
 * `GET /settings` returns the current values; `PUT /settings` accepts `{ scanCeiling,
 * riskOnline }` (either field optional) and returns the resulting values. A rejected
 * update changes nothing: the ceiling is validated before it is assigned.
 */
export function createSettingsRouter(config: StraboConfig): Router {
  const router = Router();
  const defaultCeiling = currentCeiling(config);

  router.get('/settings', (_request, response) => {
    try {
      response.json(settingsView(config, defaultCeiling));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.put('/settings', (request, response) => {
    try {
      const body = request.body ?? {};
      let nextCeiling = currentCeiling(config);
      if ('scanCeiling' in body) {
        const resolved = resolveScanCeiling(body.scanCeiling, defaultCeiling);
        if ('error' in resolved) {
          response.status(400).json({ error: resolved.error });
          return;
        }
        nextCeiling = resolved.ceiling;
      }
      if ('riskOnline' in body && typeof body.riskOnline !== 'boolean') {
        response.status(400).json({ error: 'riskOnline must be a boolean.' });
        return;
      }

      config.scanCeiling = nextCeiling;
      if ('riskOnline' in body) {
        config.risk = { ...(config.risk ?? {}), online: body.riskOnline };
      }
      response.json(settingsView(config, defaultCeiling));
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
