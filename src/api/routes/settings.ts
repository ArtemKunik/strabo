import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { isInside } from '../../boundary/repository-root.ts';
import { createSettingsStore, type SettingsStore } from '../../state/settings-store.ts';
import type { StraboConfig } from '../../types.ts';
import { sendError } from '../http.ts';

/**
 * The server settings the operator can read and change at runtime.
 *
 * Unlike every other route these are not read-only: `scanCeiling`, the online risk switch,
 * and the widening opt-in may be updated while the server runs. Accepted changes are
 * persisted to the state directory and re-applied at startup, so the app owns the setting
 * instead of the environment. The environment still seeds the value a first run starts
 * from, and `defaultScanCeiling` is what Reset restores.
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
  /** Whether `PUT` may widen the scan ceiling beyond its startup value. */
  allowCeilingWidening: boolean;
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
    allowCeilingWidening: Boolean(config.allowCeilingWidening),
    riskDeniedLicenses: config.risk?.deniedLicenses ?? null,
  };
}

/**
 * Resolve and validate a requested scan ceiling.
 *
 * The ceiling is a security boundary, so this deliberately does not accept an arbitrary
 * string: it must name an existing directory. Narrowing it is always allowed. Widening it
 * beyond the ceiling currently in force is refused unless widening is enabled — by
 * `STRABO_ALLOW_CEILING_WIDENING` at startup or by the persisted "Allow widening" setting —
 * so a default process cannot grow its own read boundary at runtime. Passing null or an
 * empty string restores the startup ceiling.
 */
export function resolveScanCeiling(
  requested: unknown,
  defaultCeiling: string,
  options: { currentCeiling?: string; allowWidening?: boolean } = {},
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
  const current = options.currentCeiling ?? defaultCeiling;
  if (!options.allowWidening && !isInside(resolved, current)) {
    return {
      error:
        `Scan ceiling "${requested}" would widen the read boundary beyond "${current}". ` +
        'Enable "Allow widening" in Settings to permit it.',
    };
  }
  return { ceiling: resolved };
}

/**
 * Overlay the persisted settings on a freshly built config.
 *
 * Called once while the router is composed, before any request is served, so the rest of
 * the API reads the operator's saved values. A saved ceiling that no longer exists is
 * ignored rather than bricking startup. Null fields leave the environment value in place.
 */
export function applyPersistedSettings(config: StraboConfig, store: SettingsStore): void {
  const saved = store.read();
  if (saved.scanCeiling) {
    const resolved = path.resolve(saved.scanCeiling);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      config.scanCeiling = resolved;
    }
  }
  if (typeof saved.riskOnline === 'boolean') {
    config.risk = { ...(config.risk ?? {}), online: saved.riskOnline };
  }
  if (typeof saved.allowCeilingWidening === 'boolean') {
    config.allowCeilingWidening = saved.allowCeilingWidening;
  }
}

/**
 * Read and update the server's runtime settings.
 *
 * `GET /settings` returns the current values; `PUT /settings` accepts `{ scanCeiling,
 * riskOnline, allowCeilingWidening }` (each optional) and returns the resulting values. A
 * rejected update changes nothing: the ceiling is validated before it is assigned. Accepted
 * changes are persisted through `store` and re-applied on the next start.
 */
export function createSettingsRouter(config: StraboConfig, store: SettingsStore = createSettingsStore()): Router {
  const router = Router();
  // Capture the environment/startup ceiling before saved settings overlay it, so Reset
  // restores what the process was started with rather than the last persisted value.
  const defaultCeiling = currentCeiling(config);
  applyPersistedSettings(config, store);

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

      // The widening opt-in is applied first so one request can enable it and widen.
      if ('allowCeilingWidening' in body && typeof body.allowCeilingWidening !== 'boolean') {
        response.status(400).json({ error: 'allowCeilingWidening must be a boolean.' });
        return;
      }
      if ('riskOnline' in body && typeof body.riskOnline !== 'boolean') {
        response.status(400).json({ error: 'riskOnline must be a boolean.' });
        return;
      }
      if ('allowCeilingWidening' in body) {
        config.allowCeilingWidening = body.allowCeilingWidening;
      }

      let nextCeiling = currentCeiling(config);
      let savedCeiling: string | null | undefined;
      if ('scanCeiling' in body) {
        const resolved = resolveScanCeiling(body.scanCeiling, defaultCeiling, {
          currentCeiling: currentCeiling(config),
          allowWidening: Boolean(config.allowCeilingWidening),
        });
        if ('error' in resolved) {
          response.status(400).json({ error: resolved.error });
          return;
        }
        nextCeiling = resolved.ceiling;
        savedCeiling = body.scanCeiling === null || body.scanCeiling === '' ? null : resolved.ceiling;
      }

      config.scanCeiling = nextCeiling;
      if ('riskOnline' in body) {
        config.risk = { ...(config.risk ?? {}), online: body.riskOnline };
      }

      store.write({
        ...(savedCeiling !== undefined ? { scanCeiling: savedCeiling } : {}),
        ...('riskOnline' in body ? { riskOnline: body.riskOnline } : {}),
        ...('allowCeilingWidening' in body ? { allowCeilingWidening: body.allowCeilingWidening } : {}),
      });
      response.json(settingsView(config, defaultCeiling));
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
