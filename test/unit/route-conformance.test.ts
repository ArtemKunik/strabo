import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  buildRepositoryReport,
  compareRoutes,
  computeRouteConformance,
  renderReportMarkdown,
  scanRepository,
} from '../../src/index.ts';
import { renderReportHtml } from '../../src/report/render-html.ts';
import type { ServiceEndpoint } from '../../src/index.ts';
import { collectFindings, parseFailOnRules } from '../../src/check/check.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-conformance-'));
  created.push(directory);
  return directory;
}

function write(root: string, file: string, content: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function spec(method: string, routePath: string, source = 'openapi.yaml'): ServiceEndpoint {
  return { repository: 'r', source, method, path: routePath, host: null, origin: 'openapi' };
}

function code(method: string, routePath: string, line = 1, source = 'src/app.ts'): ServiceEndpoint {
  return {
    repository: 'r',
    source,
    method,
    path: routePath,
    host: null,
    origin: 'code',
    line,
    framework: 'express',
    handler: null,
  };
}

test('compareRoutes joins exact and renamed-parameter routes and lists both gaps', () => {
  const report = compareRoutes(
    [spec('GET', '/users'), spec('GET', '/users/{userId}'), spec('DELETE', '/users/{userId}'), spec('GET', '/health')],
    [code('GET', '/users', 1), code('GET', '/users/{id}', 2), code('POST', '/users', 3), code('PUT', '/users/{id}', 4)],
  );
  assert.equal(report.available, true);
  assert.deepEqual(
    report.matched.map((match) => [match.method, match.path, match.codePath, match.via]),
    [
      ['GET', '/users', '/users', 'exact'],
      ['GET', '/users/{userId}', '/users/{id}', 'parameters'],
    ],
  );
  assert.deepEqual(
    report.undocumented.map((route) => [route.method, route.path, route.documentedMethods]),
    [
      ['POST', '/users', ['GET']],
      ['PUT', '/users/{id}', ['DELETE', 'GET']],
    ],
  );
  assert.deepEqual(
    report.unimplemented.map((operation) => [operation.method, operation.path, operation.registeredMethods]),
    [
      ['GET', '/health', []],
      ['DELETE', '/users/{userId}', ['GET', 'PUT']],
    ],
  );
  assert.deepEqual(report.totals, { operations: 4, routes: 4, matched: 2, undocumented: 2, unimplemented: 2 });
});

test('compareRoutes joins through a shared prefix but not a one-off one', () => {
  const report = compareRoutes(
    [spec('GET', '/v1/users'), spec('GET', '/v1/orders'), spec('GET', '/v1/admin/users')],
    [code('GET', '/users'), code('GET', '/orders'), code('GET', '/stats')],
  );
  assert.deepEqual(
    report.matched.map((match) => [match.path, match.codePath, match.via, match.prefix]),
    [
      ['/v1/orders', '/orders', 'prefix', { side: 'spec', value: '/v1' }],
      ['/v1/users', '/users', 'prefix', { side: 'spec', value: '/v1' }],
    ],
  );
  assert.deepEqual(report.unimplemented.map((operation) => operation.path), ['/v1/admin/users']);
  assert.deepEqual(report.undocumented.map((route) => route.path), ['/stats']);
});

test('compareRoutes sets aside a document that describes another service', () => {
  const report = compareRoutes(
    [spec('GET', '/users', 'openapi.yaml'), spec('GET', '/charges', 'vendor/stripe.yaml')],
    [code('GET', '/users')],
  );
  assert.deepEqual(
    report.documents.map((document) => [document.file, document.describes]),
    [
      ['openapi.yaml', 'this-repository'],
      ['vendor/stripe.yaml', 'another-service'],
    ],
  );
  assert.deepEqual(report.unimplemented, []);
});

test('compareRoutes is unavailable, with a reason, when a side is missing or nothing joins', () => {
  assert.equal(compareRoutes([], [code('GET', '/x')]).reason, 'no OpenAPI document declares an operation');
  assert.match(compareRoutes([spec('GET', '/x')], []).reason ?? '', /no route registration was read/);
  const unrelated = compareRoutes([spec('GET', '/a')], [code('GET', '/b')]);
  assert.equal(unrelated.available, false);
  assert.match(unrelated.reason ?? '', /no OpenAPI operation matched/);
});

test('computeRouteConformance reads the repository and route-drift becomes check findings', async () => {
  const root = tempDir();
  write(
    root,
    'openapi.json',
    JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Users', version: '1' },
      paths: { '/users': { get: {}, post: {} }, '/users/{id}': { get: {} } },
    }),
  );
  write(
    root,
    'src/server.ts',
    ["app.get('/users', list);", "app.get('/users/:id', show);", "app.delete('/users/:id', remove);"].join('\n'),
  );
  write(root, 'test/server.test.ts', "app.get('/mock-only', stub);\n");

  const { graph } = await scanRepository(root);
  const report = computeRouteConformance(root, graph);
  assert.equal(report.available, true);
  assert.deepEqual(
    report.undocumented.map((route) => [route.method, route.path, route.file, route.line]),
    [['DELETE', '/users/{id}', 'src/server.ts', 3]],
  );
  assert.deepEqual(
    report.unimplemented.map((operation) => [operation.method, operation.path]),
    [['POST', '/users']],
  );

  assert.deepEqual(parseFailOnRules(['route-drift']), ['route-drift']);
  assert.deepEqual(parseFailOnRules(['api-drift']), ['route-drift']);
  const findings = (await collectFindings(root, 'svc', graph, false)).filter((finding) => finding.rule === 'route-drift');
  assert.deepEqual(
    findings.map((finding) => finding.key),
    ['route-drift:undocumented:DELETE /users/{id}', 'route-drift:unimplemented:POST /users'],
  );
  assert.match(findings[0]?.detail ?? '', /src\/server\.ts:3 .*documented for GET/);
});

test('the repository report renders the HTTP API section from the conformance reading', async () => {
  const api = compareRoutes(
    [spec('GET', '/v1/users'), spec('GET', '/v1/orders'), spec('GET', '/v1/gone')],
    [code('GET', '/users', 1), code('GET', '/orders', 2), code('POST', '/orders', 3)],
  );
  const graph = { nodes: [], edges: [], diagnostics: [], excluded: [] };
  const document = buildRepositoryReport({ repository: 'svc', graph, api });
  assert.equal(document.api?.totals.matched, 2);

  const markdown = renderReportMarkdown(document);
  assert.match(markdown, /## HTTP API\n- 3 documented operations · 3 registered routes · 2 joined · 1 undocumented · 1 unimplemented/);
  assert.match(markdown, /joined through the `\/v1` prefix the documents add/);
  assert.match(markdown, /Registered but not documented:\n- `POST \/orders` · `src\/app.ts:3`/);
  assert.match(markdown, /Documented but not registered:\n- `GET \/v1\/gone` · `openapi.yaml`/);

  const html = renderReportHtml(document);
  assert.match(html, /<h2>HTTP API<\/h2>/);
  assert.match(html, /<code>GET \/v1\/gone<\/code>/);

  const absent = renderReportMarkdown(buildRepositoryReport({ repository: 'svc', graph }));
  assert.match(absent, /## HTTP API\n- not included in this report/);
});
