import path from 'node:path';

import { isTestLike } from '../scan/scan.ts';
import type { ApiParameter, ApiSchemaRef, DataAccess, Graph, ServiceCall, ServiceEndpoint } from '../types.ts';
import { extractDataUsesFromSource } from '../workspace/data-usage.ts';
import {
  callReaches,
  extractGraphqlEndpoints,
  extractGrpcEndpoints,
  findGraphqlFiles,
  graphqlEndpointsFromContent,
  implementationPattern,
  rpcCallsFromContent,
  type RpcCall,
} from '../workspace/rpc.ts';
import { codeEndpointsFromContent, extractCallsFromContent, extractOpenApiEndpoints } from '../workspace/services.ts';
import { buildAdjacency } from './analysis.ts';
import { computeDetailedTestReachByFile } from './coverage.ts';
import { readWorkingFile } from './git-content.ts';
import { compareRoutes } from './route-conformance.ts';

/**
 * The repository's HTTP endpoints, one entry per route, and the passport of one (Phase 38 R4).
 *
 * An entry joins what is recorded about a route: its OpenAPI operation and its registration
 * in code (joined as the conformance reading joins them), the handler and the file it lives in,
 * the middleware and decorators in front of it, the literal calls that reach it, and the tests
 * that call it or import their way to its handler. The passport adds the declared parameters
 * and bodies, and the files and tables within a few import hops of the handler.
 *
 * gRPC rpcs and GraphQL root fields are endpoints too, each its own entry: its handler is the
 * file that implements the service or resolves the field by convention, and its callers are
 * stub calls and GraphQL selections. Their guards (interceptors, directives) are not read.
 *
 * Every fact is lexical or an import edge, and is named that way: a guard is read from the
 * names in front of the handler, so global middleware (`app.use(auth)`) is not seen and an
 * endpoint with no such name reads `none-recorded`, never "unprotected"; a test that reaches the
 * handler file reaches it by import, which says it can exercise the route, not that it does.
 */

export type GuardStatus = 'guarded' | 'anonymous' | 'none-recorded';

export interface EndpointSite {
  file: string;
  line: number;
}

export interface EndpointDeclaration {
  origin: 'openapi' | 'code' | 'proto' | 'graphql';
  file: string;
  line: number | null;
  path: string;
  framework: string | null;
  handler: string | null;
  operationId?: string;
}

export interface EndpointSummary {
  /** `http`, `grpc`, or `graphql`. */
  protocol: 'http' | 'grpc' | 'graphql';
  method: string;
  /** The documented path when the route is documented, else the path the code registers. */
  path: string;
  declarations: EndpointDeclaration[];
  /** The file the handler lives in, and how it was found. */
  handler: {
    name: string | null;
    file: string | null;
    basis: 'import' | 'same-file' | 'declaring-file' | 'implementation' | 'none';
  };
  guard: { status: GuardStatus; evidence: string[] };
  tests: {
    /** Literal calls to the route from test files. */
    calls: EndpointSite[];
    /** Test files that import their way to the handler file, nearest first. */
    reaching: string[];
  };
  tested: boolean;
  /** Literal calls to the route from non-test source. */
  callers: EndpointSite[];
}

export interface EndpointsReport {
  available: boolean;
  reason?: string;
  endpoints: EndpointSummary[];
  totals: {
    endpoints: number;
    byProtocol: { http: number; grpc: number; graphql: number };
    /** HTTP endpoints documented with no route registered in code. */
    documentedOnly: number;
    /** The counts below read HTTP routes registered in code. */
    untested: number;
    guarded: number;
    anonymous: number;
    noGuardRecorded: number;
  };
}

export interface EndpointPassport extends EndpointSummary {
  available: true;
  parameters: ApiParameter[];
  request: ApiSchemaRef | null;
  response: ApiSchemaRef | null;
  middleware: string[];
  downstream: {
    /** Import hops followed from the handler file. */
    depth: number;
    files: string[];
    tables: Array<{ table: string; access: DataAccess; file: string; line: number }>;
  };
}

