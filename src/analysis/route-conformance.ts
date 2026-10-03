import path from 'node:path';

import { isTestLike } from '../scan/scan.ts';
import type { Graph, ServiceEndpoint } from '../types.ts';
import { codeEndpointsFromContent, extractOpenApiEndpoints } from '../workspace/services.ts';
import { readWorkingFile } from './git-content.ts';

/**
 * Spec ↔ code conformance (Phase 38 R2): the OpenAPI operations a repository documents against
 * the routes its source registers.
 *
 * Both sides are recorded facts (`extractOpenApiEndpoints`, `codeEndpointsFromContent`), so the
 * comparison only names what both readers saw. An operation and a route are joined, in order:
 *
 * 1. **exact** — the same method and path;
 * 2. **parameters** — the same method and path once parameter names are erased
 *    (`/users/{id}` and `/users/{userId}`), which is named, since a client may care;
 * 3. **prefix** — the same method, and one path is the other plus a leading prefix, when that
 *    prefix is the one most such pairs share (a server base such as `/v1`, or a mount such as
 *    `app.use('/api', router)` the route reader does not follow). A one-off prefix is never
 *    used, so `/users` is not joined to `/admin/users` by accident.
 *
 * A document none of whose operations joins a route is listed as describing another service
 * (a vendored client spec) and stays out of the unimplemented list. Test files are not read
 * as the code side, since they register mock servers.
 */

export type RouteMatchKind = 'exact' | 'parameters' | 'prefix';

export interface RouteConformanceMatch {
  method: string;
  /** The documented path. */
  path: string;
  /** The path the code registers, when it differs from the documented one. */
  codePath: string;
  via: RouteMatchKind;
  /** The leading prefix one side adds, for a `prefix` join (`spec` adds it, or `code` does). */
  prefix?: { side: 'spec' | 'code'; value: string };
  spec: { file: string; operationId?: string };
  code: { file: string; line: number; framework: string; handler: string | null };
}

export interface UndocumentedRoute {
  method: string;
  path: string;
  file: string;
  line: number;
  framework: string;
  handler: string | null;
  /** Methods the documents list for this path, so a method mismatch reads as one. */
  documentedMethods: string[];
}

export interface UnimplementedOperation {
  method: string;
  path: string;
  file: string;
  operationId?: string;
  /** Methods the code registers for this path, so a method mismatch reads as one. */
  registeredMethods: string[];
}

export interface RouteDocumentSummary {
  file: string;
  operations: number;
  matched: number;
  /** `another-service` when none of its operations joins a route in this repository. */
  describes: 'this-repository' | 'another-service';
}

export interface RouteConformanceReport {
  available: boolean;
  reason?: string;
  documents: RouteDocumentSummary[];
  matched: RouteConformanceMatch[];
  undocumented: UndocumentedRoute[];
  unimplemented: UnimplementedOperation[];
  totals: {
    operations: number;
    routes: number;
    matched: number;
    undocumented: number;
    unimplemented: number;
  };
}

/** Compare the repository's OpenAPI operations with the routes its scanned source registers. */
export function computeRouteConformance(root: string, graph: Graph): RouteConformanceReport {
  const repository = path.basename(root);
  const operations = extractOpenApiEndpoints(root, repository);
  const routes: ServiceEndpoint[] = [];
  for (const node of graph.nodes) {
    if (isTestLike(node.id)) {
      continue;
    }
    const content = readWorkingFile(root, node.id);
    if (content !== null) {
      routes.push(...codeEndpointsFromContent(repository, node.id, content));
    }
  }
  return compareRoutes(operations, routes);
}

