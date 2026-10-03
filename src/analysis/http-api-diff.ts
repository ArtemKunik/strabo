import path from 'node:path';

import { isTestLike } from '../scan/scan.ts';
import type { ApiParameter, ApiSchemaRef, Compatibility, ContractField, ServiceCall, ServiceEndpoint } from '../types.ts';
import { materializeRevision, RevisionError } from '../workspace/revision.ts';
import { callReaches, extractRpcCalls, type RpcCall } from '../workspace/rpc.ts';
import { extractServiceCalls, extractServiceEndpoints } from '../workspace/services.ts';

/**
 * Breaking HTTP changes between two revisions (Phase 38 R3).
 *
 * Both sides are the endpoints a revision declares — its OpenAPI operations and the routes its
 * source registers — read by the same extractors as the working tree. An endpoint is keyed by
 * method and path shape (parameter names erased), so renaming `{id}` to `{userId}` is not a
 * removal, and it is removed only when neither the documents nor the code declare it any more.
 *
 * Each change is classified from the side that has to adapt:
 *
 * - **Input** (parameters and the request body, which a client sends): a new required input,
 *   an input made required, and a type that no longer accepts every old value break a client;
 *   a removed input is `conditional`, since a strict validator rejects what a lenient one
 *   ignores.
 * - **Output** (the 2xx response body, which a client reads): a removed field, a field made
 *   optional, and a type that can now carry values the old one could not break a reader.
 *
 * A breaking or conditional change names its recorded callers: literal calls in this
 * repository at head whose method and path fit the endpoint's template, and, when sibling
 * repositories are passed, their calls to the same host.
 */

export type HttpApiChangeKind =
  | 'operation-removed'
  | 'operation-added'
  | 'parameter-added'
  | 'parameter-removed'
  | 'parameter-required'
  | 'parameter-optional'
  | 'parameter-type'
  | 'request-field-added'
  | 'request-field-removed'
  | 'request-field-required'
  | 'request-field-optional'
  | 'request-field-type'
  | 'response-removed'
  | 'response-field-added'
  | 'response-field-removed'
  | 'response-field-required'
  | 'response-field-optional'
  | 'response-field-type';

export interface HttpApiCaller {
  /** The calling repository, when it is a sibling rather than this one. */
  repository?: string;
  file: string;
  line: number;
}

export interface HttpApiChange {
  kind: HttpApiChangeKind;
  compatibility: Compatibility;
  method: string;
  path: string;
  /** The parameter (`query:limit`) or field name the change is about. */
  subject?: string;
  before?: string;
  after?: string;
  detail: string;
  /** Where the endpoint is declared on the side that still has it. */
  source: string;
  callers: HttpApiCaller[];
}

export interface HttpApiDiffReport {
  available: boolean;
  reason?: string;
  base: string;
  head: string | null;
  endpoints: { base: number; head: number };
  changes: HttpApiChange[];
  totals: { breaking: number; conditional: number; safe: number };
}

export interface SiblingCalls {
  repository: string;
  calls: ServiceCall[];
}

export async function computeHttpApiDiff(
  root: string,
  base: string,
  options: { head?: string | null; siblings?: readonly SiblingCalls[] } = {},
): Promise<HttpApiDiffReport> {
  const head = options.head ?? null;
  const repository = path.basename(root);
  try {
    const before = await sideAt(root, repository, base);
    const after = head ? await sideAt(root, repository, head) : readSide(root, repository);
    if (before.endpoints.length === 0 && after.endpoints.length === 0) {
      return {
        ...emptyReport(base, head),
        reason: 'no HTTP endpoint is declared at either revision, in an OpenAPI document or in code',
      };
    }
    return diffHttpApi(before.endpoints, after.endpoints, {
      base,
      head,
      calls: after.calls,
      rpcCalls: after.rpcCalls,
      siblings: options.siblings ?? [],
    });
  } catch (error) {
    if (error instanceof RevisionError) {
      return { ...emptyReport(base, head), reason: error.message };
    }
    throw error;
  }
}

