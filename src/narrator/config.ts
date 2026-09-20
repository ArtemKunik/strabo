import type { NarratorConfig } from '../types.ts';

export const NARRATOR_DEFAULT_KEY_ENV = 'STRABO_NARRATOR_API_KEY';
export const NARRATOR_DEFAULT_BUDGET = 20;

/** Why the narrator is not available. Mirrors `UnavailableReason` but is narrator-specific. */
export type NarratorUnavailableReason =
  | 'not-configured'
  | 'invalid-endpoint'
  | 'missing-model'
  | 'not-authenticated'
  | 'budget-exhausted'
  | 'provider-error';

export interface ResolvedNarratorConfig {
  configured: true;
  /** The validated endpoint, normalised through `URL`. */
  endpoint: string;
  /** Host and port only, safe to log and to show in a status panel (never the full path). */
  endpointHost: string;
  model: string;
  apiKeyEnv: string;
  requestBudget: number;
  sendSource: boolean;
}

export interface UnresolvedNarratorConfig {
  configured: false;
  reason: NarratorUnavailableReason;
  detail?: string;
}

export type NarratorResolution = ResolvedNarratorConfig | UnresolvedNarratorConfig;

/** Loopback hosts may be plaintext; anything else must be `https:`. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.localhost')
  );
}

/**
 * Validate and normalise the narrator configuration.
 *
 * Never contacts anything. A missing endpoint means "not configured"; a supplied endpoint
 * that is neither `https:` nor loopback is refused rather than sent, so the key cannot leave
 * the machine in the clear. The API key itself is never part of the config.
 */
export function resolveNarratorConfig(config?: NarratorConfig): NarratorResolution {
  if (!config?.endpoint) {
    return { configured: false, reason: 'not-configured' };
  }
  if (!config.model) {
    return { configured: false, reason: 'missing-model', detail: 'a narrator model is required' };
  }
  let url: URL;
  try {
    url = new URL(config.endpoint);
  } catch {
    return { configured: false, reason: 'invalid-endpoint', detail: 'endpoint is not a URL' };
  }
  const secure = url.protocol === 'https:';
  const loopback = url.protocol === 'http:' && isLoopbackHost(url.hostname);
  if (!secure && !loopback) {
    return {
      configured: false,
      reason: 'invalid-endpoint',
      detail: 'endpoint must be https: or a loopback http: address',
    };
  }
  const requested = config.requestBudget;
  const requestBudget =
    typeof requested === 'number' && Number.isInteger(requested) && requested > 0
      ? requested
      : NARRATOR_DEFAULT_BUDGET;
  return {
    configured: true,
    endpoint: url.toString(),
    endpointHost: url.host,
    model: config.model,
    apiKeyEnv: config.apiKeyEnv?.trim() || NARRATOR_DEFAULT_KEY_ENV,
    requestBudget,
    sendSource: config.sendSource === true,
  };
}
