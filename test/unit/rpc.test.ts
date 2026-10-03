import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  computeHttpApiDiff,
  endpointPassport,
  extractServiceEndpoints,
  graphqlEndpointsFromContent,
  grpcEndpointsFromContent,
  listEndpoints,
  rpcCallsFromContent,
  scanRepository,
} from '../../src/index.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-rpc-'));
  created.push(directory);
  return directory;
}

function write(root: string, file: string, content: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

const PROTO = [
  'syntax = "proto3";',
  'package acme.users.v1;',
  '// service Ignored { rpc Nope(A) returns (B); }',
  'service UserService {',
  '  rpc GetUser(GetUserRequest) returns (User) {',
  '    option (google.api.http) = { get: "/v1/users/{id}" };',
  '  }',
  '  rpc WatchUsers(WatchRequest) returns (stream User);',
  '}',
  'message GetUserRequest { string id = 1; }',
  'message User { string id = 1; string email = 2; }',
].join('\n');

const SCHEMA = [
  '"""The root query."""',
  'type Query {',
  '  # a comment',
  '  user(id: ID!, fields: [String] = []): User',
  '  users(first: Int): [User!]!',
  '}',
  'extend type Mutation { deleteUser(id: ID!): Boolean! }',
  'type User { id: ID! email: String }',
].join('\n');

test('grpcEndpointsFromContent reads rpcs, streaming, and a gateway route', () => {
  const messages = new Map([
    ['GetUserRequest', [{ name: 'id', type: 'string', required: false }]],
    ['User', [{ name: 'email', type: 'string', required: false }, { name: 'id', type: 'string', required: false }]],
  ]);
  const endpoints = grpcEndpointsFromContent('svc', 'proto/users.proto', PROTO, messages);
  assert.deepEqual(
    endpoints.map((entry) => [entry.method, entry.path, entry.line, entry.protocol ?? 'http', entry.framework ?? '']),
    [
      ['RPC', '/acme.users.v1.UserService/GetUser', 5, 'grpc', ''],
      ['GET', '/v1/users/{id}', 5, 'http', ''],
      ['RPC', '/acme.users.v1.UserService/WatchUsers', 8, 'grpc', 'server-streaming'],
    ],
  );
  assert.deepEqual(endpoints[0]?.request?.fields.map((field) => field.name), ['id']);
  assert.equal(endpoints[0]?.response?.schema, 'User');
});

test('graphqlEndpointsFromContent reads root fields, arguments, and return-type fields', () => {
  const endpoints = graphqlEndpointsFromContent('svc', 'schema.graphql', SCHEMA);
  assert.deepEqual(
    endpoints.map((entry) => [entry.method, entry.path, entry.line, entry.operationId]),
    [
      ['QUERY', 'user', 4, 'Query.user'],
      ['QUERY', 'users', 5, 'Query.users'],
      ['MUTATION', 'deleteUser', 7, 'Mutation.deleteUser'],
    ],
  );
  assert.deepEqual(endpoints[0]?.parameters, [
    { name: 'id', in: 'argument', required: true, type: 'ID!' },
    { name: 'fields', in: 'argument', required: false, type: '[String]' },
  ]);
  assert.deepEqual(endpoints[1]?.response, {
    schema: 'User',
    fields: [
      { name: 'id', type: 'ID!', required: true },
      { name: 'email', type: 'String', required: false },
    ],
  });

  const inSource = graphqlEndpointsFromContent(
    'svc',
    'src/schema.ts',
    'export const typeDefs = gql`\n  type Query { ping: String }\n`;\n',
  );
  assert.deepEqual(inSource.map((entry) => [entry.method, entry.path, entry.line]), [['QUERY', 'ping', 2]]);
});

test('rpcCallsFromContent reads stub calls and the top-level fields an operation selects', () => {
  const calls = rpcCallsFromContent(
    'src/client.ts',
    [
      'const user = await userClient.getUser({ id });',
      'const list = gql`',
      '  query Users($first: Int) {',
      '    all: users(first: $first) { id email }',
      '    me: user(id: "1") { id }',
      '  }',
      '`;',
      'cache.get(key);',
    ].join('\n'),
  );
  assert.deepEqual(
    calls.map((call) => [call.protocol, call.method, call.name, call.line]),
    [
      ['grpc', 'RPC', 'getUser', 1],
      ['graphql', 'QUERY', 'users', 4],
      ['graphql', 'QUERY', 'user', 5],
    ],
  );
});

test('listEndpoints reads gRPC and GraphQL endpoints with implementations and callers', async () => {
  const root = tempDir();
  write(root, 'proto/users.proto', PROTO);
  write(root, 'schema.graphql', SCHEMA);
  write(root, 'src/UserServiceImpl.java', 'class UserServiceImpl extends UserServiceGrpc.UserServiceImplBase {}\n');
  write(root, 'src/resolvers.ts', 'export const resolvers = { Query: { users: () => [], user: () => null } };\n');
  write(root, 'src/client.ts', 'export const load = (stub: any) => stub.GetUser({ id: "1" });\n');
  write(root, 'web/users.graphql', 'query AllUsers { users { id } }\n');

  const { graph } = await scanRepository(root);
  const report = listEndpoints(root, graph);
  assert.deepEqual(report.totals.byProtocol, { http: 1, grpc: 2, graphql: 3 });

  const getUser = report.endpoints.find((entry) => entry.path === '/acme.users.v1.UserService/GetUser');
  assert.equal(getUser?.protocol, 'grpc');
  assert.deepEqual(getUser?.handler, { name: 'GetUser', file: 'src/UserServiceImpl.java', basis: 'implementation' });
  assert.deepEqual(getUser?.callers, [{ file: 'src/client.ts', line: 1 }]);

  const users = report.endpoints.find((entry) => entry.protocol === 'graphql' && entry.path === 'users');
  assert.deepEqual(users?.handler, { name: 'users', file: 'src/resolvers.ts', basis: 'implementation' });
  assert.deepEqual(users?.callers, [{ file: 'web/users.graphql', line: 1 }]);

  const passport = endpointPassport(root, graph, 'QUERY', 'users');
  assert.equal(passport?.response?.schema, 'User');
  assert.ok(
    extractServiceEndpoints(root, 'svc').some((entry) => entry.protocol === 'graphql' && entry.path === 'deleteUser'),
  );
});

test('computeHttpApiDiff reports a removed rpc and a new required GraphQL argument', async () => {
  const root = tempDir();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Tester');
  write(root, 'proto/users.proto', PROTO);
  write(root, 'schema.graphql', SCHEMA);
  write(root, 'src/client.ts', 'export const watch = (stub: any) => stub.watchUsers({});\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');

  write(root, 'proto/users.proto', PROTO.replace('  rpc WatchUsers(WatchRequest) returns (stream User);\n', ''));
  write(root, 'schema.graphql', SCHEMA.replace('users(first: Int)', 'users(first: Int, tenant: ID!)'));
  const report = await computeHttpApiDiff(root, 'main');
  const breaking = report.changes.filter((change) => change.compatibility === 'breaking');
  assert.deepEqual(
    breaking.map((change) => [change.kind, change.method, change.path, change.subject ?? '', change.callers]),
    [
      ['operation-removed', 'RPC', '/acme.users.v1.UserService/WatchUsers', '', [{ file: 'src/client.ts', line: 1 }]],
      ['parameter-added', 'QUERY', 'users', 'argument:tenant', []],
    ],
  );
});