const DOWNSTREAM_DEPTH = 3;
const REACHING_TESTS = 10;

/** Names that read as an authorisation guard, and names that explicitly opt out of one. */
const GUARD_NAME =
  /auth|guard|login|permission|role|secur|jwt|token|protect|acl|policy|admin|scope|session|signed_?in|requires?_?user|RequireAuthorization/i;
const ANONYMOUS_NAME = /AllowAnonymous|permitAll|\bPublic\b|SkipAuth|NoAuth|anonymous/i;

/** Classify a route's middleware: an explicit opt-out wins over a guard. */
export function guardStatus(middleware: readonly string[]): { status: GuardStatus; evidence: string[] } {
  const anonymous = middleware.filter((name) => ANONYMOUS_NAME.test(name));
  if (anonymous.length > 0) {
    return { status: 'anonymous', evidence: anonymous };
  }
  const guards = middleware.filter((name) => GUARD_NAME.test(name));
  return guards.length > 0 ? { status: 'guarded', evidence: guards } : { status: 'none-recorded', evidence: [] };
}

interface Facts {
  operations: ServiceEndpoint[];
  routes: ServiceEndpoint[];
  /** gRPC rpcs (and their gateway routes) and GraphQL root fields. */
  surfaces: ServiceEndpoint[];
  calls: ServiceCall[];
  rpcCalls: RpcCall[];
  contents: Map<string, string>;
}

function readFacts(root: string, graph: Graph): Facts {
  const repository = path.basename(root);
  const contents = new Map<string, string>();
  const routes: ServiceEndpoint[] = [];
  const calls: ServiceCall[] = [];
  const rpcCalls: RpcCall[] = [];
  const surfaces: ServiceEndpoint[] = [...extractGrpcEndpoints(root, repository), ...extractGraphqlEndpoints(root, repository)];
  for (const node of graph.nodes) {
    const content = readWorkingFile(root, node.id);
    if (content === null) {
      continue;
    }
    contents.set(node.id, content);
    calls.push(...extractCallsFromContent(node.id, content));
    rpcCalls.push(...rpcCallsFromContent(node.id, content));
    if (!isTestLike(node.id)) {
      routes.push(...codeEndpointsFromContent(repository, node.id, content));
      surfaces.push(...graphqlEndpointsFromContent(repository, node.id, content));
    }
  }
  // GraphQL operations a client keeps in `.graphql` documents are not graph nodes.
  for (const file of findGraphqlFiles(root)) {
    const content = readWorkingFile(root, file);
    if (content !== null) {
      rpcCalls.push(...rpcCallsFromContent(file, content));
    }
  }
  return { operations: extractOpenApiEndpoints(root, repository), routes, surfaces, calls, rpcCalls, contents };
}

/** Every recorded endpoint with its handler, guard, tests, and callers. */
export function listEndpoints(root: string, graph: Graph): EndpointsReport {
  return summarise(root, graph, readFacts(root, graph)).report;
}

