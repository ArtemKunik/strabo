import path from 'node:path';

import { isTestLike } from '../scan/scan.ts';
import type { ApiParameter, ApiSchemaRef, DataAccess, Graph, ServiceCall, ServiceEndpoint } from '../types.ts';
import { extractDataUsesFromSource } from '../workspace/data-usage.ts';
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
  origin: 'openapi' | 'code';
  file: string;
  line: number | null;
  path: string;
  framework: string | null;
  handler: string | null;
  operationId?: string;
}

export interface EndpointSummary {
  method: string;
  /** The documented path when the route is documented, else the path the code registers. */
  path: string;
  declarations: EndpointDeclaration[];
  /** The file the handler lives in, and how it was found. */
  handler: { name: string | null; file: string | null; basis: 'import' | 'same-file' | 'declaring-file' | 'none' };
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
    documentedOnly: number;
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
  calls: ServiceCall[];
  contents: Map<string, string>;
}

function readFacts(root: string, graph: Graph): Facts {
  const repository = path.basename(root);
  const contents = new Map<string, string>();
  const routes: ServiceEndpoint[] = [];
  const calls: ServiceCall[] = [];
  for (const node of graph.nodes) {
    const content = readWorkingFile(root, node.id);
    if (content === null) {
      continue;
    }
    contents.set(node.id, content);
    calls.push(...extractCallsFromContent(node.id, content));
    if (!isTestLike(node.id)) {
      routes.push(...codeEndpointsFromContent(repository, node.id, content));
    }
  }
  return { operations: extractOpenApiEndpoints(root, repository), routes, calls, contents };
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
  const wanted = `${method.toUpperCase()} ${shape(normalise(routePath))}`;
  const index = report.endpoints.findIndex(
    (entry) =>
      `${entry.method} ${shape(entry.path)}` === wanted ||
      entry.declarations.some((declaration) => `${entry.method} ${shape(declaration.path)}` === wanted),
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
  const groups = groupEndpoints(facts.operations, facts.routes);
  const zeros = { endpoints: 0, documentedOnly: 0, untested: 0, guarded: 0, anonymous: 0, noGuardRecorded: 0 };
  if (groups.length === 0) {
    return {
      report: {
        available: false,
        reason: 'no HTTP endpoint is declared in an OpenAPI document or registered in code',
        endpoints: [],
        totals: zeros,
      },
      groups: [],
    };
  }

  const reach = computeDetailedTestReachByFile(graph);
  const endpoints = groups.map((group): EndpointSummary => {
    const route = group.routes[0] ?? null;
    const handler = route ? resolveHandler(graph, facts.contents, route) : { name: null, file: null, basis: 'none' as const };
    const templates = [...new Set([group.path, ...group.routes.map((entry) => entry.path)])].map(templatePattern);
    const fits = (call: ServiceCall) =>
      call.path !== null &&
      (call.method === null || call.method === group.method) &&
      templates.some((template) => template.test(call.path as string));
    const sites = facts.calls.filter(fits);
    const testCalls = sites.filter((call) => isTestLike(call.file)).map(site);
    const reaching = handler.file
      ? [...new Set((reach.get(handler.file) ?? []).map((detail) => detail.test))]
          .filter((test) => test !== handler.file)
          .slice(0, REACHING_TESTS)
      : [];
    return {
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
      callers: sites.filter((call) => !isTestLike(call.file)).map(site),
    };
  });

  const order = endpoints
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.path.localeCompare(b.entry.path) || a.entry.method.localeCompare(b.entry.method));
  const sortedEndpoints = order.map((item) => item.entry);
  const sortedGroups = order.map((item) => groups[item.index] as EndpointGroup);
  const coded = sortedEndpoints.filter((entry) => entry.declarations.some((declaration) => declaration.origin === 'code'));
  return {
    report: {
      available: true,
      endpoints: sortedEndpoints,
      totals: {
        endpoints: sortedEndpoints.length,
        documentedOnly: sortedEndpoints.length - coded.length,
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
    groups.push({ method: operation.method, path: operation.path, operation, routes: all });
  }
  const byKey = new Map<string, EndpointGroup>();
  for (const route of routes) {
    if (claimed.has(route)) {
      continue;
    }
    const key = `${route.method} ${shape(route.path)}`;
    const group = byKey.get(key) ?? { method: route.method, path: route.path, operation: null, routes: [] };
    group.routes.push(route);
    byKey.set(key, group);
  }
  return [...groups, ...byKey.values()];
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
    origin: endpoint.origin === 'code' ? 'code' : 'openapi',
    file: endpoint.source,
    line: endpoint.line ?? null,
    path: endpoint.path,
    framework: endpoint.framework ?? null,
    handler: endpoint.handler ?? null,
    ...(endpoint.operationId ? { operationId: endpoint.operationId } : {}),
  };
}

function site(call: ServiceCall): EndpointSite {
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
