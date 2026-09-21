import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  computeServiceFlows,
  extractServiceCalls,
  extractServiceEndpoints,
  locateTarget,
} from '../../src/index.ts';
import type { RepoServiceFact, ServiceCall, ServiceEndpoint } from '../../src/index.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(prefix = 'strabo-svc-'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(directory);
  return directory;
}

function write(root: string, file: string, content: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

test('extractServiceEndpoints reads OpenAPI operations with the server prefix and host', () => {
  const root = tempDir();
  write(
    root,
    'openapi.json',
    JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Users', version: '1' },
      servers: [{ url: 'https://api.acme.test/v1' }],
      paths: {
        '/users': { get: {}, post: {} },
        '/users/{id}': { delete: {} },
      },
    }),
  );

  const endpoints = extractServiceEndpoints(root, 'users-api');
  assert.deepEqual(
    endpoints.map((entry) => [entry.method, entry.path, entry.host]),
    [
      ['GET', '/v1/users', 'api.acme.test'],
      ['POST', '/v1/users', 'api.acme.test'],
      ['DELETE', '/v1/users/{id}', 'api.acme.test'],
    ],
  );
  assert.ok(endpoints.every((entry) => entry.repository === 'users-api' && entry.source === 'openapi.json'));
});

test('extractServiceEndpoints reads Swagger 2 host/basePath and leaves a templated server hostless', () => {
  const root = tempDir();
  write(
    root,
    'swagger.yaml',
    'swagger: "2.0"\nhost: api.legacy.test\nbasePath: /api\nschemes: [https]\npaths:\n  /ping:\n    get: {}\n',
  );
  write(
    root,
    'templated.json',
    JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      servers: [{ url: 'https://{tenant}.acme.test' }],
      paths: { '/health': { get: {} } },
    }),
  );

  const endpoints = extractServiceEndpoints(root, 'legacy');
  const ping = endpoints.find((entry) => entry.source === 'swagger.yaml');
  assert.deepEqual([ping?.method, ping?.path, ping?.host], ['GET', '/api/ping', 'api.legacy.test']);

  const health = endpoints.find((entry) => entry.source === 'templated.json');
  assert.equal(health?.host, null);
  assert.equal(health?.path, '/health');
});

test('extractServiceCalls records verb calls and fetch with their method and location', () => {
  const root = tempDir();
  write(
    root,
    'src/a.ts',
    [
      "const a = await fetch('https://api.acme.test/v1/users');",
      "const b = await fetch('/v1/orders', { method: 'POST' });",
      "const c = await axios.put('https://api.acme.test/v1/users/1');",
      'const d = fetch(`/v1/users/${id}`);',
      "const e = map.get('key');",
    ].join('\n') + '\n',
  );

  const calls = extractServiceCalls(root);
  assert.deepEqual(
    calls.map((entry) => [entry.line, entry.method, entry.host, entry.path]),
    [
      [1, 'GET', 'api.acme.test', '/v1/users'],
      [2, 'POST', null, '/v1/orders'],
      [3, 'PUT', 'api.acme.test', '/v1/users/1'],
      [4, 'GET', null, null],
    ],
  );
  assert.ok(calls.every((entry) => entry.file === 'src/a.ts'));
});

test('extractServiceCalls reads Python, C#, Rust, and JVM HTTP clients', () => {
  const root = tempDir();
  write(root, 'app.py', "requests.post('https://api.acme.test/v1/users', json={})\n");
  write(root, 'Client.cs', 'await client.GetAsync("https://api.acme.test/v1/users");\n');
  write(root, 'lib.rs', 'reqwest::get("https://api.acme.test/v1/users").await;\n');
  write(root, 'Api.java', 'new Request.Builder().url("https://api.acme.test/v1/users").build();\n');

  const calls = extractServiceCalls(root);
  const byFile = new Map(calls.map((entry) => [entry.file, entry]));
  assert.deepEqual([byFile.get('app.py')?.method, byFile.get('app.py')?.path], ['POST', '/v1/users']);
  assert.deepEqual([byFile.get('Client.cs')?.method, byFile.get('Client.cs')?.path], ['GET', '/v1/users']);
  assert.deepEqual([byFile.get('lib.rs')?.method, byFile.get('lib.rs')?.path], ['GET', '/v1/users']);
  assert.deepEqual([byFile.get('Api.java')?.method, byFile.get('Api.java')?.host], [null, 'api.acme.test']);
});

