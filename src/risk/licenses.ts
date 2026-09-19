import type { DependencyEcosystem, LicenseRisk } from '../types.ts';
import type { FetchLike, ResponseCache } from './osv.ts';
import { createResponseCache } from './osv.ts';

export interface DepsDevVersion {
  licenses?: string[];
  advisoryKeys?: Array<{ id?: string }>;
}

export interface LicenseClient {
  /** One entry per request, in the same order; null when the version is unknown or unavailable. */
  lookup(requests: readonly LicenseRequest[]): Promise<Array<DepsDevVersion | null>>;
}

export interface LicenseRequest {
  ecosystem: DependencyEcosystem;
  name: string;
  version: string;
}

const DEPS_DEV_BASE = 'https://api.deps.dev/v3';
const DEPS_SYSTEM: Record<DependencyEcosystem, string> = {
  npm: 'npm',
  maven: 'maven',
  cargo: 'cargo',
};

export interface LicenseClientOptions {
  fetchImpl?: FetchLike;
  cache?: ResponseCache;
  log?: (message: string, error?: unknown) => void;
}

/**
 * deps.dev client.
 *
 * One request per package version, bounded concurrency, and cached. A version with no
 * data is reported as null rather than as an empty license set, so the caller can say
 * "unavailable" instead of implying a license was absent.
 */
export function createLicenseClient(options: LicenseClientOptions = {}): LicenseClient {
  const cache = options.cache ?? createResponseCache();
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const log = options.log;

  async function fetchOne(request: LicenseRequest): Promise<DepsDevVersion | null> {
    const system = DEPS_SYSTEM[request.ecosystem];
    const url = `${DEPS_DEV_BASE}/systems/${system}/packages/${encodeURIComponent(
      request.name,
    )}/versions/${encodeURIComponent(request.version)}`;
    const cached = cache.get(`deps:${url}`);
    if (cached !== null) {
      return cached === false ? null : (cached as DepsDevVersion);
    }
    try {
      const response = await fetchImpl(url);
      if (!response.ok) {
        cache.set(`deps:${url}`, false);
        return null;
      }
      const parsed = (await response.json()) as DepsDevVersion;
      cache.set(`deps:${url}`, parsed);
      return parsed;
    } catch (error) {
      log?.('deps.dev lookup failed', error);
      return null;
    }
  }

  return {
    async lookup(requests: readonly LicenseRequest[]): Promise<Array<DepsDevVersion | null>> {
      const results: Array<DepsDevVersion | null> = new Array(requests.length).fill(null);
      const queue = requests.map((request, index) => ({ request, index }));
      const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
        for (;;) {
          const item = queue.shift();
          if (!item) {
            return;
          }
          results[item.index] = await fetchOne(item.request);
        }
      });
      await Promise.all(workers);
      return results;
    },
  };
}

const PERMISSIVE = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'PostgreSQL',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
]);

const WEAK_COPYLEFT = new Set([
  'CDDL-1.0',
  'EPL-2.0',
  'LGPL-2.1',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MPL-2.0',
]);

const STRONG_COPYLEFT = new Set([
  'AGPL-3.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'GPL-2.0',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'SSPL-1.0',
]);

const RISK_ORDER: LicenseRisk[] = ['permissive', 'weak-copyleft', 'strong-copyleft', 'unknown'];

function classifyAtom(license: string): LicenseRisk {
  const normalized = license.trim();
  if (PERMISSIVE.has(normalized)) {
    return 'permissive';
  }
  if (WEAK_COPYLEFT.has(normalized)) {
    return 'weak-copyleft';
  }
  if (STRONG_COPYLEFT.has(normalized)) {
    return 'strong-copyleft';
  }
  return 'unknown';
}

/**
 * Classify an SPDX expression.
 *
 * `OR` takes the least risky branch because either license may be chosen; `AND` takes the
 * most risky because every branch must be satisfied. Unknown identifiers are never treated
 * as permissive.
 */
export function classifyLicenseExpression(expression: string): LicenseRisk {
  const cleaned = expression.replace(/[()]/g, ' ').trim();
  if (cleaned === '' || /non-standard/i.test(cleaned)) {
    return 'unknown';
  }
  const orParts = splitExpression(cleaned, ' OR ');
  if (orParts.length > 1) {
    return orParts.map(classifyAnd).reduce(lessRisky, 'strong-copyleft');
  }
  return classifyAnd(cleaned);
}

function classifyAnd(expression: string): LicenseRisk {
  const andParts = splitExpression(expression, ' AND ');
  if (andParts.length > 1) {
    return andParts.map(classifyAtom).reduce(moreRisky, 'permissive');
  }
  return classifyAtom(expression);
}

function splitExpression(expression: string, operator: string): string[] {
  return expression
    .split(operator)
    .map((part) => part.trim())
    .filter(Boolean);
}

function moreRisky(a: LicenseRisk, b: LicenseRisk): LicenseRisk {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

function lessRisky(a: LicenseRisk, b: LicenseRisk): LicenseRisk {
  return RISK_ORDER.indexOf(a) <= RISK_ORDER.indexOf(b) ? a : b;
}

const DEFAULT_DENIED = new Set(['AGPL-3.0-only', 'AGPL-3.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later', 'SSPL-1.0']);

/** True when any license in the expression matches the deny policy. */
export function isDeniedLicense(licenses: readonly string[], denied: ReadonlySet<string> = DEFAULT_DENIED): boolean {
  for (const expression of licenses) {
    for (const part of expression.split(/\s+(?:OR|AND|WITH)\s+/)) {
      if (denied.has(part.replace(/[()]/g, '').trim())) {
        return true;
      }
    }
  }
  return false;
}

/** Parse a comma-separated deny policy, falling back to the default strong-copyleft set. */
export function parseDeniedLicenses(value: string | undefined): Set<string> {
  if (!value) {
    return DEFAULT_DENIED;
  }
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? new Set(entries) : DEFAULT_DENIED;
}