/** The pure half: compare two endpoint lists and name the callers of what breaks. */
export function diffHttpApi(
  before: readonly ServiceEndpoint[],
  after: readonly ServiceEndpoint[],
  context: {
    base: string;
    head: string | null;
    calls?: readonly ServiceCall[];
    /** gRPC stub calls and GraphQL selections, for the callers of a gRPC or GraphQL change. */
    rpcCalls?: readonly RpcCall[];
    siblings?: readonly SiblingCalls[];
  },
): HttpApiDiffReport {
  const was = byOperation(before);
  const now = byOperation(after);
  const changes: Array<Omit<HttpApiChange, 'callers'> & { endpoint: ServiceEndpoint }> = [];

  for (const [key, old] of was) {
    const current = now.get(key);
    if (!current) {
      changes.push({
        kind: 'operation-removed',
        compatibility: 'breaking',
        method: old.method,
        path: old.path,
        detail: `${old.method} ${old.path} is no longer declared in the documents or the code`,
        source: old.source,
        endpoint: old,
      });
      continue;
    }
    for (const change of diffOperation(old, current)) {
      changes.push({ ...change, method: current.method, path: current.path, source: current.source, endpoint: current });
    }
  }
  for (const [key, current] of now) {
    if (!was.has(key)) {
      changes.push({
        kind: 'operation-added',
        compatibility: 'safe',
        method: current.method,
        path: current.path,
        detail: `${current.method} ${current.path} is new`,
        source: current.source,
        endpoint: current,
      });
    }
  }

  const order: Record<Compatibility, number> = { breaking: 0, conditional: 1, safe: 2 };
  const withCallers: HttpApiChange[] = changes
    .map(({ endpoint, ...change }) => ({
      ...change,
      callers:
        change.compatibility === 'safe'
          ? []
          : endpoint.protocol
            ? rpcCallersOf(endpoint, context.rpcCalls ?? [])
            : callersOf(endpoint, context.calls ?? [], context.siblings ?? []),
    }))
    .sort(
      (a, b) =>
        order[a.compatibility] - order[b.compatibility] ||
        a.path.localeCompare(b.path) ||
        a.method.localeCompare(b.method) ||
        a.kind.localeCompare(b.kind) ||
        (a.subject ?? '').localeCompare(b.subject ?? ''),
    );

  return {
    available: true,
    base: context.base,
    head: context.head,
    endpoints: { base: was.size, head: now.size },
    changes: withCallers,
    totals: {
      breaking: withCallers.filter((change) => change.compatibility === 'breaking').length,
      conditional: withCallers.filter((change) => change.compatibility === 'conditional').length,
      safe: withCallers.filter((change) => change.compatibility === 'safe').length,
    },
  };
}

type OperationChange = Pick<HttpApiChange, 'kind' | 'compatibility' | 'subject' | 'before' | 'after' | 'detail'>;

function diffOperation(old: ServiceEndpoint, current: ServiceEndpoint): OperationChange[] {
  // Only a documented operation has parameters and bodies to compare; a code route is a
  // method and a path, which the key already matched.
  if (old.origin === 'code' || current.origin === 'code') {
    return [];
  }
  return [
    ...diffParameters(old.parameters ?? [], current.parameters ?? []),
    ...diffRequest(old.request ?? null, current.request ?? null),
    ...diffResponse(old.response ?? null, current.response ?? null),
  ];
}

function diffParameters(before: readonly ApiParameter[], after: readonly ApiParameter[]): OperationChange[] {
  // Path parameters are the path's own shape, which the operation key already compares.
  const keyed = (list: readonly ApiParameter[]) =>
    new Map(list.filter((entry) => entry.in !== 'path').map((entry) => [`${entry.in}:${entry.name}`, entry]));
  const was = keyed(before);
  const now = keyed(after);
  const changes: OperationChange[] = [];
  for (const [subject, old] of was) {
    const current = now.get(subject);
    if (!current) {
      changes.push({
        kind: 'parameter-removed',
        compatibility: 'conditional',
        subject,
        before: old.type,
        detail: `${subject} is no longer declared; a client that still sends it is ignored or rejected`,
      });
      continue;
    }
    if (!old.required && current.required) {
      changes.push({ kind: 'parameter-required', compatibility: 'breaking', subject, detail: `${subject} is now required` });
    } else if (old.required && !current.required) {
      changes.push({ kind: 'parameter-optional', compatibility: 'safe', subject, detail: `${subject} is now optional` });
    }
    if (old.type !== current.type) {
      changes.push(inputTypeChange('parameter-type', subject, old.type, current.type));
    }
  }
  for (const [subject, current] of now) {
    if (!was.has(subject)) {
      changes.push({
        kind: 'parameter-added',
        compatibility: current.required ? 'breaking' : 'safe',
        subject,
        after: current.type,
        detail: current.required ? `${subject} is a new required parameter` : `${subject} is a new optional parameter`,
      });
    }
  }
  return changes;
}

