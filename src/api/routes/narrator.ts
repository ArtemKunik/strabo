import { Router } from 'express';

import { computeRepositoryPassport } from '../../analysis/passport.ts';
import { computeReadingRoute } from '../../analysis/route.ts';
import { resolveRepositoryRoot } from '../../boundary/repository-root.ts';
import { getCachedGraph } from '../../cache/graph-cache.ts';
import { createNarratorClient, type NarratorClient } from '../../narrator/client.ts';
import { resolveNarratorConfig } from '../../narrator/config.ts';
import { buildTourRequest } from '../../narrator/tour.ts';
import {
  effectiveNarratorConfig,
  endpointHostOf,
  narratorLocks,
} from '../../narrator/effective.ts';
import { createNarratorKeyStore, type NarratorKeyStore } from '../../narrator/key-store.ts';
import { NARRATOR_PRESETS } from '../../narrator/presets.ts';
import type { SettingsStore } from '../../state/settings-store.ts';
import { createSettingsStore } from '../../state/settings-store.ts';
import type { NarratorConfig, StraboConfig } from '../../types.ts';
import { isSameOriginRequest, narratorTestHint, sendError } from '../http.ts';

export interface NarratorRouterOptions {
  settingsStore?: SettingsStore;
  keyStore?: NarratorKeyStore;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/**
 * The opt-in narrator surface.
 *
 * `GET /narrator` reports whether the narrator is configured and how much of its budget is
 * left, plus which fields the environment locks (`set by STRABO_NARRATOR_MODEL`) and whether
 * a key is available — never the key itself and never the stored value. `POST /narrator`
 * sends recorded evidence and returns narrative text labelled as such.
 *
 * The client reads the effective config (environment over persisted Settings) on every call,
 * so a Settings update takes effect without a restart. Budget, cache, and audit stay
 * per-process across config changes. A loopback endpoint may run with key source "none";
 * a remote endpoint needs a key from the bound environment variable or the stored
 * on-machine key for its host.
 *
 * Wire format: every preset (Ollama, LM Studio, OpenAI, Anthropic via its OpenAI-compatible
 * `https://api.anthropic.com/v1/` endpoint, OpenRouter, Custom) sends an OpenAI-style
 * `messages` body. No native adapter is needed per the current provider docs.
 */
export function createNarratorRouter(
  config: StraboConfig,
  client?: NarratorClient,
  options: NarratorRouterOptions = {},
): Router {
  const router = Router();
  const settingsStore = options.settingsStore ?? createSettingsStore();
  const keyStore = options.keyStore ?? createNarratorKeyStore();
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const readEffective = (): NarratorConfig | undefined => {
    try {
      const persisted = settingsStore.read();
      const merged = effectiveNarratorConfig(env, persisted);
      // The startup config (env-only) still applies when nothing is persisted.
      if (merged) {
        return merged;
      }
      return config.narrator;
    } catch {
      return config.narrator;
    }
  };

  const readKey = (apiKeyEnv: string): string | undefined => {
    const fromEnv = env[apiKeyEnv]?.trim();
    if (fromEnv) {
      return fromEnv;
    }
    const host = endpointHostOf(readEffective()?.endpoint);
    if (host) {
      return keyStore.read(host) ?? undefined;
    }
    return undefined;
  };

  const narrator =
    client ??
    createNarratorClient({
      configProvider: readEffective,
      keyProvider: readKey,
      root: config.workspaceRoot,
      env,
      serverLog: config.serverLog,
    });

  const keyStatus = (effective: NarratorConfig | undefined) => {
    const apiKeyEnv = effective?.apiKeyEnv?.trim() || 'STRABO_NARRATOR_API_KEY';
    const host = endpointHostOf(effective?.endpoint);
    const envSet = Boolean(env[apiKeyEnv]?.trim());
    const storedSet = host ? keyStore.has(host) : false;
    return {
      envVar: apiKeyEnv,
      envSet,
      storedSet,
      source: (envSet ? 'env' : storedSet ? 'stored' : 'none') as 'env' | 'stored' | 'none',
      ...(host ? { host } : {}),
    };
  };

  /** Resolve the repository the tour reads, honouring the same ceiling as the analyses. */
  const resolve = (request: { query: Record<string, unknown>; body?: Record<string, unknown> }) =>
    resolveRepositoryRoot({
      workspaceRoot: config.workspaceRoot,
      scanCeiling: config.scanCeiling ?? config.workspaceRoot,
      requested:
        typeof request.query.repository === 'string'
          ? request.query.repository
          : typeof request.body?.repository === 'string'
            ? request.body.repository
            : undefined,
    });

  router.get('/narrator', (_request, response) => {
    try {
      const effective = readEffective();
      const status = narrator.status();
      const locks = narratorLocks(env);
      const key = keyStatus(effective);
      response.json({
        ...status,
        ...(effective?.endpoint ? { endpoint: effective.endpoint } : {}),
        ...(effective?.sendSource === true ? { sendSource: true } : { sendSource: false }),
        ...(effective?.requestBudget ? { requestBudget: effective.requestBudget } : {}),
        apiKeyEnv: key.envVar,
        locked: locks,
        key,
        presets: NARRATOR_PRESETS,
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/narrator/runs', (_request, response) => {
    try {
      response.json({ runs: narrator.runs() });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/narrator', async (request, response) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const evidence = typeof body.evidence === 'string' ? body.evidence : '';
      if (evidence.trim().length === 0) {
        response.status(400).json({ error: 'evidence is required' });
        return;
      }
      const instruction = typeof body.instruction === 'string' ? body.instruction : '';
      const source = typeof body.source === 'string' ? body.source : undefined;
      response.json(await narrator.narrate({ instruction, evidence, ...(source ? { source } : {}) }));
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * The opt-in guided tour: the repository passport plus the reading route become the recorded
   * evidence for a five-to-seven-paragraph onboarding narrative. Like every narrator call it is
   * inert until an endpoint and model are configured, and only recorded facts are sent.
   */
  router.post('/narrator/tour', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const passport = computeRepositoryPassport(
        repository.name,
        cached.report.graph,
        cached.report.extensionCounts,
      );
      const route = computeReadingRoute(repository.root, repository.name, cached.report.graph);
      response.json(await narrator.narrate(buildTourRequest(passport, route)));
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * List the provider's models where it exposes a model list, so a model id is picked
   * rather than typed. Tries the OpenAI-compatible `/models` URL derived from the
   * endpoint, falling back to Ollama's native `/api/tags` on loopback.
   */
  router.get('/narrator/models', async (request, response) => {
    try {
      if (!isSameOriginRequest(request)) {
        response.status(403).json({ error: 'model listing is accepted only from the Strabo page.' });
        return;
      }
      const effective = readEffective();
      const locks = narratorLocks(env);
      // A locked endpoint always wins; otherwise an unsaved form value is used so Fetch
      // models works before the operator saves.
      const override = typeof request.query.endpoint === 'string' ? request.query.endpoint.trim() : '';
      const endpoint = (locks.endpoint ? effective?.endpoint : override || effective?.endpoint)?.trim();
      if (!endpoint) {
        response.status(400).json({ error: 'set an endpoint first, then fetch models.' });
        return;
      }
      let modelsUrl: string;
      try {
        const url = new URL(endpoint);
        const secure = url.protocol === 'https:';
        const loopback =
          url.protocol === 'http:' &&
          (url.hostname === 'localhost' ||
            url.hostname === '127.0.0.1' ||
            url.hostname === '0.0.0.0' ||
            url.hostname === '::1' ||
            url.hostname.endsWith('.localhost'));
        if (!secure && !loopback) {
          response.status(400).json({ error: 'remote endpoints need https.' });
          return;
        }
        modelsUrl = endpoint.includes('/chat/completions')
          ? endpoint.replace('/chat/completions', '/models')
          : endpoint.replace(/\/$/, '') + '/models';
      } catch {
        response.status(400).json({ error: 'endpoint is not a URL.' });
        return;
      }
      const apiKeyEnv = effective?.apiKeyEnv?.trim() || 'STRABO_NARRATOR_API_KEY';
      const apiKey = readKey(apiKeyEnv);
      const headers: Record<string, string> = { accept: 'application/json' };
      if (apiKey) {
        headers.authorization = `Bearer ${apiKey}`;
      }

      const fetchModels = async (url: string): Promise<Response | null> => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          try {
            const res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
            return res as unknown as Response;
          } finally {
            clearTimeout(timer);
          }
        } catch {
          return null;
        }
      };

      let res = await fetchModels(modelsUrl);
      // Ollama also serves a native tag list; try it when the compatible URL fails on loopback.
      if ((!res || !res.ok) && endpointHostOf(endpoint)?.startsWith('127.0.0.1:11434') ) {
        try {
          const url = new URL(endpoint);
          res = await fetchModels(`${url.protocol}//${url.host}/api/tags`);
        } catch {
          // Fall through to the error below.
        }
      }
      if (!res) {
        response.status(502).json({ error: 'the provider could not be reached.' });
        return;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        response.status(502).json({ error: narratorTestHint(res.status, text) });
        return;
      }
      const body = (await res.json().catch(() => null)) as {
        data?: Array<{ id?: unknown }>;
        models?: Array<{ name?: unknown } | string>;
      } | null;
      const ids: string[] = [];
      if (Array.isArray(body?.data)) {
        for (const entry of body.data) {
          if (typeof entry?.id === 'string' && entry.id.trim() !== '') {
            ids.push(entry.id.trim());
          }
        }
      }
      if (ids.length === 0 && Array.isArray(body?.models)) {
        for (const entry of body.models) {
          if (typeof entry === 'string' && entry.trim() !== '') {
            ids.push(entry.trim());
          } else if (typeof entry === 'object' && typeof entry?.name === 'string' && entry.name.trim() !== '') {
            ids.push(entry.name.trim());
          }
        }
      }
      response.json({ models: [...new Set(ids)].sort() });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Test the connection with a minimal prompt. Reports latency and the model that replied,
   * or the problem in plain words. Does not spend the session budget or pollute the cache.
   * Accepts optional `endpoint` / `model` overrides to test unsaved form values; locked
   * fields always use the environment value. A stored key is sent only when the tested host
   * matches the stored host, so testing a new host never redirects the saved key.
   */
  router.post('/narrator/test', async (request, response) => {
    try {
      if (!isSameOriginRequest(request)) {
        response.status(403).json({ error: 'test connection is accepted only from the Strabo page.' });
        return;
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const effective = readEffective();
      const locks = narratorLocks(env);
      const endpoint =
        (locks.endpoint ? effective?.endpoint : typeof body.endpoint === 'string' && body.endpoint.trim() !== '' ? body.endpoint.trim() : effective?.endpoint) ?? '';
      const model =
        (locks.model ? effective?.model : typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : effective?.model) ?? '';
      const testConfig: NarratorConfig = {
        ...(endpoint ? { endpoint } : {}),
        ...(model ? { model } : {}),
        ...(effective?.apiKeyEnv ? { apiKeyEnv: effective.apiKeyEnv } : {}),
        ...(effective?.requestBudget ? { requestBudget: effective.requestBudget } : {}),
        ...(effective?.sendSource ? { sendSource: true } : {}),
      };
      const resolution = resolveNarratorConfig(testConfig);
      if (!resolution.configured) {
        response.json({ ok: false, reason: resolution.reason, detail: resolution.detail ?? null });
        return;
      }
      const host = resolution.endpointHost;
      const fromEnv = env[resolution.apiKeyEnv]?.trim() || undefined;
      // A stored key is host-bound: a different host means "confirm the key again".
      const stored = keyStore.read(host) ?? undefined;
      const savedHost = endpointHostOf(effective?.endpoint);
      const apiKey = fromEnv ?? (savedHost === host ? stored : undefined);
      const loopback = (() => {
        try {
          const hostname = new URL(resolution.endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, '');
          return (
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname === '0.0.0.0' ||
            hostname === '::1' ||
            hostname.endsWith('.localhost')
          );
        } catch {
          return false;
        }
      })();
      if (!apiKey && !loopback) {
        response.json({
          ok: false,
          reason: 'not-authenticated',
          detail: `set ${resolution.apiKeyEnv} or store a key for ${host} first.`,
        });
        return;
      }
      const started = Date.now();
      let res: globalThis.Response;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          res = await fetchImpl(resolution.endpoint, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            },
            signal: controller.signal,
            body: JSON.stringify({
              model: resolution.model,
              max_tokens: 8,
              messages: [
                { role: 'system', content: 'Reply with the word ok.' },
                { role: 'user', content: '<evidence>\nconnection test\n</evidence>' },
              ],
            }),
          });
        } finally {
          clearTimeout(timer);
        }
      } catch {
        response.json({ ok: false, reason: 'provider-error', detail: 'the narrator endpoint could not be reached.' });
        return;
      }
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        response.json({ ok: false, reason: 'provider-error', detail: narratorTestHint(res.status, text) });
        return;
      }
      const payload = (await res.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        model?: unknown;
      } | null;
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
        response.json({ ok: false, reason: 'provider-error', detail: 'the narrator response could not be parsed.' });
        return;
      }
      response.json({
        ok: true,
        latencyMs,
        model: typeof payload?.model === 'string' && payload.model !== '' ? payload.model : resolution.model,
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Store the API key for the current endpoint host. Write-only: the browser never receives
   * a key back, only `set` / `missing` via `GET /narrator`. The host binding is what keeps an
   * endpoint change from redirecting the key.
   */
  router.post('/narrator/key', (request, response) => {
    try {
      if (!isSameOriginRequest(request)) {
        response.status(403).json({ error: 'key storage is accepted only from the Strabo page.' });
        return;
      }
      const effective = readEffective();
      const host = endpointHostOf(effective?.endpoint);
      if (!host) {
        response.status(400).json({ error: 'set an endpoint first, then store a key for its host.' });
        return;
      }
      const resolution = resolveNarratorConfig(effective);
      if (!resolution.configured && resolution.reason === 'invalid-endpoint') {
        response.status(400).json({ error: resolution.detail ?? 'endpoint must be https: or a loopback http: address.' });
        return;
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!key) {
        response.status(400).json({ error: 'a key is required.' });
        return;
      }
      keyStore.write(host, key);
      response.json({ stored: true, host });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.delete('/narrator/key', (request, response) => {
    try {
      if (!isSameOriginRequest(request)) {
        response.status(403).json({ error: 'key removal is accepted only from the Strabo page.' });
        return;
      }
      keyStore.clear();
      response.json({ stored: false });
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
