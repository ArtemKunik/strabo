import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { isInside } from '../../boundary/repository-root.ts';
import {
  effectiveNarratorConfig,
  endpointHostOf,
  NARRATOR_ENV_VARS,
  narratorLocks,
} from '../../narrator/effective.ts';
import { createNarratorKeyStore, type NarratorKeyStore } from '../../narrator/key-store.ts';
import { resolveNarratorConfig } from '../../narrator/config.ts';
import { createSettingsStore, type SettingsStore } from '../../state/settings-store.ts';
import type { NarratorConfig, StraboConfig } from '../../types.ts';
import { isSameOriginRequest, sendError } from '../http.ts';

/**
 * The server settings the operator can read and change at runtime.
 *
 * Unlike every other route these are not read-only: `scanCeiling`, the online risk switch,
 * and the narrator setup may be updated while the server runs. `allowCeilingWidening` is
 * reported but read-only: it is startup-only (`STRABO_ALLOW_CEILING_WIDENING` or
 * `--allow-ceiling-widening`), because a request that could widen the read boundary must
 * never be able to grant itself the permission first. Accepted changes are persisted to
 * the state directory and re-applied at startup, so the app owns the setting instead of
 * the environment. The environment still seeds the value a first run starts from, and
 * `defaultScanCeiling` is what Reset restores. For the narrator the environment still
 * wins field-by-field: a value set by `STRABO_NARRATOR_*` shows as locked and cannot be
 * overridden from the browser.
 */
export interface NarratorSettingsView {
  endpoint: string | null;
  model: string | null;
  /** Name of the env var holding the key, or null for "stored key or none". */
  apiKeyEnv: string | null;
  sendSource: boolean;
  requestBudget: number | null;
  /** For each field, the env var that locks it, or null when Settings may change it. */
  locked: Record<'endpoint' | 'model' | 'apiKeyEnv' | 'budget' | 'sendSource', string | null>;
  /** Whether a key is available, never its value. */
  key: { envVar: string; envSet: boolean; storedSet: boolean; source: 'env' | 'stored' | 'none' };
}

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
  /** Whether `PUT` may widen the scan ceiling; startup-only, never set by a request. */
  allowCeilingWidening: boolean;
  /** SPDX ids the license policy denies, or null for the built-in policy. */
  riskDeniedLicenses: string[] | null;
  /** The narrator setup, merged with the environment winning. */
  narrator: NarratorSettingsView;
}

export interface SettingsRouterOptions {
  env?: NodeJS.ProcessEnv;
  keyStore?: NarratorKeyStore;
}

function currentCeiling(config: StraboConfig): string {
  return config.scanCeiling ?? config.workspaceRoot;
}

function narratorView(
  config: StraboConfig,
  store: SettingsStore,
  keyStore: NarratorKeyStore,
  env: NodeJS.ProcessEnv,
): NarratorSettingsView {
  const persisted = (() => {
    try {
      return store.read();
    } catch {
      return null;
    }
  })();
  const effective = effectiveNarratorConfig(env, persisted) ?? config.narrator;
  const locks = narratorLocks(env);
  const apiKeyEnv = effective?.apiKeyEnv?.trim() || 'STRABO_NARRATOR_API_KEY';
  const host = endpointHostOf(effective?.endpoint);
  const envSet = Boolean(env[apiKeyEnv]?.trim());
  const storedSet = host ? keyStore.has(host) : false;
  return {
    endpoint: effective?.endpoint?.trim() || null,
    model: effective?.model?.trim() || null,
    apiKeyEnv: effective?.apiKeyEnv?.trim() || null,
    sendSource: effective?.sendSource === true,
    requestBudget: effective?.requestBudget ?? null,
    locked: locks,
    key: {
      envVar: apiKeyEnv,
      envSet,
      storedSet,
      source: envSet ? 'env' : storedSet ? 'stored' : 'none',
    },
  };
}

function settingsView(
  config: StraboConfig,
  defaultCeiling: string,
  store: SettingsStore,
  keyStore: NarratorKeyStore,
  env: NodeJS.ProcessEnv,
): StraboSettings {
  return {
    workspaceRoot: config.workspaceRoot,
    scanCeiling: currentCeiling(config),
    defaultScanCeiling: defaultCeiling,
    configPath: config.configPath ?? null,
    riskOnline: Boolean(config.risk?.online),
    allowCeilingWidening: Boolean(config.allowCeilingWidening),
    riskDeniedLicenses: config.risk?.deniedLicenses ?? null,
    narrator: narratorView(config, store, keyStore, env),
  };
}

