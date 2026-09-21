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
 * Whether the request's Host header names this server.
 *
 * DNS rebinding works by luring a browser to a domain that resolves to 127.0.0.1: the
 * request then arrives with `Host: attacker.example` (and a matching `Origin`), so a
 * same-origin check alone passes. Rejecting any Host that is not loopback — or the
 * explicitly configured interface — closes that path: a rebinding page's Host never
 * matches, while the operator's own browser sends `127.0.0.1`/`localhost`.
 *
 * Requests with no Host header (HTTP/1.0, some non-browser clients) are allowed through:
 * there is nothing to verify, and curl-style callers are already network-capable.
 */
export function isAllowedHost(request: Request, configuredHost?: string): boolean {
  const raw = request.get('host')?.toLowerCase().trim();
  if (!raw) {
    return true;
  }
  const hostname = stripPort(raw);
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') {
    return true;
  }
  const configured = configuredHost?.toLowerCase().trim();
  if (configured && !isWildcardHost(configured)) {
    if (hostname === stripPort(configured)) {
      return true;
    }
    return false;
  }
  if (configured && isWildcardHost(configured)) {
    // Deliberately exposed: allow direct IP literals (LAN use), still refuse arbitrary
    // DNS names a rebinding page would carry.
    return isIpLiteral(hostname);
  }
  return false;
}

/** Split the port off a Host header value, tolerating bracketed IPv6. */
function stripPort(host: string): string {
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    return close === -1 ? host : host.slice(1, close);
  }
  const colon = host.lastIndexOf(':');
  // A bare IPv6 literal has several colons and no brackets; leave it whole.
  if (colon !== -1 && host.indexOf(':') === colon) {
    return host.slice(0, colon);
  }
  return host;
}

function isWildcardHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '';
}

function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return true;
  }
  return host.includes(':');
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
