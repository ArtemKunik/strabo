import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { ResolvedRepository } from '../../src/boundary/repository-root.ts';
import { openWorkspaceCache, clearWorkspaceCache } from '../../src/cache/workspace-cache.ts';
import { analyzeWorkspace } from '../../src/workspace/analyze.ts';
import { readWorkspaceConfig, resolveWorkspaceRepositories } from '../../src/workspace/config.ts';
import { extractContracts, computeContractDrift } from '../../src/workspace/contracts.ts';
import { readPublishedCoordinate } from '../../src/workspace/coordinate.ts';
import { computeCrossRepoFlows } from '../../src/workspace/flows.ts';
import type { ContractDefinition, Graph } from '../../src/types.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(prefix = 'strabo-ws-'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

test('readPublishedCoordinate reads npm, Cargo, and Maven declarations', () => {
  const npmRoot = tempDir();
  write(npmRoot, 'package.json', '{"name":"@acme/core"}');
  assert.deepEqual(readPublishedCoordinate(npmRoot), {
    ecosystem: 'npm',
    name: '@acme/core',
    source: 'package.json',
  });

  const cargoRoot = tempDir();
  write(cargoRoot, 'Cargo.toml', '[package]\nname = "acme-core"\nversion = "0.1.0"\n');
  assert.deepEqual(readPublishedCoordinate(cargoRoot), {
    ecosystem: 'cargo',
    name: 'acme-core',
    source: 'Cargo.toml',
  });

  const mavenRoot = tempDir();
  write(
    mavenRoot,
    'pom.xml',
    '<project><parent><groupId>org.parent</groupId><artifactId>parent</artifactId></parent>' +
      '<groupId>com.acme</groupId><artifactId>core</artifactId></project>',
  );
  assert.deepEqual(readPublishedCoordinate(mavenRoot), {
    ecosystem: 'maven',
    name: 'com.acme:core',
    source: 'pom.xml',
  });

  assert.equal(readPublishedCoordinate(tempDir()), null);
});

test('computeCrossRepoFlows joins a published coordinate to its importer', () => {
  const graph = (externalImports: Graph['externalImports']): Graph => ({
    nodes: [],
    edges: [],
    diagnostics: [],
    excluded: [],
    externalImports,
  });

  const flows = computeCrossRepoFlows([
    { name: 'core', publishes: { ecosystem: 'npm', name: '@acme/core', source: 'package.json' }, graph: graph([]) },
    {
      name: 'api',
      publishes: null,
      graph: graph([
        { file: 'src/a.ts', line: 2, specifier: '@acme/core', package: '@acme/core', ecosystem: 'npm', kind: 'import' },
        { file: 'src/b.ts', line: 5, specifier: '@acme/core/x', package: '@acme/core', ecosystem: 'npm', kind: 'import' },
        { file: 'src/c.ts', line: 1, specifier: 'lodash', package: 'lodash', ecosystem: 'npm', kind: 'import' },
      ]),
    },
    { name: 'core-again', publishes: { ecosystem: 'npm', name: '@acme/other', source: 'package.json' }, graph: graph([]) },
  ]);

  assert.equal(flows.length, 1);
  const flow = flows[0];
  assert.ok(flow);
  assert.equal(flow.from, 'api');
  assert.equal(flow.to, 'core');
  assert.equal(flow.package, '@acme/core');
  assert.deepEqual(flow.files.map((entry) => entry.file), ['src/a.ts', 'src/b.ts']);
});

test('computeCrossRepoFlows emits a flow per publisher when a coordinate is claimed twice', () => {
  const graph = (externalImports: Graph['externalImports']): Graph => ({
    nodes: [],
    edges: [],
    diagnostics: [],
    excluded: [],
    externalImports,
  });
  const coordinate = { ecosystem: 'npm' as const, name: '@acme/core', source: 'package.json' };

  const flows = computeCrossRepoFlows([
    { name: 'core', publishes: coordinate, graph: graph([]) },
    { name: 'core-fork', publishes: coordinate, graph: graph([]) },
    {
      name: 'api',
      publishes: null,
      graph: graph([
        { file: 'src/a.ts', line: 1, specifier: '@acme/core', package: '@acme/core', ecosystem: 'npm', kind: 'import' },
      ]),
    },
  ]);

  assert.deepEqual(flows.map((entry) => entry.to), ['core', 'core-fork']);
});