/** The pure half: join documented operations to registered routes. */
export function compareRoutes(
  operations: readonly ServiceEndpoint[],
  routes: readonly ServiceEndpoint[],
): RouteConformanceReport {
  const totals = {
    operations: operations.length,
    routes: routes.length,
    matched: 0,
    undocumented: 0,
    unimplemented: 0,
  };
  const empty = { documents: [], matched: [], undocumented: [], unimplemented: [] };
  if (operations.length === 0) {
    return { available: false, reason: 'no OpenAPI document declares an operation', ...empty, totals };
  }
  if (routes.length === 0) {
    return {
      available: false,
      reason: 'no route registration was read in code (see the supported frameworks in docs/FEATURES.md)',
      ...empty,
      totals,
    };
  }

  const specUsed = new Set<number>();
  const codeUsed = new Set<number>();
  const matched: RouteConformanceMatch[] = [];
  const join = (s: number, c: number, via: RouteMatchKind, prefix?: RouteConformanceMatch['prefix']): void => {
    const operation = operations[s] as ServiceEndpoint;
    const route = routes[c] as ServiceEndpoint;
    specUsed.add(s);
    codeUsed.add(c);
    matched.push({
      method: operation.method,
      path: operation.path,
      codePath: route.path,
      via,
      ...(prefix ? { prefix } : {}),
      spec: { file: operation.source, ...(operation.operationId ? { operationId: operation.operationId } : {}) },
      code: {
        file: route.source,
        line: route.line ?? 1,
        framework: route.framework ?? 'code',
        handler: route.handler ?? null,
      },
    });
  };

  // Passes 1 and 2: the same method and path, then the same shape. Every registration of the
  // key is consumed, so a route registered twice is not also reported as undocumented.
  for (const [via, keyOf] of [
    ['exact', (endpoint: ServiceEndpoint) => `${endpoint.method} ${endpoint.path}`],
    ['parameters', (endpoint: ServiceEndpoint) => `${endpoint.method} ${shape(endpoint.path)}`],
  ] as const) {
    const codeByKey = indexBy(routes, keyOf, codeUsed);
    operations.forEach((operation, s) => {
      if (specUsed.has(s)) {
        return;
      }
      const candidates = (codeByKey.get(keyOf(operation)) ?? []).filter((c) => !codeUsed.has(c));
      if (candidates.length === 0) {
        return;
      }
      join(s, candidates[0] as number, via);
      for (const c of candidates) {
        codeUsed.add(c);
      }
    });
  }

  // Pass 3: a shared leading prefix, accepted only when it is the dominant one.
  const pairs: Array<{ s: number; c: number; side: 'spec' | 'code'; value: string }> = [];
  operations.forEach((operation, s) => {
    if (specUsed.has(s)) {
      return;
    }
    routes.forEach((route, c) => {
      if (codeUsed.has(c) || route.method !== operation.method) {
        return;
      }
      const specShape = shape(operation.path);
      const codeShape = shape(route.path);
      const specExtra = leadingPrefix(specShape, codeShape);
      if (specExtra !== null) {
        pairs.push({ s, c, side: 'spec', value: operation.path.slice(0, prefixLength(operation.path, specExtra)) });
      }
      const codeExtra = leadingPrefix(codeShape, specShape);
      if (codeExtra !== null) {
        pairs.push({ s, c, side: 'code', value: route.path.slice(0, prefixLength(route.path, codeExtra)) });
      }
    });
  });
  const dominant = dominantPrefix(pairs);
  if (dominant !== null) {
    const chosen = pairs.filter((pair) => pair.side === dominant.side && pair.value === dominant.value);
    const perSpec = countBy(chosen.map((pair) => pair.s));
    const perCode = countBy(chosen.map((pair) => pair.c));
    for (const pair of chosen) {
      // One candidate on each side, or the join is a guess.
      if (perSpec.get(pair.s) === 1 && perCode.get(pair.c) === 1) {
        join(pair.s, pair.c, 'prefix', { side: pair.side, value: pair.value });
      }
    }
  }

  // Documents with no joined operation describe something else; leave them out of the gaps.
  const documents = summariseDocuments(operations, specUsed);
  if (documents.every((document) => document.describes === 'another-service')) {
    return {
      available: false,
      reason:
        'no OpenAPI operation matched a route registered in code; the documents may describe another service, or the routes are mounted under a prefix the reader does not follow',
      ...empty,
      documents,
      totals,
    };
  }
  const foreign = new Set(
    documents.filter((document) => document.describes === 'another-service').map((document) => document.file),
  );

  const documentedMethods = methodsByShape(operations.filter((operation) => !foreign.has(operation.source)));
  const registeredMethods = methodsByShape(routes);
  const undocumented: UndocumentedRoute[] = routes
    .filter((_, c) => !codeUsed.has(c))
    .map((route) => ({
      method: route.method,
      path: route.path,
      file: route.source,
      line: route.line ?? 1,
      framework: route.framework ?? 'code',
      handler: route.handler ?? null,
      documentedMethods: documentedMethods.get(shape(route.path)) ?? [],
    }));
  const unimplemented: UnimplementedOperation[] = operations
    .filter((operation, s) => !specUsed.has(s) && !foreign.has(operation.source))
    .map((operation) => ({
      method: operation.method,
      path: operation.path,
      file: operation.source,
      ...(operation.operationId ? { operationId: operation.operationId } : {}),
      registeredMethods: registeredMethods.get(shape(operation.path)) ?? [],
    }));

  const byRoute = (a: { path: string; method: string }, b: { path: string; method: string }): number =>
    a.path.localeCompare(b.path) || a.method.localeCompare(b.method);
  matched.sort(byRoute);
  undocumented.sort((a, b) => byRoute(a, b) || a.file.localeCompare(b.file) || a.line - b.line);
  unimplemented.sort((a, b) => byRoute(a, b) || a.file.localeCompare(b.file));

  return {
    available: true,
    documents,
    matched,
    undocumented,
    unimplemented,
    totals: {
      ...totals,
      matched: matched.length,
      undocumented: undocumented.length,
      unimplemented: unimplemented.length,
    },
  };
}

