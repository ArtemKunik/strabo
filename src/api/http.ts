import type { Request, Response } from 'express';

import { StraboScopeError } from '../boundary/repository-root.ts';

/** Send a clear client error without running a scan. */
export function sendError(response: Response, error: unknown): void {
  if (error instanceof StraboScopeError) {
    response.status(400).json({ error: error.message });
    return;
  }
  response.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
}

/** Parse a positive integer query parameter, returning undefined when absent/invalid. */
export function parsePositiveInt(value: unknown, max?: number): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return max !== undefined ? Math.min(parsed, max) : parsed;
}

export function parseBoolean(value: unknown): boolean {
  return value === '1' || value === 'true';
}

/**
 * Reject a state-changing request that arrives from another origin.
 *
 * The Settings and narrator-key writes are accepted only from the page's own origin,
 * so a third-party page cannot repoint the narrator or its key. Browser `fetch` sends
 * `Origin` (and usually `Referer`) for these POST/PUT calls; non-browser clients such as
 * `curl` and the test suite send neither and are allowed through. A present header that
 * does not match the request host is rejected with `false`.
 */
export function isSameOriginRequest(request: Request): boolean {
  const host = request.get('host')?.toLowerCase();
  if (!host) {
    return true;
  }
  const origin = request.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== host) {
        return false;
      }
    } catch {
      return false;
    }
  }
  const referer = request.get('referer');
  if (referer) {
    try {
      if (new URL(referer).host.toLowerCase() !== host) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Map a provider HTTP status to plain words for the Test connection panel.
 *
 * Reuses the `resolveNarratorConfig` reasons where they apply and translates the
 * provider error itself: 401 is a rejected key, 404/400 naming a model is a wrong model
 * id, 429 is rate limiting, 5xx is the provider failing.
 */
export function narratorTestHint(status: number, bodyText: string): string {
  const body = bodyText.toLowerCase();
  if (status === 401 || body.includes('incorrect api key') || body.includes('invalid api key')) {
    return '401: key rejected — check the key for this host.';
  }
  if (status === 404 || (status === 400 && body.includes('model'))) {
    return 'model not found: try Fetch models and pick an id the provider lists.';
  }
  if (status === 429) {
    return 'rate limited: wait a minute and test again.';
  }
  if (status >= 500) {
    return 'the provider failed: try again in a minute.';
  }
  return `endpoint returned ${status}: check the endpoint and model.`;
}
