import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { collectSourceFiles, isSourceExtension } from '../scan/scan.ts';
import type { ServiceCall, ServiceEndpoint, ServiceFlow } from '../types.ts';
import { findContractFiles } from './contracts.ts';

const MAX_BYTES = 2 * 1024 * 1024;

/** OpenAPI path-item keys that name an operation. */
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const;

/**
 * A call whose callee names an HTTP verb and whose first argument is a string literal.
 *
 * This is deliberately lexical, like `collectPolyglotExternalImports`: the target must look
 * like a URL or an absolute path, which keeps an ordinary `map.get('key')` out. It does not
 * read an AST, so a verb call on a non-HTTP object with a path-like key can still be
 * recorded; that limit is named in the roadmap.
 */
const VERB_CALL = /\b(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])([^'"`\n]+)\2/g;
const FETCH_CALL = /\bfetch\s*\(\s*(['"`])([^'"`\n]+)\1/g;
const REQUEST_CALL = /\brequest\s*\(\s*(['"])([A-Za-z]+)\1\s*,\s*(['"])([^'"\n]+)\3/g;
const ASYNC_CALL = /\b(GetAsync|PostAsync|PutAsync|PatchAsync|DeleteAsync|SendAsync)\s*\(\s*"([^"\n]+)"/g;
const OKHTTP_URL = /\.url\s*\(\s*"([^"\n]+)"/g;
const URI_CREATE = /\bURI\.create\s*\(\s*"([^"\n]+)"/g;

/**
 * Extract the HTTP endpoints a repository declares in its OpenAPI documents.
 *
 * One endpoint per operation (method + path). The path is the first server's path prefix
 * joined to the operation path; the host is that server's host, or null when no server is
 * declared or the URL is templated. A document that does not parse is skipped, never
 * guessed at.
 */
export function extractServiceEndpoints(root: string, repository: string): ServiceEndpoint[] {
  const endpoints: ServiceEndpoint[] = [];
  for (const file of findContractFiles(root)) {
    const extension = path.extname(file).toLowerCase();
    if (extension === '.proto') {
      continue;
    }
    const content = readText(root, file);
    if (content === null) {
      continue;
    }
    let document: unknown;
    try {
      document = extension === '.json' ? JSON.parse(content) : parseYaml(content);
    } catch {
      continue;
    }
    if (!isRecord(document) || !('openapi' in document || 'swagger' in document)) {
      continue;
    }
    endpoints.push(...parseOpenApiEndpoints(repository, file, document));
  }
  return endpoints.sort(
    (a, b) =>
      a.repository.localeCompare(b.repository) ||
      a.source.localeCompare(b.source) ||
      a.path.localeCompare(b.path) ||
      a.method.localeCompare(b.method),
  );
}

function parseOpenApiEndpoints(
  repository: string,
  file: string,
  document: Record<string, unknown>,
): ServiceEndpoint[] {
  const paths = isRecord(document.paths) ? document.paths : {};
  const server = readServer(document);
  const endpoints: ServiceEndpoint[] = [];
  for (const [operationPath, item] of Object.entries(paths)) {
    if (!isRecord(item)) {
      continue;
    }
    for (const method of HTTP_METHODS) {
      if (!(method in item)) {
        continue;
      }
      endpoints.push({
        repository,
        source: file,
        method: method.toUpperCase(),
        path: joinPaths(server?.path ?? '', operationPath),
        host: server?.host ?? null,
      });
    }
  }
  return endpoints;
}

/** The first server URL (OpenAPI 3) or `host` + `basePath` (Swagger 2), if any. */
function readServer(document: Record<string, unknown>): { host: string | null; path: string } | null {
  const servers = Array.isArray(document.servers) ? document.servers : [];
  const first = servers.find(isRecord);
  if (first && typeof first.url === 'string') {
    return locateServer(first.url);
  }
  if (typeof document.host === 'string' && document.host.trim() !== '') {
    const scheme =
      Array.isArray(document.schemes) && typeof document.schemes[0] === 'string'
        ? document.schemes[0]
        : 'https';
    const basePath = typeof document.basePath === 'string' ? document.basePath : '';
    return locateServer(`${scheme}://${document.host}${basePath}`);
  }
  return null;
}

function locateServer(url: string): { host: string | null; path: string } {
  if (url.includes('{')) {
    return { host: null, path: '' };
  }
  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      return { host: parsed.host.toLowerCase(), path: normalizePath(parsed.pathname) };
    } catch {
      return { host: null, path: '' };
    }
  }
  return { host: null, path: normalizePath(url) };
}

/**
 * Record outbound HTTP calls from a repository's source.
 *
 * Only calls that name a verb and pass a string-literal URL or absolute path are recorded.
 * A relative target has no host, and an interpolated template literal has no readable path;
 * both are kept as evidence with `host`/`path` null rather than dropped, but they cannot
 * join a cross-repo flow.
 */
export function extractServiceCalls(root: string): ServiceCall[] {
  const calls: ServiceCall[] = [];
  for (const file of collectSourceFiles(root, [], [])) {
    if (!isSourceExtension(file)) {
      continue;
    }
    const content = readText(root, file);
    if (content === null) {
      continue;
    }
    calls.push(...extractCallsFromContent(file, content));
  }
  return dedupeCalls(calls);
}

/**
 * Record the outbound HTTP calls in one already-read file.
 *
 * Shared with the tier trace, which reads each classified file once and must not walk the
 * tree again to find its calls.
 */
export function extractCallsFromContent(file: string, content: string): ServiceCall[] {
  const calls: ServiceCall[] = [];
  const add = (method: string | null, target: string, index: number): void => {
    if (!isServiceTarget(target)) {
      return;
    }
    const located = locateTarget(target);
    calls.push({
      file,
      line: lineOf(content, index),
      method,
      target,
      host: located.host,
      path: located.path,
    });
  };

  for (const match of content.matchAll(VERB_CALL)) {
    add((match[1] ?? '').toUpperCase(), match[3] ?? '', match.index ?? 0);
  }
  for (const match of content.matchAll(FETCH_CALL)) {
    add(fetchMethod(content, (match.index ?? 0) + match[0].length), match[2] ?? '', match.index ?? 0);
  }
  for (const match of content.matchAll(REQUEST_CALL)) {
    add((match[2] ?? '').toUpperCase(), match[4] ?? '', match.index ?? 0);
  }
  for (const match of content.matchAll(ASYNC_CALL)) {
    const verb = (match[1] ?? '').replace(/Async$/, '').toUpperCase();
    add(verb === 'SEND' ? null : verb, match[2] ?? '', match.index ?? 0);
  }
  for (const match of content.matchAll(OKHTTP_URL)) {
    add(null, match[1] ?? '', match.index ?? 0);
  }
  for (const match of content.matchAll(URI_CREATE)) {
    add(null, match[1] ?? '', match.index ?? 0);
  }
  return calls;
}

/** `fetch(url)` defaults to GET; `fetch(url, { method: 'POST' })` names its own. */
function fetchMethod(content: string, afterIndex: number): string {
  const rest = content.slice(afterIndex, afterIndex + 200);
  const match = /^\s*,\s*\{[^}]*?\bmethod\s*:\s*(['"])([A-Za-z]+)\1/.exec(rest);
  return match?.[2]?.toUpperCase() ?? 'GET';
}

function isServiceTarget(target: string): boolean {
  return /^https?:\/\//i.test(target) || target.startsWith('/');
}

/** Split a target into a host and a normalised path, or nulls when it cannot be read. */
export function locateTarget(target: string): { host: string | null; path: string | null } {
  if (target.includes('${')) {
    return { host: null, path: null };
  }
  if (/^https?:\/\//i.test(target)) {
    try {
      const parsed = new URL(target);
      return { host: parsed.host.toLowerCase(), path: normalizePath(parsed.pathname) };
    } catch {
      return { host: null, path: null };
    }
  }
  if (target.startsWith('/')) {
    return { host: null, path: normalizePath(target) };
  }
  return { host: null, path: null };
}

/** The per-repository facts a service flow is resolved from. */
export interface RepoServiceFact {
  name: string;
  endpoints: ServiceEndpoint[];
  calls: ServiceCall[];
}

/**
 * Resolve cross-repo service flows from recorded calls and declared endpoints.
 *
 * A flow exists when a call in repository A and an endpoint declared by repository B agree
 * on host, path, and method. Host and path must both be recorded on both sides: a relative
 * call or an endpoint with no server has no host to match, so it is never joined. A call
 * whose method is not recorded joins only when that host and path declares exactly one
 * method, so an ambiguous call is not split across methods. A repository's own call to its
 * own endpoint is not a cross-repo flow.
 */
export function computeServiceFlows(facts: RepoServiceFact[]): ServiceFlow[] {
  const endpointsByLocation = new Map<string, ServiceEndpoint[]>();
  for (const fact of facts) {
    for (const endpoint of fact.endpoints) {
      if (endpoint.host === null) {
        continue;
      }
      const key = locationKey(endpoint.host, endpoint.path);
      const list = endpointsByLocation.get(key) ?? [];
      list.push(endpoint);
      endpointsByLocation.set(key, list);
    }
  }

  const flows: ServiceFlow[] = [];
  for (const consumer of facts) {
    const byTarget = new Map<string, ServiceFlow>();
    for (const call of consumer.calls) {
      if (call.host === null || call.path === null) {
        continue;
      }
      const candidates = endpointsByLocation.get(locationKey(call.host, call.path)) ?? [];
      for (const endpoint of matchByMethod(candidates, call.method)) {
        if (endpoint.host === null || endpoint.repository === consumer.name) {
          continue;
        }
        const key = `${consumer.name}\u0000${endpoint.repository}\u0000${endpoint.method}\u0000${endpoint.host}\u0000${endpoint.path}`;
        let flow = byTarget.get(key);
        if (!flow) {
          flow = {
            from: consumer.name,
            to: endpoint.repository,
            method: endpoint.method,
            path: endpoint.path,
            host: endpoint.host,
            calls: [],
            declaredBy: endpoint.source,
          };
          byTarget.set(key, flow);
        }
        flow.calls.push({ file: call.file, line: call.line, target: call.target, method: call.method });
      }
    }
    for (const flow of byTarget.values()) {
      flow.calls = dedupeCalls(flow.calls);
      flows.push(flow);
    }
  }

  return flows.sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      a.method.localeCompare(b.method) ||
      a.path.localeCompare(b.path),
  );
}

function matchByMethod(candidates: ServiceEndpoint[], method: string | null): ServiceEndpoint[] {
  if (method !== null) {
    return candidates.filter((endpoint) => endpoint.method === method);
  }
  return candidates.length === 1 ? candidates : [];
}

function locationKey(host: string, requestPath: string): string {
  return `${host}\u0000${requestPath}`;
}

function joinPaths(prefix: string, operationPath: string): string {
  const trimmed = prefix.replace(/\/+$/, '');
  return normalizePath(`${trimmed}${operationPath}`);
}

function normalizePath(value: string): string {
  let normalized = value.split(/[?#]/)[0] ?? value;
  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }
  normalized = normalized.replace(/\/{2,}/g, '/');
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/, '');
  }
  return normalized;
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (content.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function dedupeCalls<T extends { file: string; line: number }>(calls: T[]): T[] {
  const seen = new Set<string>();
  return calls
    .filter((call) => {
      const key = JSON.stringify(call);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(root: string, file: string): string | null {
  try {
    const absolute = path.join(root, file);
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_BYTES) {
      return null;
    }
    const content = fs.readFileSync(absolute);
    return content.includes(0) ? null : content.toString('utf8');
  } catch {
    return null;
  }
}