/**
 * Resolve and validate a requested scan ceiling.
 *
 * The ceiling is a security boundary, so this deliberately does not accept an arbitrary
 * string: it must name an existing directory. Narrowing it is always allowed. Widening it
 * beyond the ceiling currently in force is refused unless widening was enabled at startup
 * (`STRABO_ALLOW_CEILING_WIDENING` or `--allow-ceiling-widening`). Passing null or an
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
        'Restart with STRABO_ALLOW_CEILING_WIDENING=1 (or --allow-ceiling-widening) to permit it.',
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
 * A persisted `allowCeilingWidening` from an older version is deliberately not applied:
 * the permission is startup-only, so a stored `true` must not reopen the boundary after
 * a restart.
 * Narrator fields merge under the environment: an env var always wins over a saved value.
 */
export function applyPersistedSettings(
  config: StraboConfig,
  store: SettingsStore,
  env: NodeJS.ProcessEnv = process.env,
): void {
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
  // Narrator fields merge under the environment; persisted values only fill the gaps, so
  // an env-locked field is never shadowed by a saved one.
  const merged = effectiveNarratorConfig(env, saved);
  if (merged) {
    config.narrator = { ...(config.narrator ?? {}), ...merged };
  }
}

function cleanStringOrNull(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  // Empty string clears the field, like Reset does for the ceiling.
  return trimmed === '' ? null : trimmed;
}

/**
 * Read and update the server's runtime settings.
 *
 * `GET /settings` returns the current values; `PUT /settings` accepts `{ scanCeiling,
 * riskOnline, narrator }` (each optional) and returns the resulting
 * values. `allowCeilingWidening` is reported but never accepted: a body carrying it is
 * refused with 400, so one request can neither enable the permission nor combine it
 * with a wider ceiling. A rejected update changes nothing: the ceiling is validated
 * before it is assigned. Accepted changes are persisted through `store` and re-applied
 * on the next start.
 *
 * `narrator` accepts `{ endpoint, model, apiKeyEnv, sendSource, requestBudget }`, each
 * optional and nullable (null clears the persisted override). Fields locked by the
 * environment are rejected when the body tries to change them. Changing the endpoint host
 * clears the stored key and the persisted env-var binding, so the key must be confirmed
 * again for the new host. Writes are accepted only from the page's own origin.
 */