/** One endpoint's passport, or null when no recorded endpoint has that method and path. */
export function endpointPassport(
  root: string,
  graph: Graph,
  method: string,
  routePath: string,
): EndpointPassport | null {
  const facts = readFacts(root, graph);
  const { report, groups } = summarise(root, graph, facts);
  const wanted = new Set([
    `${method.toUpperCase()} ${shape(normalise(routePath))}`,
    `${method.toUpperCase()} ${routePath.trim()}`,
  ]);
  const index = report.endpoints.findIndex(
    (entry) =>
      wanted.has(`${entry.method} ${shape(entry.path)}`) ||
      entry.declarations.some((declaration) => wanted.has(`${entry.method} ${shape(declaration.path)}`)),
  );
  const summary = report.endpoints[index];
  const group = groups[index];
  if (!summary || !group) {
    return null;
  }

  const operation = group.operation;
  const middleware = group.routes.flatMap((route) => route.middleware ?? []);
  const forward = buildAdjacency(graph).forward;
  const files: string[] = [];
  if (summary.handler.file) {
    const seen = new Set<string>([summary.handler.file]);
    let frontier = [summary.handler.file];
    files.push(summary.handler.file);
    for (let depth = 0; depth < DOWNSTREAM_DEPTH; depth += 1) {
      const next: string[] = [];
      for (const file of frontier) {
        for (const target of forward.get(file) ?? []) {
          if (!seen.has(target) && !isTestLike(target)) {
            seen.add(target);
            next.push(target);
            files.push(target);
          }
        }
      }
      frontier = next;
    }
  }
  const tables = files
    .flatMap((file) => {
      const content = facts.contents.get(file);
      if (content === undefined) {
        return [];
      }
      try {
        return extractDataUsesFromSource(file, content).map((use) => ({
          table: use.table,
          access: use.access,
          file,
          line: use.line,
        }));
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.table.localeCompare(b.table) || a.file.localeCompare(b.file) || a.line - b.line);

  return {
    available: true,
    ...summary,
    parameters: operation?.parameters ?? [],
    request: operation?.request ?? null,
    response: operation?.response ?? null,
    middleware: [...new Set(middleware)],
    downstream: { depth: DOWNSTREAM_DEPTH, files, tables },
  };
}

interface EndpointGroup {
  protocol: 'http' | 'grpc' | 'graphql';
  method: string;
  path: string;
  operation: ServiceEndpoint | null;
  routes: ServiceEndpoint[];
}

function summarise(
  root: string,
  graph: Graph,
  facts: Facts,
): { report: EndpointsReport; groups: EndpointGroup[] } {
  const groups = [...groupEndpoints(facts.operations, facts.routes), ...groupSurfaces(facts.surfaces)];
  const zeros = {
    endpoints: 0,
    byProtocol: { http: 0, grpc: 0, graphql: 0 },
    documentedOnly: 0,
    untested: 0,
    guarded: 0,
    anonymous: 0,
    noGuardRecorded: 0,
  };
  if (groups.length === 0) {
    return {
      report: {
        available: false,
        reason: 'no endpoint is declared in an OpenAPI document, a .proto service, or a GraphQL schema, or registered in code',
        endpoints: [],
        totals: zeros,
      },
      groups: [],
    };
  }

  const reach = computeDetailedTestReachByFile(graph);
  const endpoints = groups.map((group): EndpointSummary => {
    const route = group.routes[0] ?? null;
    const handler = route
      ? resolveHandler(graph, facts.contents, route)
      : group.operation && group.protocol !== 'http'
        ? implementationOf(facts.contents, group.operation)
        : { name: null, file: null, basis: 'none' as const };
    let sites: EndpointSite[];
    if (group.protocol !== 'http' && group.operation) {
      const surface = group.operation;
      sites = facts.rpcCalls.filter((call) => callReaches(call, surface)).map(site);
    } else {
      const templates = [...new Set([group.path, ...group.routes.map((entry) => entry.path)])].map(templatePattern);
      const fits = (call: ServiceCall) =>
        call.path !== null &&
        (call.method === null || call.method === group.method) &&
        templates.some((template) => template.test(call.path as string));
      sites = facts.calls.filter(fits).map(site);
    }
    const testCalls = sites.filter((call) => isTestLike(call.file));
    const reaching = handler.file
      ? [...new Set((reach.get(handler.file) ?? []).map((detail) => detail.test))]
          .filter((test) => test !== handler.file)
          .slice(0, REACHING_TESTS)
      : [];
    return {
      protocol: group.protocol,
      method: group.method,
      path: group.path,
      declarations: [
        ...(group.operation ? [declarationOf(group.operation)] : []),
        ...group.routes.map(declarationOf),
      ],
      handler,
      guard: guardStatus(group.routes.flatMap((entry) => entry.middleware ?? [])),
      tests: { calls: testCalls, reaching },
      tested: testCalls.length > 0 || reaching.length > 0,
      callers: sites.filter((call) => !isTestLike(call.file)),
    };
  });

  const order = endpoints
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.path.localeCompare(b.entry.path) || a.entry.method.localeCompare(b.entry.method));
  const sortedEndpoints = order.map((item) => item.entry);
  const sortedGroups = order.map((item) => groups[item.index] as EndpointGroup);
  const http = sortedEndpoints.filter((entry) => entry.protocol === 'http');
  const coded = http.filter((entry) => entry.declarations.some((declaration) => declaration.origin === 'code'));
  return {
    report: {
      available: true,
      endpoints: sortedEndpoints,
      totals: {
        endpoints: sortedEndpoints.length,
        byProtocol: {
          http: http.length,
          grpc: sortedEndpoints.filter((entry) => entry.protocol === 'grpc').length,
          graphql: sortedEndpoints.filter((entry) => entry.protocol === 'graphql').length,
        },
        documentedOnly: http.length - coded.length,
        untested: coded.filter((entry) => !entry.tested).length,
        guarded: coded.filter((entry) => entry.guard.status === 'guarded').length,
        anonymous: coded.filter((entry) => entry.guard.status === 'anonymous').length,
        noGuardRecorded: coded.filter((entry) => entry.guard.status === 'none-recorded').length,
      },
    },
    groups: sortedGroups,
  };
}

/**
 * Group operations and routes into endpoints: a documented operation takes the routes the
 * conformance reading joins to it, and every other route is grouped by method and path shape.
 */
function groupEndpoints(operations: readonly ServiceEndpoint[], routes: readonly ServiceEndpoint[]): EndpointGroup[] {
  const groups: EndpointGroup[] = [];
  const claimed = new Set<ServiceEndpoint>();
  const conformance = operations.length > 0 && routes.length > 0 ? compareRoutes(operations, routes) : null;
  const foreign = new Set(
    (conformance?.documents ?? []).filter((document) => document.describes === 'another-service').map((document) => document.file),
  );
  for (const operation of operations) {
    if (foreign.has(operation.source)) {
      continue;
    }
    const joined = (conformance?.matched ?? []).filter(
      (match) => match.spec.file === operation.source && match.method === operation.method && match.path === operation.path,
    );
    const members = routes.filter(
      (route) =>
        route.method === operation.method &&
        joined.some((match) => match.code.file === route.source && match.codePath === route.path),
    );
    // Every registration of the joined shape belongs to this operation, as in the conformance reading.
    const shapes = new Set(members.map((route) => shape(route.path)));
    const all = routes.filter((route) => route.method === operation.method && shapes.has(shape(route.path)));
    all.forEach((route) => claimed.add(route));
    groups.push({ protocol: 'http', method: operation.method, path: operation.path, operation, routes: all });
  }
  const byKey = new Map<string, EndpointGroup>();
  for (const route of routes) {
    if (claimed.has(route)) {
      continue;
    }
    const key = `${route.method} ${shape(route.path)}`;
    const group = byKey.get(key) ?? { protocol: 'http' as const, method: route.method, path: route.path, operation: null, routes: [] };
    group.routes.push(route);
    byKey.set(key, group);
  }
  return [...groups, ...byKey.values()];
}

/** One group per gRPC rpc, gRPC-gateway route, and GraphQL root field, the first declaration kept. */
function groupSurfaces(surfaces: readonly ServiceEndpoint[]): EndpointGroup[] {
  const byKey = new Map<string, EndpointGroup>();
  for (const surface of surfaces) {
    const key = `${surface.protocol ?? 'http'} ${surface.method} ${surface.path}`;
    if (!byKey.has(key)) {
      byKey.set(key, { protocol: surface.protocol ?? 'http', method: surface.method, path: surface.path, operation: surface, routes: [] });
    }
  }
  return [...byKey.values()];
}

/** The non-test file that implements a gRPC service or resolves a GraphQL field, by convention. */
function implementationOf(contents: ReadonlyMap<string, string>, surface: ServiceEndpoint): EndpointSummary['handler'] {
  const pattern = implementationPattern(surface);
  const name = surface.operationId?.split('.').pop() ?? null;
  if (pattern) {
    for (const [file, content] of [...contents.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!isTestLike(file) && pattern.test(content)) {
        return { name, file, basis: 'implementation' };
      }
    }
  }
  return { name, file: null, basis: 'none' };
}

/**
 * The file a code route's handler lives in: the decorated function's own file; the module an
 * import binds the handler name from, followed through the recorded import edge; a function of
 * that name in the declaring file; else the declaring file, named as such.
 */
function resolveHandler(
  graph: Graph,
  contents: ReadonlyMap<string, string>,
  route: ServiceEndpoint,
): EndpointSummary['handler'] {
  const name = route.handler ?? null;
  const file = route.source;
  if (!name || ['nestjs', 'fastapi', 'flask', 'spring', 'jax-rs', 'actix'].includes(route.framework ?? '')) {
    return { name, file, basis: name ? 'same-file' : 'declaring-file' };
  }
  const content = contents.get(file) ?? '';
  const escaped = name.replace(/[$]/g, '\\$');
  const specifier =
    new RegExp(`import\\s+(?:type\\s+)?(?:[\\w$]+\\s*,\\s*)?\\{[^}]*\\b${escaped}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`).exec(content)?.[1] ??
    new RegExp(`import\\s+${escaped}\\s+from\\s*['"]([^'"]+)['"]`).exec(content)?.[1] ??
    new RegExp(`\\{[^}]*\\b${escaped}\\b[^}]*\\}\\s*=\\s*require\\s*\\(\\s*['"]([^'"]+)['"]`).exec(content)?.[1] ??
    new RegExp(`\\bfrom\\s+([\\w.]+)\\s+import\\s+[^\\n]*\\b${escaped}\\b`).exec(content)?.[1] ??
    new RegExp(`\\buse\\s+([\\w:]+)::(?:\\{[^}]*\\b${escaped}\\b[^}]*\\}|${escaped})\\s*;`).exec(content)?.[1] ??
    null;
  if (specifier !== null) {
    const edge = graph.edges.find((entry) => entry.source === file && entry.evidence.specifier === specifier);
    if (edge) {
      return { name, file: edge.target, basis: 'import' };
    }
  }
  if (new RegExp(`(?:function\\s+|(?:const|let|var)\\s+|\\bfn\\s+|\\bdef\\s+)${escaped}\\b`).test(content)) {
    return { name, file, basis: 'same-file' };
  }
  return { name, file, basis: 'declaring-file' };
}

function declarationOf(endpoint: ServiceEndpoint): EndpointDeclaration {
  return {
    origin: endpoint.origin ?? 'openapi',
    file: endpoint.source,
    line: endpoint.line ?? null,
    path: endpoint.path,
    framework: endpoint.framework ?? null,
    handler: endpoint.handler ?? null,
    ...(endpoint.operationId ? { operationId: endpoint.operationId } : {}),
  };
}

function site(call: { file: string; line: number }): EndpointSite {
  return { file: call.file, line: call.line };
}

function templatePattern(routePath: string): RegExp {
  const source = routePath
    .split(/\{[^}]*\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${source}$`);
}

function shape(routePath: string): string {
  return routePath.replace(/\{[^}]*\}/g, '{}');
}

function normalise(routePath: string): string {
  const trimmed = routePath.trim().replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed || '/' : `/${trimmed}`;
}
