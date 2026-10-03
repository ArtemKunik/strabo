import fs from 'node:fs';
import path from 'node:path';

import { toPosix } from '../boundary/repository-root.ts';
import { excludedDirectory } from '../scan/exclusions.ts';
import { collectSourceFiles, isSourceExtension } from '../scan/scan.ts';
import type { ApiParameter, ContractField, ServiceEndpoint } from '../types.ts';
import { extractContracts, findContractFiles } from './contracts.ts';

/**
 * gRPC and GraphQL API surfaces (Phase 38 R5), read as endpoints beside the HTTP ones.
 *
 * - **gRPC**: each `rpc` of a `.proto` `service` is an endpoint `RPC /package.Service/Method`
 *   (the path gRPC puts on the wire), with its request and response messages' fields. A
 *   `google.api.http` option on the rpc is also an HTTP endpoint (the gRPC-gateway route).
 * - **GraphQL**: each field of the root `Query`, `Mutation`, and `Subscription` types (and their
 *   `extend type`s) in `.graphql`/`.gql`/`.graphqls` files, or SDL in a `gql`/`graphql` tagged
 *   template or a `typeDefs` string, is an endpoint `QUERY users`, with its arguments as
 *   parameters and the fields of its return type as the response.
 *
 * Callers are lexical as everywhere else: a gRPC call is a method of that rpc's name on a
 * receiver named like a stub or client (`stub.GetUser(`, `client.getUserAsync(`), and a
 * GraphQL call is a top-level field selected by an operation in a `gql` template or a
 * `.graphql` document.
 */

export interface RpcCall {
  protocol: 'grpc' | 'graphql';
  /** `RPC`, or the GraphQL operation type (`QUERY`, `MUTATION`, `SUBSCRIPTION`). */
  method: string;
  /** The rpc name as called (lower camel and `Async` folded later), or the selected field. */
  name: string;
  file: string;
  line: number;
}

const MAX_BYTES = 2 * 1024 * 1024;
const GRAPHQL_EXTENSIONS = new Set(['.graphql', '.gql', '.graphqls']);
const ROOT_TYPES: Record<string, string> = { Query: 'QUERY', Mutation: 'MUTATION', Subscription: 'SUBSCRIPTION' };

// ---------------------------------------------------------------------------------------------
// gRPC

/** The rpcs every `.proto` file declares, with their messages' fields. */
export function extractGrpcEndpoints(root: string, repository: string): ServiceEndpoint[] {
  const protoFiles = findContractFiles(root).filter((file) => file.toLowerCase().endsWith('.proto'));
  if (protoFiles.length === 0) {
    return [];
  }
  const messages = new Map<string, ContractField[]>();
  for (const contract of extractContracts(root, repository)) {
    if (contract.format === 'protobuf') {
      messages.set(contract.id, contract.fields);
      messages.set(contract.id.split('.').pop() ?? contract.id, contract.fields);
    }
  }
  const endpoints: ServiceEndpoint[] = [];
  for (const file of protoFiles) {
    const content = readText(root, file);
    if (content !== null) {
      endpoints.push(...grpcEndpointsFromContent(repository, file, content, messages));
    }
  }
  return endpoints;
}

export function grpcEndpointsFromContent(
  repository: string,
  file: string,
  content: string,
  messages: ReadonlyMap<string, ContractField[]> = new Map(),
): ServiceEndpoint[] {
  const source = stripComments(content);
  const packageName = /^\s*package\s+([\w.]+)\s*;/m.exec(source)?.[1] ?? '';
  const endpoints: ServiceEndpoint[] = [];
  for (const service of source.matchAll(/\bservice\s+(\w+)\s*\{/g)) {
    const serviceName = service[1] ?? '';
    const open = (service.index ?? 0) + service[0].length - 1;
    const close = matchingBrace(source, open);
    const body = source.slice(open + 1, close);
    const rpcPattern =
      /\brpc\s+(\w+)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*(\{|;)/g;
    for (const rpc of body.matchAll(rpcPattern)) {
      const rpcName = rpc[1] ?? '';
      const at = open + 1 + (rpc.index ?? 0);
      const message = (name: string) => {
        const fields = messages.get(name) ?? messages.get(name.split('.').pop() ?? name);
        return fields ? { schema: name.split('.').pop() ?? name, fields } : null;
      };
      const request = message(rpc[3] ?? '');
      const response = message(rpc[5] ?? '');
      const qualified = packageName ? `${packageName}.${serviceName}` : serviceName;
      const shared = {
        repository,
        source: file,
        host: null,
        line: lineOf(source, at),
        operationId: `${serviceName}.${rpcName}`,
        ...(request ? { request } : {}),
        ...(response ? { response } : {}),
      };
      endpoints.push({
        ...shared,
        method: 'RPC',
        path: `/${qualified}/${rpcName}`,
        origin: 'proto',
        protocol: 'grpc',
        ...(streaming(Boolean(rpc[2]), Boolean(rpc[4])) ? { framework: streaming(Boolean(rpc[2]), Boolean(rpc[4])) as string } : {}),
      });
      // `option (google.api.http) = { get: "/v1/users/{id}" }` publishes the rpc over HTTP.
      if (rpc[6] === '{') {
        const optionsOpen = at + rpc[0].length - 1;
        const options = source.slice(optionsOpen, matchingBrace(source, optionsOpen));
        const http = /google\.api\.http\)\s*=\s*\{[^}]*?\b(get|post|put|patch|delete)\s*:\s*"([^"]+)"/.exec(options);
        if (http) {
          endpoints.push({ ...shared, method: (http[1] ?? '').toUpperCase(), path: http[2] ?? '/', origin: 'proto' });
        }
      }
    }
  }
  return endpoints;
}

