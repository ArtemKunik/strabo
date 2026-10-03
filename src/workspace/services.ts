import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { collectSourceFiles, isSourceExtension } from '../scan/scan.ts';
import type { ApiParameter, ServiceCall, ServiceEndpoint, ServiceFlow } from '../types.ts';
import { findContractFiles, resolveSchemaRef } from './contracts.ts';
import { extractRoutesFromContent } from './routes.ts';
import { extractGraphqlEndpoints, extractGrpcEndpoints, graphqlEndpointsFromContent } from './rpc.ts';

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
 * Extract the endpoints a repository declares: its OpenAPI operations, the routes its source
 * registers with a web framework (`./routes.ts`), and its gRPC services and GraphQL root
 * fields (`./rpc.ts`), including GraphQL SDL held in source.
 *
 * A code-declared endpoint has no host, so it joins a same-repository route edge but never a
 * cross-repo flow, which needs a host on both sides.
 */
export function extractServiceEndpoints(root: string, repository: string): ServiceEndpoint[] {
  const endpoints = [
    ...extractOpenApiEndpoints(root, repository),
    ...extractGrpcEndpoints(root, repository),
    ...extractGraphqlEndpoints(root, repository),
  ];
  for (const file of collectSourceFiles(root, [], [])) {
    if (!isSourceExtension(file)) {
      continue;
    }
    const content = readText(root, file);
    if (content !== null) {
      endpoints.push(
        ...codeEndpointsFromContent(repository, file, content),
        ...graphqlEndpointsFromContent(repository, file, content),
      );
    }
  }
  return sortEndpoints(endpoints);
}

/** The routes a repository's source files register, as endpoints with their declaring line. */
export function extractCodeEndpoints(root: string, repository: string): ServiceEndpoint[] {
  const endpoints: ServiceEndpoint[] = [];
  for (const file of collectSourceFiles(root, [], [])) {
    if (!isSourceExtension(file)) {
      continue;
    }
    const content = readText(root, file);
    if (content !== null) {
      endpoints.push(...codeEndpointsFromContent(repository, file, content));
    }
  }
  return sortEndpoints(endpoints);
}

/** The routes one already-read file registers, as endpoints. */
export function codeEndpointsFromContent(repository: string, file: string, content: string): ServiceEndpoint[] {
  return extractRoutesFromContent(file, content).map((route) => ({
    repository,
    source: file,
    method: route.method,
    path: route.path,
    host: null,
    origin: 'code' as const,
    line: route.line,
    framework: route.framework,
    handler: route.handler,
    middleware: route.middleware,
  }));
}

/**
 * Extract the HTTP endpoints a repository declares in its OpenAPI documents.
 *
 * One endpoint per operation (method + path). The path is the first server's path prefix
 * joined to the operation path; the host is that server's host, or null when no server is
 * declared or the URL is templated. A document that does not parse is skipped, never
 * guessed at.
 */
export function extractOpenApiEndpoints(root: string, repository: string): ServiceEndpoint[] {
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
  return sortEndpoints(endpoints);
}

function sortEndpoints(endpoints: ServiceEndpoint[]): ServiceEndpoint[] {
  return endpoints.sort(
    (a, b) =>
      a.repository.localeCompare(b.repository) ||
      a.source.localeCompare(b.source) ||
      a.path.localeCompare(b.path) ||
      a.method.localeCompare(b.method) ||
      (a.line ?? 0) - (b.line ?? 0),
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
      const operation = isRecord(item[method]) ? item[method] : {};
      const operationId = readOperationId(operation);
      const parameters = readParameters(document, item.parameters, operation.parameters);
      const request = resolveSchemaRef(document, mediaSchema(operation.requestBody));
      const response = resolveSchemaRef(document, mediaSchema(firstSuccessResponse(operation.responses)));
      endpoints.push({
        repository,
        source: file,
        method: method.toUpperCase(),
        path: joinPaths(server?.path ?? '', operationPath),
        host: server?.host ?? null,
        origin: 'openapi',
        ...(operationId ? { operationId } : {}),
        ...(request ? { request } : {}),
        ...(response ? { response } : {}),
        ...(parameters.length > 0 ? { parameters } : {}),
      });
    }
  }
  return endpoints;
}

/**
 * The parameters an operation declares, its own overriding the path item's by `in` + `name`.
 * A `$ref` to `components.parameters` is followed in the same document; one that does not
 * resolve is left out rather than guessed at.
 */
function readParameters(document: Record<string, unknown>, ...lists: unknown[]): ApiParameter[] {
  const components = isRecord(document.components) ? document.components : {};
  const shared = isRecord(components.parameters) ? components.parameters : {};
  const byKey = new Map<string, ApiParameter>();
  for (const list of lists) {
    for (const entry of Array.isArray(list) ? list : []) {
      let parameter: unknown = entry;
      if (isRecord(entry) && typeof entry.$ref === 'string') {
        parameter = shared[entry.$ref.split('/').pop() ?? ''];
      }
      if (!isRecord(parameter) || typeof parameter.name !== 'string' || typeof parameter.in !== 'string') {
        continue;
      }
      const schema = isRecord(parameter.schema) ? parameter.schema : parameter;
      byKey.set(`${parameter.in}\u0000${parameter.name}`, {
        name: parameter.name,
        in: parameter.in,
        required: parameter.required === true || parameter.in === 'path',
        type: parameterType(schema),
      });
    }
  }
  return [...byKey.values()].sort((a, b) => a.in.localeCompare(b.in) || a.name.localeCompare(b.name));
}

function parameterType(schema: Record<string, unknown>): string {
  if (schema.type === 'array') {
    return `array<${isRecord(schema.items) ? parameterType(schema.items) : 'unknown'}>`;
  }
  if (typeof schema.type === 'string') {
    return typeof schema.format === 'string' ? `${schema.type}(${schema.format})` : schema.type;
  }
  return typeof schema.$ref === 'string' ? (schema.$ref.split('/').pop() ?? 'unknown') : 'unknown';
}

/** The `operationId` an operation names, or null when it is absent or blank. */
function readOperationId(operation: Record<string, unknown>): string | null {
  return typeof operation.operationId === 'string' && operation.operationId.trim() !== ''
    ? operation.operationId.trim()
    : null;
}

/**
 * The JSON schema of an operation's request body or response, when declared.
 *
 * `application/json` is preferred, and any other media type is a fallback so a `text/json` or
 * vendor type is still read. A body with no schema is `undefined`, never an empty contract.
 */
function mediaSchema(container: unknown): unknown {
  if (!isRecord(container)) {
    return undefined;
  }
  const content = isRecord(container.content) ? container.content : {};
  const media =
    content['application/json'] ?? Object.values(content).find((entry) => isRecord(entry));
  return isRecord(media) ? media.schema : undefined;
}

/** The first 2xx response, which is the success shape an API contract promises. */
function firstSuccessResponse(responses: unknown): unknown {
  if (!isRecord(responses)) {
    return undefined;
  }
  const success = Object.keys(responses)
    .filter((status) => /^2\d\d$/.test(status))
    .sort()[0];
  return success === undefined ? undefined : responses[success];
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
  // A route registration (`app.get('/x', h)`, `@app.get("/x")`) reads like a verb call; it is
  // the declaring side, so its span is kept out of the calls.
  const declared = extractRoutesFromContent(file, content);
  const add = (method: string | null, target: string, index: number): void => {
    if (!isServiceTarget(target) || declared.some((route) => index >= route.start && index < route.end)) {
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