function diffRequest(before: ApiSchemaRef | null, after: ApiSchemaRef | null): OperationChange[] {
  const was = fieldsOf(before);
  const now = fieldsOf(after);
  const changes: OperationChange[] = [];
  for (const [name, old] of was) {
    const current = now.get(name);
    if (!current) {
      changes.push({
        kind: 'request-field-removed',
        compatibility: 'conditional',
        subject: name,
        before: old.type,
        detail: `request field ${name} is no longer declared; a client that still sends it is ignored or rejected`,
      });
      continue;
    }
    if (!old.required && current.required) {
      changes.push({ kind: 'request-field-required', compatibility: 'breaking', subject: name, detail: `request field ${name} is now required` });
    } else if (old.required && !current.required) {
      changes.push({ kind: 'request-field-optional', compatibility: 'safe', subject: name, detail: `request field ${name} is now optional` });
    }
    if (old.type !== current.type) {
      changes.push(inputTypeChange('request-field-type', name, old.type, current.type));
    }
  }
  for (const [name, current] of now) {
    if (!was.has(name)) {
      changes.push({
        kind: 'request-field-added',
        compatibility: current.required ? 'breaking' : 'safe',
        subject: name,
        after: current.type,
        detail: current.required ? `request field ${name} is new and required` : `request field ${name} is new and optional`,
      });
    }
  }
  return changes;
}

function diffResponse(before: ApiSchemaRef | null, after: ApiSchemaRef | null): OperationChange[] {
  if (before && !after) {
    return [
      {
        kind: 'response-removed',
        compatibility: 'breaking',
        detail: `the success response no longer declares a body${before.schema ? ` (was ${before.schema})` : ''}`,
      },
    ];
  }
  const was = fieldsOf(before);
  const now = fieldsOf(after);
  const changes: OperationChange[] = [];
  for (const [name, old] of was) {
    const current = now.get(name);
    if (!current) {
      changes.push({
        kind: 'response-field-removed',
        compatibility: 'breaking',
        subject: name,
        before: old.type,
        detail: `response field ${name} is no longer returned`,
      });
      continue;
    }
    if (old.required && !current.required) {
      changes.push({
        kind: 'response-field-optional',
        compatibility: 'breaking',
        subject: name,
        detail: `response field ${name} may now be absent`,
      });
    } else if (!old.required && current.required) {
      changes.push({ kind: 'response-field-required', compatibility: 'safe', subject: name, detail: `response field ${name} is now always present` });
    }
    if (old.type !== current.type) {
      // A reader copes with fewer values (a narrower type), not with more.
      const safe = typeWidens(current.type, old.type);
      changes.push({
        kind: 'response-field-type',
        compatibility: safe ? 'safe' : 'breaking',
        subject: name,
        before: old.type,
        after: current.type,
        detail: `response field ${name} changed from ${old.type} to ${current.type}${safe ? ' (narrower, every new value fits the old type)' : ''}`,
      });
    }
  }
  for (const [name, current] of now) {
    if (!was.has(name)) {
      changes.push({
        kind: 'response-field-added',
        compatibility: 'safe',
        subject: name,
        after: current.type,
        detail: `response field ${name} is new`,
      });
    }
  }
  return changes;
}

function inputTypeChange(
  kind: 'parameter-type' | 'request-field-type',
  subject: string,
  before: string,
  after: string,
): OperationChange {
  // A server must still accept every value a client already sends: only a wider type is safe.
  const safe = typeWidens(before, after);
  return {
    kind,
    compatibility: safe ? 'safe' : 'breaking',
    subject,
    before,
    after,
    detail: `${kind === 'parameter-type' ? '' : 'request field '}${subject} changed from ${before} to ${after}${safe ? ' (wider, every old value still fits)' : ''}`,
  };
}

/**
 * Whether every value of the `before` type still fits `after`: a dropped format
 * (`string(email)` → `string`), a wider integer (`integer(int32)` → `integer(int64)`), and an
 * integer read as a number. Anything else is treated as not widening.
 */