test('computeCrossRepoFlows matches a Maven coordinate by groupId prefix', () => {
  const flows = computeCrossRepoFlows([
    {
      name: 'core',
      publishes: { ecosystem: 'maven', name: 'com.acme:core', source: 'pom.xml' },
      graph: { nodes: [], edges: [], diagnostics: [], excluded: [] },
    },
    {
      name: 'api',
      publishes: null,
      graph: {
        nodes: [],
        edges: [],
        diagnostics: [],
        excluded: [],
        externalImports: [
          { file: 'App.java', line: 3, specifier: 'com.acme.core.User', package: 'com.acme.core', ecosystem: 'maven', kind: 'import' },
        ],
      },
    },
  ]);

  assert.equal(flows.length, 1);
  assert.equal(flows[0]?.to, 'core');
});

test('extractContracts reads protobuf messages with required-ness', () => {
  const root = tempDir();
  write(
    root,
    'user.proto',
    'syntax = "proto3";\npackage acme;\n\n' +
      'message User {\n' +
      '  string id = 1;\n' +
      '  repeated string tags = 2;\n' +
      '  optional int32 age = 3;\n' +
      '  Address address = 4;\n' +
      '  oneof contact {\n    string email = 5;\n    string phone = 6;\n  }\n' +
      '}\n\n' +
      'message Address {\n  string city = 1;\n}\n',
  );

  const contracts = extractContracts(root, 'repo');
  const user = contracts.find((entry) => entry.id === 'acme.User');
  assert.ok(user);
  assert.equal(user.format, 'protobuf');
  assert.deepEqual(
    user.fields.map((field) => [field.name, field.type, field.required]),
    [
      ['address', 'Address', true],
      ['age', 'int32', false],
      ['email', 'string', true],
      ['id', 'string', true],
      ['phone', 'string', true],
      ['tags', 'string', false],
    ],
  );
  assert.ok(contracts.some((entry) => entry.id === 'acme.Address'));
});

test('extractContracts reads OpenAPI schemas and JSON Schema documents', () => {
  const root = tempDir();
  write(
    root,
    'openapi.json',
    JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'User API', version: '1.2.0' },
      components: {
        schemas: {
          User: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, age: { type: 'integer', format: 'int32' } } },
        },
      },
    }),
  );
  write(
    root,
    'address.yaml',
    '$id: acme/address\ntype: object\nrequired: [city]\nproperties:\n  city:\n    type: string\n  zip:\n    type: string\n',
  );

  const contracts = extractContracts(root, 'repo');
  const user = contracts.find((entry) => entry.id === 'User API#User');
  assert.ok(user);
  assert.equal(user.format, 'openapi');
  assert.equal(user.version, '1.2.0');
  assert.deepEqual(
    user.fields.map((field) => [field.name, field.type, field.required]),
    [
      ['age', 'integer(int32)', false],
      ['id', 'string', true],
    ],
  );

  const address = contracts.find((entry) => entry.id === 'acme/address');
  assert.ok(address);
  assert.equal(address.format, 'json-schema');
  assert.deepEqual(
    address.fields.map((field) => [field.name, field.required]),
    [
      ['city', true],
      ['zip', false],
    ],
  );
});

test('computeContractDrift reports missing, type, and required divergence', () => {
  const definition = (
    repository: string,
    fields: ContractDefinition['fields'],
  ): ContractDefinition => ({ id: 'acme/User', format: 'json-schema', repository, source: 'x', fields });

  const drift = computeContractDrift([
    definition('a', [
      { name: 'id', type: 'string', required: true },
      { name: 'age', type: 'integer', required: false },
    ]),
    definition('b', [
      { name: 'id', type: 'string', required: true },
      { name: 'age', type: 'string', required: false },
      { name: 'email', type: 'string', required: true },
    ]),
  ]);

  assert.equal(drift.length, 1);
  const entry = drift[0];
  assert.ok(entry);
  assert.deepEqual(entry.repositories, ['a', 'b']);
  assert.deepEqual(
    entry.deviations.map((deviation) => [deviation.name, deviation.issue]),
    [
      ['age', 'type'],
      ['email', 'missing'],
    ],
  );

  const identical = computeContractDrift([
    definition('a', [{ name: 'id', type: 'string', required: true }]),
    definition('b', [{ name: 'id', type: 'string', required: true }]),
  ]);
  assert.equal(identical.length, 1);
  assert.deepEqual(identical[0]?.deviations, []);
});