export function createSettingsRouter(
  config: StraboConfig,
  store: SettingsStore = createSettingsStore(),
  options: SettingsRouterOptions = {},
): Router {
  const router = Router();
  const env = options.env ?? process.env;
  const keyStore = options.keyStore ?? createNarratorKeyStore();
  // Capture the environment/startup ceiling before saved settings overlay it, so Reset
  // restores what the process was started with rather than the last persisted value.
  const defaultCeiling = currentCeiling(config);
  applyPersistedSettings(config, store, env);

  router.get('/settings', (_request, response) => {
    try {
      response.json(settingsView(config, defaultCeiling, store, keyStore, env));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.put('/settings', (request, response) => {
    try {
      if (!isSameOriginRequest(request)) {
        response.status(403).json({ error: 'settings writes are accepted only from the Strabo page.' });
        return;
      }
      const body = request.body ?? {};

      // The widening permission is startup-only (env/CLI). A body carrying it is
      // refused outright, so a request can never grant itself a wider read boundary.
      if ('allowCeilingWidening' in body) {
        response.status(400).json({
          error:
            'allowCeilingWidening is startup-only (STRABO_ALLOW_CEILING_WIDENING=1 or --allow-ceiling-widening) and is never accepted from a request.',
        });
        return;
      }
      if ('riskOnline' in body && typeof body.riskOnline !== 'boolean') {
        response.status(400).json({ error: 'riskOnline must be a boolean.' });
        return;
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

      // Narrator setup: validated before anything is assigned, so a rejection changes nothing.
      const narratorBody =
        body.narrator !== undefined
          ? body.narrator
          : 'narratorEndpoint' in body || 'narratorModel' in body || 'narratorKeyEnv' in body || 'narratorSendSource' in body || 'narratorBudget' in body
            ? {
                endpoint: (body as Record<string, unknown>).narratorEndpoint,
                model: (body as Record<string, unknown>).narratorModel,
                apiKeyEnv: (body as Record<string, unknown>).narratorKeyEnv,
                sendSource: (body as Record<string, unknown>).narratorSendSource,
                requestBudget: (body as Record<string, unknown>).narratorBudget,
              }
            : undefined;
      let narratorPatch: Partial<{
        narratorEndpoint: string | null;
        narratorModel: string | null;
        narratorKeyEnv: string | null;
        narratorSendSource: boolean | null;
        narratorBudget: number | null;
      }> | undefined;
      let keyClearedByHostChange = false;

      if (narratorBody !== undefined) {
        if (narratorBody === null || typeof narratorBody !== 'object') {
          response.status(400).json({ error: 'narrator must be an object.' });
          return;
        }
        const patch = narratorBody as Record<string, unknown>;
        const locks = narratorLocks(env);
        const persisted = store.read();
        const currentEffective = effectiveNarratorConfig(env, persisted) ?? config.narrator;

        const endpoint = 'endpoint' in patch ? cleanStringOrNull(patch.endpoint) : undefined;
        const model = 'model' in patch ? cleanStringOrNull(patch.model) : undefined;
        const apiKeyEnv = 'apiKeyEnv' in patch ? cleanStringOrNull(patch.apiKeyEnv) : undefined;
        let sendSource: boolean | null | undefined;
        if ('sendSource' in patch) {
          if (patch.sendSource === null) {
            sendSource = null;
          } else if (typeof patch.sendSource === 'boolean') {
            sendSource = patch.sendSource;
          } else if (patch.sendSource !== undefined) {
            response.status(400).json({ error: 'narrator.sendSource must be a boolean or null.' });
            return;
          }
        }
        let requestBudget: number | null | undefined;
        if ('requestBudget' in patch) {
          if (patch.requestBudget === null) {
            requestBudget = null;
          } else if (typeof patch.requestBudget === 'number' && Number.isInteger(patch.requestBudget) && patch.requestBudget > 0) {
            requestBudget = patch.requestBudget;
          } else if (patch.requestBudget !== undefined) {
            response.status(400).json({ error: 'narrator.requestBudget must be a positive integer or null.' });
            return;
          }
        }

        // Any explicit write to a locked field is rejected, so managed deployments stay
        // managed and the browser cannot shadow an environment value.
        for (const [field, value] of [
          ['endpoint', endpoint],
          ['model', model],
          ['apiKeyEnv', apiKeyEnv],
          ['budget', requestBudget],
          ['sendSource', sendSource],
        ] as const) {
          if (value !== undefined && locks[field]) {
            response.status(400).json({
              error: `narrator.${field} is set by ${locks[field]} and cannot be overridden from the browser.`,
            });
            return;
          }
        }

        if (apiKeyEnv !== undefined && apiKeyEnv !== null) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
            response.status(400).json({ error: 'narrator.apiKeyEnv must be a valid environment variable name.' });
            return;
          }
        }

        const nextEndpoint = endpoint !== undefined ? endpoint : currentEffective?.endpoint ?? null;
        const nextModel = model !== undefined ? model : currentEffective?.model ?? null;
        // Validate the merged endpoint/model pair the same way the narrator does, so the
        // https-or-loopback rule is unchanged for Settings writes.
        if (nextEndpoint || nextModel) {
          const check: NarratorConfig = {
            ...(nextEndpoint ? { endpoint: nextEndpoint } : {}),
            ...(nextModel ? { model: nextModel } : {}),
          };
          const resolution = resolveNarratorConfig(check);
          if (!resolution.configured && resolution.reason === 'invalid-endpoint') {
            response.status(400).json({ error: resolution.detail ?? 'endpoint must be https: or a loopback http: address.' });
            return;
          }
        }

        const oldHost = endpointHostOf(currentEffective?.endpoint);
        const newHost = endpointHostOf(nextEndpoint);
        if (oldHost && newHost && oldHost !== newHost) {
          // An endpoint change cannot redirect the key: drop the stored key and the binding.
          keyStore.clear();
          keyClearedByHostChange = true;
        }

        narratorPatch = {
          ...(endpoint !== undefined ? { narratorEndpoint: endpoint } : {}),
          ...(model !== undefined ? { narratorModel: model } : {}),
          ...(apiKeyEnv !== undefined || keyClearedByHostChange ? { narratorKeyEnv: keyClearedByHostChange ? null : apiKeyEnv ?? null } : {}),
          ...(sendSource !== undefined ? { narratorSendSource: sendSource } : {}),
          ...(requestBudget !== undefined ? { narratorBudget: requestBudget } : {}),
        };
      }

      config.scanCeiling = nextCeiling;
      if ('riskOnline' in body) {
        config.risk = { ...(config.risk ?? {}), online: body.riskOnline };
      }

      const patch: Record<string, unknown> = {
        ...(savedCeiling !== undefined ? { scanCeiling: savedCeiling } : {}),
        ...('riskOnline' in body ? { riskOnline: body.riskOnline } : {}),
        ...(narratorPatch ?? {}),
      };
      store.write(patch as Parameters<SettingsStore['write']>[0]);

      // Keep the live config in sync so the narrator router sees Settings updates.
      try {
        const merged = effectiveNarratorConfig(env, store.read());
        if (merged) {
          config.narrator = merged;
        } else if (narratorPatch) {
          const { ...rest } = config.narrator ?? {};
          config.narrator = Object.keys(rest).length > 0 ? (rest as NarratorConfig) : undefined;
          if (!config.narrator?.endpoint && !config.narrator?.model) {
            config.narrator = undefined;
          }
        }
      } catch {
        // Best-effort; the narrator router merges independently per request.
      }

      const view = settingsView(config, defaultCeiling, store, keyStore, env);
      response.json(
        keyClearedByHostChange
          ? { ...view, narrator: { ...view.narrator, keyCleared: true } }
          : view,
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
