import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { computeHttpApiDiff, diffHttpApi, extractServiceEndpoints, typeWidens } from '../../src/index.ts';
import type { ServiceCall, ServiceEndpoint } from '../../src/index.ts';
import { parseFailOnRules } from '../../src/check/check.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-http-diff-'));
  created.push(directory);
  return directory;
}

function write(root: string, file: string, content: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
}

function operation(method: string, routePath: string, extra: Partial<ServiceEndpoint> = {}): ServiceEndpoint {
  return { repository: 'svc', source: 'openapi.yaml', method, path: routePath, host: 'api.acme.test', origin: 'openapi', ...extra };
}

function call(file: string, line: number, method: string | null, target: string, host: string | null, callPath: string): ServiceCall {
  return { file, line, method, target, host, path: callPath };
}

const field = (name: string, type: string, required: boolean) => ({ name, type, required });

test('typeWidens accepts dropped formats, wider integers, and integer to number only', () => {
  assert.equal(typeWidens('string(email)', 'string'), true);
  assert.equal(typeWidens('integer(int32)', 'integer(int64)'), true);
  assert.equal(typeWidens('integer', 'number'), true);
  assert.equal(typeWidens('array<integer(int32)>', 'array<integer(int64)>'), true);
  assert.equal(typeWidens('string', 'string(email)'), false);
  assert.equal(typeWidens('number', 'integer'), false);
  assert.equal(typeWidens('string', 'integer'), false);
});

test('diffHttpApi classifies operations, parameters, and bodies from the side that adapts', () => {
  const before = [
    operation('GET', '/users/{id}', {
      parameters: [
        { name: 'id', in: 'path', required: true, type: 'string' },
        { name: 'expand', in: 'query', required: false, type: 'string' },
        { name: 'limit', in: 'query', required: false, type: 'integer(int32)' },
      ],
      response: { schema: 'User', fields: [field('id', 'string', true), field('email', 'string', true), field('age', 'integer', false)] },
    }),
    operation('POST', '/users', {
      request: { schema: 'NewUser', fields: [field('name', 'string', true), field('nickname', 'string', false)] },
    }),
    operation('DELETE', '/users/{id}'),
  ];
  const after = [
    operation('GET', '/users/{userId}', {
      parameters: [
        { name: 'userId', in: 'path', required: true, type: 'string' },
        { name: 'limit', in: 'query', required: false, type: 'integer(int64)' },
        { name: 'tenant', in: 'header', required: true, type: 'string' },
      ],
      response: { schema: 'User', fields: [field('id', 'string', true), field('age', 'number', false), field('name', 'string', true)] },
    }),
    operation('POST', '/users', {
      request: { schema: 'NewUser', fields: [field('name', 'string', true), field('email', 'string', true)] },
    }),
    operation('GET', '/health'),
  ];
  const calls = [
    call('src/client.ts', 4, 'GET', '/users/42', null, '/users/42'),
    call('src/client.ts', 9, 'DELETE', 'https://api.acme.test/users/7', 'api.acme.test', '/users/7'),
    call('src/other.ts', 2, 'DELETE', 'https://elsewhere.test/users/7', 'elsewhere.test', '/users/7'),
  ];
  const siblings = [
    { repository: 'web', calls: [call('app/api.ts', 12, 'DELETE', 'https://api.acme.test/users/1', 'api.acme.test', '/users/1')] },
  ];
  const report = diffHttpApi(before, after, { base: 'main', head: null, calls, siblings });

  assert.deepEqual(
    report.changes.map((change) => [change.compatibility, change.method, change.kind, change.subject ?? '']),
    [
      ['breaking', 'POST', 'request-field-added', 'email'],
      ['breaking', 'DELETE', 'operation-removed', ''],
      ['breaking', 'GET', 'parameter-added', 'header:tenant'],
      ['breaking', 'GET', 'response-field-removed', 'email'],
      ['breaking', 'GET', 'response-field-type', 'age'],
      ['conditional', 'POST', 'request-field-removed', 'nickname'],
      ['conditional', 'GET', 'parameter-removed', 'query:expand'],
      ['safe', 'GET', 'operation-added', ''],
      ['safe', 'GET', 'parameter-type', 'query:limit'],
      ['safe', 'GET', 'response-field-added', 'name'],
    ],
  );
  assert.deepEqual(report.totals, { breaking: 5, conditional: 2, safe: 3 });

  const removed = report.changes.find((change) => change.kind === 'operation-removed');
  assert.deepEqual(removed?.callers, [
    { file: 'src/client.ts', line: 9 },
    { repository: 'web', file: 'app/api.ts', line: 12 },
  ]);
  const header = report.changes.find((change) => change.kind === 'parameter-added');
  assert.deepEqual(header?.callers, [{ file: 'src/client.ts', line: 4 }]);
  assert.deepEqual(report.changes.find((change) => change.kind === 'operation-added')?.callers, []);
});

test('a route kept in code is not removed when the document drops it', () => {
  const before = [operation('GET', '/users')];
  const after: ServiceEndpoint[] = [
    { repository: 'svc', source: 'src/app.ts', method: 'GET', path: '/users', host: null, origin: 'code', line: 3 },
  ];
  assert.deepEqual(diffHttpApi(before, after, { base: 'main', head: null }).changes, []);
});

test('extractServiceEndpoints records OpenAPI parameters, following $ref and path-item ones', () => {
  const root = tempDir();
  write(
    root,
    'openapi.json',
    JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Users', version: '1' },
      components: { parameters: { Page: { name: 'page', in: 'query', schema: { type: 'integer', format: 'int32' } } } },
      paths: {
        '/users/{id}': {
          parameters: [{ name: 'id', in: 'path', schema: { type: 'string' } }],
          get: { parameters: [{ $ref: '#/components/parameters/Page' }, { name: 'tag', in: 'query', required: true, schema: { type: 'array', items: { type: 'string' } } }] },
        },
      },
    }),
  );
  const [endpoint] = extractServiceEndpoints(root, 'svc');
  assert.deepEqual(endpoint?.parameters, [
    { name: 'id', in: 'path', required: true, type: 'string' },
    { name: 'page', in: 'query', required: false, type: 'integer(int32)' },
    { name: 'tag', in: 'query', required: true, type: 'array<string>' },
  ]);
});

test('computeHttpApiDiff compares a revision with the working tree, and http-breaking is a rule', async () => {
  const root = tempDir();
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Tester');
  write(root, 'src/server.ts', "app.get('/users', list);\napp.delete('/users/:id', remove);\n");
  write(root, 'src/client.ts', "export const drop = () => fetch('/users/3', { method: 'DELETE' });\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');

  write(root, 'src/server.ts', "app.get('/users', list);\napp.post('/users', create);\n");
  const report = await computeHttpApiDiff(root, 'main');
  assert.equal(report.available, true);
  assert.deepEqual(report.endpoints, { base: 2, head: 2 });
  assert.deepEqual(
    report.changes.map((change) => [change.compatibility, change.kind, change.method, change.path, change.callers]),
    [
      ['breaking', 'operation-removed', 'DELETE', '/users/{id}', [{ file: 'src/client.ts', line: 1 }]],
      ['safe', 'operation-added', 'POST', '/users', []],
    ],
  );

  const missing = await computeHttpApiDiff(root, 'no-such-ref');
  assert.equal(missing.available, false);
  assert.match(missing.reason ?? '', /does not exist/);

  assert.deepEqual(parseFailOnRules(['api-breaking']), ['http-breaking']);
});