/** How an rpc streams, named the way gRPC documents it, or null for a unary rpc. */
function streaming(client: boolean, server: boolean): string | null {
  if (client && server) return 'bidirectional-streaming';
  if (client) return 'client-streaming';
  return server ? 'server-streaming' : null;
}

const STUB_CALL = /\b(\w*(?:[Ss]tub|[Cc]lient))\s*\.\s*([A-Za-z_]\w*)\s*\(/g;

/** Calls of a method on a stub- or client-named receiver: candidate gRPC calls. */
function grpcCallsFromContent(file: string, content: string): RpcCall[] {
  const calls: RpcCall[] = [];
  for (const match of content.matchAll(STUB_CALL)) {
    calls.push({ protocol: 'grpc', method: 'RPC', name: match[2] ?? '', file, line: lineOf(content, match.index ?? 0) });
  }
  return calls;
}

/** Whether a called method name is this rpc: exact, lower camel, or with an `Async` suffix. */
export function callsRpc(called: string, rpcName: string): boolean {
  const fold = (name: string) => name.replace(/Async$/, '').toLowerCase();
  return fold(called) === rpcName.toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// GraphQL

/** The root-type fields every GraphQL schema in the repository declares. */
export function extractGraphqlEndpoints(root: string, repository: string, sourceFiles: readonly string[] = []): ServiceEndpoint[] {
  const endpoints: ServiceEndpoint[] = [];
  for (const file of [...findGraphqlFiles(root), ...sourceFiles]) {
    const content = readText(root, file);
    if (content !== null) {
      endpoints.push(...graphqlEndpointsFromContent(repository, file, content));
    }
  }
  return endpoints;
}

/** Root-type fields from a schema file, or from the SDL templates in a source file. */
export function graphqlEndpointsFromContent(repository: string, file: string, content: string): ServiceEndpoint[] {
  const documents = GRAPHQL_EXTENSIONS.has(path.extname(file).toLowerCase())
    ? [{ text: content, offset: 0 }]
    : sdlTemplates(content);
  const endpoints: ServiceEndpoint[] = [];
  for (const document of documents) {
    const text = blankGraphqlComments(document.text);
    if (!/\b(?:type|extend\s+type)\s+\w+/.test(text)) {
      continue;
    }
    const types = objectTypes(text);
    const roots = schemaRoots(text);
    for (const type of types) {
      const method = roots.get(type.name);
      if (!method) {
        continue;
      }
      for (const field of type.fields) {
        const named = field.type.replace(/[[\]!]/g, '');
        const returned = types.filter((candidate) => candidate.name === named).flatMap((candidate) => candidate.fields);
        endpoints.push({
          repository,
          source: file,
          method,
          path: field.name,
          host: null,
          origin: 'graphql',
          protocol: 'graphql',
          line: lineOf(content, document.offset + field.offset),
          operationId: `${type.name}.${field.name}`,
          ...(field.args.length > 0 ? { parameters: field.args } : {}),
          response: {
            schema: named,
            fields: returned.map((entry) => ({ name: entry.name, type: entry.type, required: entry.type.endsWith('!') })),
          },
        });
      }
    }
  }
  return endpoints;
}

/** Top-level fields selected by the GraphQL operations in a document or a `gql` template. */
function graphqlCallsFromContent(file: string, content: string): RpcCall[] {
  const documents = GRAPHQL_EXTENSIONS.has(path.extname(file).toLowerCase())
    ? [{ text: content, offset: 0 }]
    : [...content.matchAll(/\b(?:gql|graphql)\s*(?:\(\s*)?`([^`]*)`/g)].map((match) => ({
        text: match[1] ?? '',
        offset: (match.index ?? 0) + match[0].indexOf('`') + 1,
      }));
  const calls: RpcCall[] = [];
  for (const document of documents) {
    const text = blankGraphqlComments(document.text);
    for (const operation of text.matchAll(/\b(query|mutation|subscription)\b[^{}]*\{/g)) {
      const open = (operation.index ?? 0) + operation[0].length - 1;
      const close = matchingBrace(text, open);
      for (const field of topLevelFields(text, open + 1, close)) {
        calls.push({
          protocol: 'graphql',
          method: (operation[1] ?? '').toUpperCase(),
          name: field.name,
          file,
          line: lineOf(content, document.offset + field.offset),
        });
      }
    }
  }
  return calls;
}

interface GraphqlField {
  name: string;
  type: string;
  args: ApiParameter[];
  offset: number;
}

function objectTypes(text: string): Array<{ name: string; fields: GraphqlField[] }> {
  const types: Array<{ name: string; fields: GraphqlField[] }> = [];
  for (const match of text.matchAll(/\b(?:extend\s+)?type\s+(\w+)[^{]*\{/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = matchingBrace(text, open);
    const fields: GraphqlField[] = [];
    const body = text.slice(open + 1, close);
    for (const field of body.matchAll(/(\w+)\s*(?:\(([^)]*)\))?\s*:\s*([[\]\w!]+)/g)) {
      fields.push({
        name: field[1] ?? '',
        type: field[3] ?? 'unknown',
        args: [...(field[2] ?? '').matchAll(/(\w+)\s*:\s*([[\]\w!]+)(\s*=\s*[^,\s)]+)?/g)].map((arg) => ({
          name: arg[1] ?? '',
          in: 'argument',
          required: (arg[2] ?? '').endsWith('!') && !arg[3],
          type: arg[2] ?? 'unknown',
        })),
        offset: open + 1 + (field.index ?? 0),
      });
    }
    types.push({ name: match[1] ?? '', fields });
  }
  return types;
}

/** Root operation types: `schema { query: RootQuery }` when declared, else the default names. */
function schemaRoots(text: string): Map<string, string> {
  const declared = /\bschema\s*\{([^}]*)\}/.exec(text)?.[1];
  if (!declared) {
    return new Map(Object.entries(ROOT_TYPES));
  }
  const roots = new Map<string, string>();
  for (const entry of declared.matchAll(/\b(query|mutation|subscription)\s*:\s*(\w+)/g)) {
    roots.set(entry[2] ?? '', (entry[1] ?? '').toUpperCase());
  }
  return roots;
}

/** Field names at the first depth of a selection set, past aliases, arguments, and directives. */
function topLevelFields(text: string, from: number, to: number): Array<{ name: string; offset: number }> {
  const fields: Array<{ name: string; offset: number }> = [];
  let depth = 0;
  let parens = 0;
  for (let index = from; index < to; index += 1) {
    const char = text[index] ?? '';
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (char === '(') parens += 1;
    else if (char === ')') parens -= 1;
    else if (depth === 0 && parens === 0 && /[A-Za-z_]/.test(char) && !/[\w$@.]/.test(text[index - 1] ?? '')) {
      const word = /^[A-Za-z_]\w*/.exec(text.slice(index))?.[0] ?? '';
      const after = text.slice(index + word.length);
      if (/^\s*:/.test(after)) {
        // `alias: field` — the field follows the colon.
        index += word.length;
        continue;
      }
      if (word !== 'on' && word !== 'fragment') {
        fields.push({ name: word, offset: index });
      }
      index += word.length - 1;
    }
  }
  return fields;
}

/** SDL held in a `gql`/`graphql` tagged template, or a `typeDefs` string, in source. */
function sdlTemplates(content: string): Array<{ text: string; offset: number }> {
  const templates: Array<{ text: string; offset: number }> = [];
  const patterns = [
    /\b(?:gql|graphql)\s*(?:\(\s*)?`([^`]*)`/g,
    /\btypeDefs\s*[:=]\s*(?:\/\*\s*GraphQL\s*\*\/\s*)?`([^`]*)`/g,
    /\btype_defs\s*=\s*(?:gql\s*\(\s*)?(?:"""|''')([\s\S]*?)(?:"""|''')/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const text = match[1] ?? '';
      if (/\btype\s+(?:Query|Mutation|Subscription)\b|\bschema\s*\{/.test(text)) {
        templates.push({ text, offset: (match.index ?? 0) + match[0].indexOf(text) });
      }
    }
  }
  return templates;
}

export function findGraphqlFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      const relative = toPosix(path.relative(root, absolute));
      if (entry.isDirectory()) {
        if (!excludedDirectory(relative)) {
          walk(absolute);
        }
      } else if (GRAPHQL_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(relative);
      }
    }
  };
  walk(root);
  return found.sort();
}

// ---------------------------------------------------------------------------------------------
// Shared

/** The candidate gRPC and GraphQL calls one already-read file makes. */
export function rpcCallsFromContent(file: string, content: string): RpcCall[] {
  const extension = path.extname(file).toLowerCase();
  if (GRAPHQL_EXTENSIONS.has(extension)) {
    return graphqlCallsFromContent(file, content);
  }
  if (extension === '.proto') {
    return [];
  }
  return [...grpcCallsFromContent(file, content), ...graphqlCallsFromContent(file, content)];
}

/** The candidate gRPC and GraphQL calls across a tree: its source files and `.graphql` documents. */
export function extractRpcCalls(root: string): RpcCall[] {
  const calls: RpcCall[] = [];
  for (const file of [...collectSourceFiles(root, [], []).filter(isSourceExtension), ...findGraphqlFiles(root)]) {
    const content = readText(root, file);
    if (content !== null) {
      calls.push(...rpcCallsFromContent(file, content));
    }
  }
  return calls;
}

/** Whether a recorded call reaches a gRPC or GraphQL endpoint. */
export function callReaches(call: RpcCall, endpoint: ServiceEndpoint): boolean {
  if (endpoint.protocol === 'grpc') {
    return call.protocol === 'grpc' && endpoint.method === 'RPC' && callsRpc(call.name, endpoint.path.split('/').pop() ?? '');
  }
  if (endpoint.protocol === 'graphql') {
    return call.protocol === 'graphql' && call.method === endpoint.method && call.name === endpoint.path;
  }
  return false;
}

/**
 * The file that implements a gRPC service or resolves a GraphQL field, read by convention:
 * `UserServiceImplBase` (Java), `UserServiceServicer` (Python), `UserService.UserServiceBase`
 * (C#), `impl user_service_server::UserService for` (tonic), `@GrpcMethod('UserService')`
 * (NestJS); a `resolve_users` function (Graphene), `@Query(...) users(` (NestJS, TypeGraphQL),
 * or a `users` member of an object that also holds `Query: {` (Apollo resolver maps).
 */
export function implementationPattern(endpoint: ServiceEndpoint): RegExp | null {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (endpoint.protocol === 'grpc' && endpoint.method === 'RPC') {
    const service = escape((endpoint.operationId ?? '').split('.')[0] ?? '');
    if (!service) return null;
    return new RegExp(
      `\\b${service}ImplBase\\b|\\b${service}Servicer\\b|\\b${service}\\.${service}Base\\b|impl\\s+[\\w:]*${service}\\s+for\\b|@GrpcMethod\\(\\s*['"]${service}['"]`,
    );
  }
  if (endpoint.protocol === 'graphql') {
    const field = escape(endpoint.path);
    const decorator = endpoint.method === 'MUTATION' ? 'Mutation' : endpoint.method === 'SUBSCRIPTION' ? 'Subscription' : 'Query';
    return new RegExp(
      `\\bresolve_${field}\\b|@${decorator}\\s*\\([^)]*\\)\\s*(?:async\\s+)?${field}\\s*\\(|\\b${decorator}\\s*:\\s*\\{[\\s\\S]{0,4000}?\\b${field}\\s*[:(]`,
    );
  }
  return null;
}

function stripComments(content: string): string {
  // Keep offsets: replace comment text with spaces rather than removing it.
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length));
}

function blankGraphqlComments(text: string): string {
  return text
    .replace(/"""[\s\S]*?"""/g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/#[^\n]*/g, (match) => ' '.repeat(match.length));
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return text.length;
}

function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function readText(root: string, file: string): string | null {
  try {
    const absolute = path.join(root, file);
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const content = fs.readFileSync(absolute);
    return content.includes(0) ? null : content.toString('utf8');
  } catch {
    return null;
  }
}
