import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DependencyEcosystem } from '../types.ts';

/** Injected fetch, so tests never touch the network. Matches the global `fetch` shape. */
export type FetchLike = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

/** A tiny JSON cache for advisory and license responses. */
export interface ResponseCache {
  get(key: string): unknown | null;
  set(key: string, value: unknown): void;
}

export interface RiskCacheOptions {
  dir?: string;
  ttlMs?: number;
  now?: () => number;
}

/** Risk responses live beside the scan cache, never inside the scanned repository. */
export function riskCacheDir(): string {
  const configured = process.env.STRABO_CACHE_DIR?.trim();
  return path.join(configured ? path.resolve(configured) : path.join(os.tmpdir(), 'strabo-cache'), 'risk');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * A best-effort on-disk JSON cache.
 *
 * A missing, corrupt, or unreadable entry is a miss, never an error: the cache must not be
 * able to fail a risk lookup. Entries carry a fetch timestamp so stale data expires.
 */
export function createResponseCache(options: RiskCacheOptions = {}): ResponseCache {
  const dir = options.dir ?? riskCacheDir();
  const ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000;
  const now = options.now ?? Date.now;

  return {
    get(key: string): unknown | null {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, `${hash(key)}.json`), 'utf8')) as {
          fetchedAt: number;
          value: unknown;
        };
        if (typeof parsed.fetchedAt !== 'number' || now() - parsed.fetchedAt > ttlMs) {
          return null;
        }
        return parsed.value;
      } catch {
        return null;
      }
    },
    set(key: string, value: unknown): void {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const target = path.join(dir, `${hash(key)}.json`);
        const temporary = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({ fetchedAt: now(), value }));
        fs.renameSync(temporary, target);
      } catch {
        // Caching is best-effort.
      }
    },
  };
}

export interface OsvQuery {
  ecosystem: DependencyEcosystem;
  name: string;
  version: string;
}

export interface OsvVulnerability {
  id: string;
  aliases?: string[];
  summary?: string;
  severity?: Array<{ type?: string; score?: string }>;
  database_specific?: { severity?: string };
  affected?: Array<{
    ranges?: Array<{ events?: Array<{ fixed?: string }> }>;
  }>;
  references?: Array<{ type?: string; url?: string }>;
}

export interface OsvClient {
  /** One entry per query, in the same order. */
  query(queries: readonly OsvQuery[]): Promise<OsvVulnerability[][]>;
}

const OSV_BASE = 'https://api.osv.dev';
const OSV_ECOSYSTEM: Record<DependencyEcosystem, string> = {
  npm: 'npm',
  maven: 'Maven',
  cargo: 'crates.io',
};
const OSV_BATCH_LIMIT = 1000;
const MAX_VULN_LOOKUPS = 300;

export interface OsvClientOptions {
  fetchImpl?: FetchLike;
  cache?: ResponseCache;
  log?: (message: string, error?: unknown) => void;
}

/**
 * OSV.dev client.
 *
 * Uses `/v1/querybatch` to match many packages in one request, then fetches the full record
 * for each distinct advisory id (the batch response carries ids only). Both layers are
 * cached. A query with no exact version is skipped rather than fuzzy-matched.
 */