/** A path with its parameter names erased, so `{id}` and `{userId}` compare. */
function shape(routePath: string): string {
  return routePath.replace(/\{[^}]*\}/g, '{}');
}

/** The segments `longer` has before it ends with `shorter`, or null when it does not. */
function leadingPrefix(longer: string, shorter: string): string | null {
  if (longer === shorter || shorter === '/') {
    return null;
  }
  return longer.endsWith(shorter) && longer[longer.length - shorter.length] === '/'
    ? longer.slice(0, longer.length - shorter.length)
    : null;
}

/** The length in `original` of a prefix measured on its shape (parameter names may differ). */
function prefixLength(original: string, shapedPrefix: string): number {
  const segments = shapedPrefix.split('/').length - 1;
  let index = 0;
  for (let seen = 0; seen < segments; seen += 1) {
    index = original.indexOf('/', index + 1);
    if (index === -1) {
      return original.length;
    }
  }
  return index;
}

function dominantPrefix(
  pairs: ReadonlyArray<{ side: 'spec' | 'code'; value: string }>,
): { side: 'spec' | 'code'; value: string } | null {
  const counts = new Map<string, number>();
  for (const pair of pairs) {
    const key = `${pair.side}\u0000${pair.value}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = ranked[0];
  // A prefix seen once could be a coincidence; a base or mount repeats across routes, unless
  // there is only the one candidate pair to read.
  if (!top || (top[1] < 2 && pairs.length > 1)) {
    return null;
  }
  const [side, value] = top[0].split('\u0000') as ['spec' | 'code', string];
  return { side, value };
}

function summariseDocuments(operations: readonly ServiceEndpoint[], used: ReadonlySet<number>): RouteDocumentSummary[] {
  const byFile = new Map<string, { operations: number; matched: number }>();
  operations.forEach((operation, s) => {
    const entry = byFile.get(operation.source) ?? { operations: 0, matched: 0 };
    entry.operations += 1;
    if (used.has(s)) {
      entry.matched += 1;
    }
    byFile.set(operation.source, entry);
  });
  return [...byFile.entries()]
    .map(([file, entry]) => ({
      file,
      ...entry,
      describes: entry.matched > 0 ? ('this-repository' as const) : ('another-service' as const),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

function methodsByShape(endpoints: readonly ServiceEndpoint[]): Map<string, string[]> {
  const methods = new Map<string, Set<string>>();
  for (const endpoint of endpoints) {
    const key = shape(endpoint.path);
    const set = methods.get(key) ?? new Set<string>();
    set.add(endpoint.method);
    methods.set(key, set);
  }
  return new Map([...methods.entries()].map(([key, set]) => [key, [...set].sort()]));
}

function indexBy(
  endpoints: readonly ServiceEndpoint[],
  keyOf: (endpoint: ServiceEndpoint) => string,
  skip: ReadonlySet<number>,
): Map<string, number[]> {
  const index = new Map<string, number[]>();
  endpoints.forEach((endpoint, position) => {
    if (skip.has(position)) {
      return;
    }
    const key = keyOf(endpoint);
    index.set(key, [...(index.get(key) ?? []), position]);
  });
  return index;
}

function countBy(values: readonly number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}