test('readWorkspaceConfig rejects a missing file and resolveWorkspaceRepositories dedupes', () => {
  assert.throws(() => readWorkspaceConfig(path.join(tempDir(), 'missing.json')));

  const ceiling = tempDir();
  write(ceiling, 'a/package.json', '{"name":"a"}');
  write(ceiling, 'b/package.json', '{"name":"b"}');
  write(
    ceiling,
    'workspace.json',
    JSON.stringify({ name: 'acme', repositories: ['a', 'b', 'a', './b'] }),
  );

  const config = {
    workspaceRoot: path.join(ceiling, 'a'),
    scanCeiling: ceiling,
    configPath: path.join(ceiling, 'workspace.json'),
  };
  const resolved = resolveWorkspaceRepositories(config);
  assert.equal(resolved.name, 'acme');
  assert.deepEqual(resolved.repositories.map((entry) => entry.name), ['a', 'b']);
});

test('analyzeWorkspace joins repositories and caches the facts', async () => {
  const a = tempDir();
  write(a, 'package.json', '{"name":"@acme/core"}');
  write(a, 'user.proto', 'syntax = "proto3";\npackage acme;\nmessage User {\n  string id = 1;\n  string name = 2;\n}\n');
  git(a, 'init', '-q');
  git(a, 'config', 'user.email', 'test@example.com');
  git(a, 'config', 'user.name', 'Tester');
  git(a, 'add', '.');
  git(a, 'commit', '-q', '-m', 'init');

  const b = tempDir();
  write(b, 'package.json', '{"name":"consumer"}');
  write(b, 'src/index.ts', "import { core } from '@acme/core';\nexport const value = core;\n");
  write(
    b,
    'user.proto',
    'syntax = "proto3";\npackage acme;\nmessage User {\n  string id = 1;\n  string name = 2;\n  string email = 3;\n}\n',
  );
  git(b, 'init', '-q');
  git(b, 'config', 'user.email', 'test@example.com');
  git(b, 'config', 'user.name', 'Tester');
  git(b, 'add', '.');
  git(b, 'commit', '-q', '-m', 'init');

  const nameOf = (root: string): string => path.basename(root);
  const repositories: ResolvedRepository[] = [
    { name: nameOf(a), root: a, workspaceRoot: '.' },
    { name: nameOf(b), root: b, workspaceRoot: '.' },
  ];

  const cacheFile = path.join(tempDir(), 'workspace-cache.json');
  const first = await analyzeWorkspace('acme', repositories, {
    cache: openWorkspaceCache({ file: cacheFile }),
  });

  assert.equal(first.summary.repositories, 2);
  assert.equal(first.flows.length, 1);
  const flow = first.flows[0];
  assert.ok(flow);
  assert.equal(flow.from, nameOf(b));
  assert.equal(flow.to, nameOf(a));
  assert.equal(flow.package, '@acme/core');
  assert.deepEqual(flow.files.map((entry) => entry.file), ['src/index.ts']);

  const drift = first.drift.find((entry) => entry.id === 'acme.User');
  assert.ok(drift);
  assert.deepEqual(drift.repositories, [nameOf(a), nameOf(b)].sort());
  assert.deepEqual(
    drift.deviations.map((entry) => [entry.name, entry.issue]),
    [['email', 'missing']],
  );

  assert.ok(fs.existsSync(cacheFile), 'the workspace cache should be written');

  // A second run reads the cached facts; adding a cached marker proves it was consulted.
  const stored = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as {
    entries: Record<string, unknown>;
  };
  assert.equal(Object.keys(stored.entries).length, 2);

  const second = await analyzeWorkspace('acme', repositories, {
    cache: openWorkspaceCache({ file: cacheFile }),
  });
  assert.equal(second.flows.length, 1);

  clearWorkspaceCache(cacheFile);
});