export function typeWidens(before: string, after: string): boolean {
  if (before === after) {
    return true;
  }
  const array = /^array<(.*)>$/;
  const fromItems = array.exec(before)?.[1];
  const toItems = array.exec(after)?.[1];
  if (fromItems !== undefined && toItems !== undefined) {
    return typeWidens(fromItems, toItems);
  }
  const base = (type: string) => type.replace(/\(.*\)$/, '');
  const format = (type: string) => /\((.*)\)$/.exec(type)?.[1] ?? null;
  if (base(before) === base(after) && format(after) === null) {
    return true;
  }
  if (before === 'integer(int32)' && after === 'integer(int64)') {
    return true;
  }
  if (before === 'number(float)' && after === 'number(double)') {
    return true;
  }
  return base(before) === 'integer' && base(after) === 'number' && format(after) === null;
}

/** One endpoint per method and path shape, preferring a documented operation over a code route. */
function byOperation(endpoints: readonly ServiceEndpoint[]): Map<string, ServiceEndpoint> {
  const map = new Map<string, ServiceEndpoint>();
  for (const endpoint of endpoints) {
    if (endpoint.origin === 'code' && isTestLike(endpoint.source)) {
      continue;
    }
    const key = `${endpoint.method} ${shape(endpoint.path)}`;
    const existing = map.get(key);
    if (!existing || (existing.origin === 'code' && endpoint.origin !== 'code')) {
      map.set(key, endpoint);
    }
  }
  return map;
}

/** Literal calls whose method and path fit the endpoint's template, here and in siblings. */
function callersOf(
  endpoint: ServiceEndpoint,
  calls: readonly ServiceCall[],
  siblings: readonly SiblingCalls[],
): HttpApiCaller[] {
  const template = templatePattern(endpoint.path);
  const fits = (call: ServiceCall) =>
    call.path !== null && template.test(call.path) && (call.method === null || call.method === endpoint.method);
  const callers: HttpApiCaller[] = calls
    // A relative call is this repository's own; an absolute one must name the endpoint's host.
    .filter((call) => fits(call) && (call.host === null || call.host === endpoint.host))
    .map((call) => ({ file: call.file, line: call.line }));
  if (endpoint.host !== null) {
    for (const sibling of siblings) {
      for (const call of sibling.calls) {
        if (fits(call) && call.host === endpoint.host) {
          callers.push({ repository: sibling.repository, file: call.file, line: call.line });
        }
      }
    }
  }
  const seen = new Set<string>();
  return callers
    .filter((caller) => {
      const key = `${caller.repository ?? ''}\u0000${caller.file}\u0000${caller.line}`;
      return seen.has(key) ? false : (seen.add(key), true);
    })
    .sort(
      (a, b) =>
        (a.repository ?? '').localeCompare(b.repository ?? '') || a.file.localeCompare(b.file) || a.line - b.line,
    );
}

function rpcCallersOf(endpoint: ServiceEndpoint, calls: readonly RpcCall[]): HttpApiCaller[] {
  return calls
    .filter((call) => callReaches(call, endpoint))
    .map((call) => ({ file: call.file, line: call.line }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** `/users/{id}` reads `/users/42` and `/users/{id}`; each parameter is one segment. */
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

function fieldsOf(schema: ApiSchemaRef | null): Map<string, ContractField> {
  return new Map((schema?.fields ?? []).map((field) => [field.name, field]));
}

interface Side {
  endpoints: ServiceEndpoint[];
  calls: ServiceCall[];
  rpcCalls: RpcCall[];
}

/** The endpoints a tree declares and the calls its source makes. */
function readSide(root: string, repository: string): Side {
  return {
    endpoints: extractServiceEndpoints(root, repository),
    calls: extractServiceCalls(root),
    rpcCalls: extractRpcCalls(root),
  };
}

async function sideAt(root: string, repository: string, ref: string): Promise<Side> {
  const revision = await materializeRevision(root, ref);
  try {
    return readSide(revision.root, repository);
  } finally {
    revision.cleanup();
  }
}

function emptyReport(base: string, head: string | null): HttpApiDiffReport {
  return {
    available: false,
    base,
    head,
    endpoints: { base: 0, head: 0 },
    changes: [],
    totals: { breaking: 0, conditional: 0, safe: 0 },
  };
}