export function createOsvClient(options: OsvClientOptions = {}): OsvClient {
  const cache = options.cache ?? createResponseCache();
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const log = options.log;

  return {
    async query(queries: readonly OsvQuery[]): Promise<OsvVulnerability[][]> {
      // Only an exact version can be matched; a range would be a fuzzy guess.
      const usable = queries
        .map((entry, original) => ({ entry, original }))
        .filter(({ entry }) => entry.version !== '');
      if (usable.length === 0) {
        return queries.map(() => []);
      }

      const results: OSV_ID[][] = [];
      for (let index = 0; index < usable.length; index += OSV_BATCH_LIMIT) {
        const chunk = usable.slice(index, index + OSV_BATCH_LIMIT).map(({ entry }) => entry);
        results.push(...(await queryBatch(chunk)));
      }

      const uniqueIds = [...new Set(results.flat().map((entry) => entry.id))];
      if (uniqueIds.length > MAX_VULN_LOOKUPS) {
        log?.('OSV vulnerability lookup truncated', `${uniqueIds.length} ids, capped at ${MAX_VULN_LOOKUPS}`);
      }
      const truncated = uniqueIds.slice(0, MAX_VULN_LOOKUPS);
      const details = await lookupMany(truncated);

      const byOriginal = new Map<number, OsvVulnerability[]>();
      usable.forEach(({ original }, index) => {
        const ids = results[index] ?? [];
        byOriginal.set(
          original,
          ids.map((entry) => details.get(entry.id) ?? { id: entry.id }).filter(isVulnerability),
        );
      });
      return queries.map((_, index) => byOriginal.get(index) ?? []);
    },
  };

  function isVulnerability(value: OsvVulnerability | undefined): value is OsvVulnerability {
    return value !== undefined;
  }

  interface OSV_ID {
    id: string;
  }

  async function queryBatch(chunk: readonly OsvQuery[]): Promise<OSV_ID[][]> {
    const body = JSON.stringify({
      queries: chunk.map((entry) => ({
        package: { name: entry.name, ecosystem: OSV_ECOSYSTEM[entry.ecosystem] },
        version: entry.version,
      })),
    });
    const key = `osv-batch:${body}`;
    const cached = cache.get(key);
    if (Array.isArray(cached)) {
      return cached as OSV_ID[][];
    }
    try {
      const response = await fetchImpl(`${OSV_BASE}/v1/querybatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      if (!response.ok) {
        log?.('OSV querybatch failed', `HTTP ${response.status}`);
        return chunk.map(() => []);
      }
      const parsed = (await response.json()) as { results?: Array<{ vulns?: OSV_ID[] }> };
      const out = chunk.map((_, index) => parsed.results?.[index]?.vulns ?? []);
      cache.set(key, out);
      return out;
    } catch (error) {
      log?.('OSV querybatch error', error);
      return chunk.map(() => []);
    }
  }

  async function lookupMany(ids: readonly string[]): Promise<Map<string, OsvVulnerability>> {
    const results = new Map<string, OsvVulnerability>();
    const pending: string[] = [];
    for (const id of ids) {
      const cached = cache.get(`osv:${id}`);
      if (cached && typeof cached === 'object') {
        results.set(id, cached as OsvVulnerability);
      } else {
        pending.push(id);
      }
    }
    const queue = [...pending];
    const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
      for (;;) {
        const id = queue.shift();
        if (!id) {
          return;
        }
        const record = await lookup(id);
        if (record) {
          results.set(id, record);
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  async function lookup(id: string): Promise<OsvVulnerability | null> {
    try {
      const response = await fetchImpl(`${OSV_BASE}/v1/vulns/${id}`);
      if (!response.ok) {
        return null;
      }
      const parsed = (await response.json()) as OsvVulnerability;
      cache.set(`osv:${id}`, parsed);
      return parsed;
    } catch {
      return null;
    }
  }
}

/** Normalise an OSV severity, preferring the GHSA database label over a CVSS vector. */
export function normalizeSeverity(vulnerability: OsvVulnerability): 'low' | 'moderate' | 'high' | 'critical' | 'unknown' {
  const label = vulnerability.database_specific?.severity?.toUpperCase();
  switch (label) {
    case 'LOW':
      return 'low';
    case 'MODERATE':
    case 'MEDIUM':
      return 'moderate';
    case 'HIGH':
      return 'high';
    case 'CRITICAL':
      return 'critical';
    default:
      return 'unknown';
  }
}

/** The versions an advisory records as fixed, deduplicated and sorted. */
export function fixedVersions(vulnerability: OsvVulnerability): string[] {
  const fixed = new Set<string>();
  for (const affected of vulnerability.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.fixed) {
          fixed.add(event.fixed);
        }
      }
    }
  }
  return [...fixed].sort();
}