test('locateTarget splits absolute URLs and rejects an interpolated template', () => {
  assert.deepEqual(locateTarget('https://api.acme.test/v1/users?page=2'), {
    host: 'api.acme.test',
    path: '/v1/users',
  });
  assert.deepEqual(locateTarget('/v1/users/'), { host: null, path: '/v1/users' });
  assert.deepEqual(locateTarget('/v1/users/${id}'), { host: null, path: null });
  assert.deepEqual(locateTarget('users'), { host: null, path: null });
});

const endpoint = (over: Partial<ServiceEndpoint> = {}): ServiceEndpoint => ({
  repository: 'users-api',
  source: 'openapi.json',
  method: 'GET',
  path: '/v1/users',
  host: 'api.acme.test',
  ...over,
});

const call = (over: Partial<ServiceCall> = {}): ServiceCall => ({
  file: 'src/a.ts',
  line: 1,
  method: 'GET',
  target: 'https://api.acme.test/v1/users',
  host: 'api.acme.test',
  path: '/v1/users',
  ...over,
});

test('computeServiceFlows joins a recorded call to a declared endpoint', () => {
  const facts: RepoServiceFact[] = [
    { name: 'users-api', endpoints: [endpoint()], calls: [] },
    { name: 'web', endpoints: [], calls: [call()] },
  ];

  const flows = computeServiceFlows(facts);
  assert.equal(flows.length, 1);
  const flow = flows[0];
  assert.ok(flow);
  assert.equal(flow.from, 'web');
  assert.equal(flow.to, 'users-api');
  assert.equal(flow.method, 'GET');
  assert.equal(flow.path, '/v1/users');
  assert.equal(flow.host, 'api.acme.test');
  assert.equal(flow.declaredBy, 'openapi.json');
  assert.deepEqual(flow.calls.map((entry) => [entry.file, entry.line]), [['src/a.ts', 1]]);
});

test('computeServiceFlows requires a host and a method that agree', () => {
  const facts: RepoServiceFact[] = [
    { name: 'users-api', endpoints: [endpoint()], calls: [] },
    {
      name: 'web',
      endpoints: [],
      calls: [
        call({ file: 'src/host.ts', host: null, path: '/v1/users' }),
        call({ file: 'src/other-host.ts', host: 'other.test' }),
        call({ file: 'src/method.ts', method: 'POST' }),
      ],
    },
  ];

  assert.deepEqual(computeServiceFlows(facts), []);
});

test('computeServiceFlows joins a method-less call only when the method is unambiguous', () => {
  const unambiguous = computeServiceFlows([
    { name: 'users-api', endpoints: [endpoint()], calls: [] },
    { name: 'web', endpoints: [], calls: [call({ method: null })] },
  ]);
  assert.equal(unambiguous.length, 1);

  const ambiguous = computeServiceFlows([
    { name: 'users-api', endpoints: [endpoint(), endpoint({ method: 'POST' })], calls: [] },
    { name: 'web', endpoints: [], calls: [call({ method: null })] },
  ]);
  assert.deepEqual(ambiguous, []);
});

test('computeServiceFlows skips a self-call and emits a flow per declaring repository', () => {
  const self = computeServiceFlows([
    { name: 'users-api', endpoints: [endpoint()], calls: [call()] },
  ]);
  assert.deepEqual(self, []);

  const shared = computeServiceFlows([
    { name: 'users-api', endpoints: [endpoint()], calls: [] },
    { name: 'users-api-fork', endpoints: [endpoint({ repository: 'users-api-fork' })], calls: [] },
    { name: 'web', endpoints: [], calls: [call()] },
  ]);
  assert.deepEqual(shared.map((flow) => flow.to), ['users-api', 'users-api-fork']);
});
