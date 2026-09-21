import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import express from 'express';

import { computeRepositoryPassport, createStraboRouter, detectEntryPoints, scanRepository } from '../../src/index.ts';
import type { Graph } from '../../src/index.ts';
import { createSettingsStore } from '../../src/state/settings-store.ts';

const created: string[] = [];
const servers: Array<ReturnType<typeof express.application.listen>> = [];

after(() => {
  for (const server of servers) {
    server.close();
  }
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-passport-'));
  created.push(directory);
  return directory;
}

function write(root: string, relative: string, content: string): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

test('detectEntryPoints reads package.json main, bin, and exports', () => {
  const root = tempDir();
  write(
    root,
    'package.json',
    JSON.stringify({
      name: 'demo',
      main: './src/main.ts',
      bin: { demo: './bin/cli.js' },
      exports: { '.': { import: './src/index.ts' } },
    }),
  );
  const files = ['src/main.ts', 'src/index.ts', 'bin/cli.js', 'src/other.ts'];

  const entries = detectEntryPoints(root, files);
  assert.deepEqual(
    entries.map((entry) => [entry.file, entry.reason]),
    [
      ['bin/cli.js', 'package.json bin'],
      ['src/index.ts', 'package.json exports'],
      ['src/main.ts', 'package.json main'],
    ],
  );
  assert.equal(entries[0]?.source, 'package.json');
});

test('detectEntryPoints resolves a Cargo bin and the src/main.rs convention', () => {
  const root = tempDir();
  write(root, 'Cargo.toml', '[package]\nname = "demo"\n\n[[bin]]\nname = "app"\npath = "src/app.rs"\n');
  const withBin = detectEntryPoints(root, ['src/app.rs', 'src/lib.rs']);
  assert.deepEqual(
    withBin.map((entry) => [entry.file, entry.reason]),
    [['src/app.rs', 'Cargo.toml [[bin]]']],
  );

  const root2 = tempDir();
  write(root2, 'Cargo.toml', '[package]\nname = "demo"\n');
  const conventional = detectEntryPoints(root2, ['src/main.rs', 'src/model.rs']);
  assert.deepEqual(
    conventional.map((entry) => [entry.file, entry.reason]),
    [['src/main.rs', 'Cargo.toml bin']],
  );
});

test('detectEntryPoints maps a Maven mainClass to its source file', () => {
  const root = tempDir();
  write(
    root,
    'pom.xml',
    '<project><properties><mainClass>com.example.Main</mainClass></properties></project>',
  );
  const entries = detectEntryPoints(root, ['src/main/java/com/example/Main.java', 'com/example/Other.java']);
  assert.deepEqual(
    entries.map((entry) => [entry.file, entry.reason]),
    [['src/main/java/com/example/Main.java', 'pom.xml mainClass']],
  );
});

test('scanRepository marks a declared entry point with its own kind and reason', async () => {
  const root = tempDir();
  write(root, 'package.json', JSON.stringify({ name: 'demo', main: './src/main.ts' }));
  write(root, 'src/main.ts', "import { helper } from './helper.ts';\nexport const start = helper;\n");
  write(root, 'src/helper.ts', 'export const helper = 1;\n');

  const report = await scanRepository(root);
  const entry = report.graph.nodes.find((node) => node.id === 'src/main.ts');
  const helper = report.graph.nodes.find((node) => node.id === 'src/helper.ts');

  assert.equal(entry?.kind, 'entry');
  assert.equal(entry?.entryReason, 'package.json main');
  assert.equal(helper?.kind, 'module');
});

test('computeRepositoryPassport ranks top files by fan-in and reports layers, cycles, and untested', () => {
  const graph: Graph = {
    nodes: [
      { id: 'test.ts', kind: 'test', directory: '.' },
      { id: 'a/index.ts', kind: 'module', directory: 'a' },
      { id: 'a/util.ts', kind: 'module', directory: 'a' },
      { id: 'b/thing.ts', kind: 'entry', directory: 'b', entryReason: 'package.json main' },
      { id: 'b/orphan.ts', kind: 'module', directory: 'b' },
    ],
    edges: [
      { source: 'test.ts', target: 'a/index.ts', kind: 'import', evidence: { line: 1, specifier: './a', resolution: 'exact' } },
      { source: 'a/index.ts', target: 'a/util.ts', kind: 'import', evidence: { line: 1, specifier: './util', resolution: 'exact' } },
      { source: 'b/thing.ts', target: 'a/util.ts', kind: 'import', evidence: { line: 2, specifier: '../a/util', resolution: 'exact' } },
      // b/orphan.ts is used by b/thing.ts but neither is reachable from a test.
      { source: 'b/thing.ts', target: 'b/orphan.ts', kind: 'import', evidence: { line: 4, specifier: './orphan', resolution: 'exact' } },
      // a mutual pair so the cycle section has evidence.
      { source: 'a/util.ts', target: 'a/index.ts', kind: 'import', evidence: { line: 3, specifier: './index', resolution: 'exact' } },
    ],
    diagnostics: [],
    excluded: [],
  };

  const passport = computeRepositoryPassport('demo', graph, { '.ts': 5 });

  assert.equal(passport.size.files, 5);
  assert.equal(passport.size.edges, 5);
  assert.equal(passport.size.tests, 1);
  assert.equal(passport.languages[0]?.language, 'TypeScript');
  assert.deepEqual(passport.entryPoints, [
    { file: 'b/thing.ts', reason: 'package.json main' },
  ]);
  // a/index.ts and a/util.ts each have fan-in 2; a/index.ts decides a larger area, so the
  // transitive-dependent tie-break puts it first.
  assert.equal(passport.topFiles[0]?.id, 'a/index.ts');
  assert.equal(passport.topFiles[0]?.fanIn, 2);
  assert.equal(passport.topFiles[0]?.transitiveDependents, 3);
  assert.equal(passport.cycles.total, 1);
  assert.deepEqual(passport.cycles.largest[0]?.members, ['a/index.ts', 'a/util.ts']);
  assert.deepEqual(
    passport.layers.map((layer) => layer.directory).sort(),
    ['.', 'a', 'b'],
  );
  assert.ok(passport.untested.files.includes('b/orphan.ts'));
});

test('GET /analysis/passport serves the scan-derived passport', async () => {
  const root = tempDir();
  write(root, 'package.json', JSON.stringify({ name: 'demo', main: './src/main.ts' }));
  write(root, 'src/main.ts', "import { helper } from './helper.ts';\nexport const start = helper;\n");
  write(root, 'src/helper.ts', 'export const helper = 1;\n');

  const host = express();
  host.use(express.json());
  // A settings store with no persisted overrides, so an operator's saved ceiling cannot
  // narrow the temp root out from under the request.
  host.use(
    '/api/strabo',
    createStraboRouter(
      { workspaceRoot: root, scanCeiling: root },
      undefined,
      createSettingsStore({ file: path.join(root, 'settings.json') }),
    ),
  );
  const base = await new Promise<string>((resolve) => {
    const server = host.listen(0, '127.0.0.1', () => {
      servers.push(server);
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

  const response = await fetch(`${base}/api/strabo/analysis/passport`);
  assert.equal(response.status, 200);
  const passport = (await response.json()) as {
    entryPoints: Array<{ file: string; reason: string }>;
    topFiles: Array<{ id: string; fanIn: number }>;
    size: { files: number };
  };

  assert.deepEqual(passport.entryPoints, [{ file: 'src/main.ts', reason: 'package.json main' }]);
  assert.equal(passport.size.files, 2);
  // helper.ts is imported by main.ts, so it leads the fan-in ranking.
  assert.equal(passport.topFiles[0]?.id, 'src/helper.ts');
  assert.equal(passport.topFiles[0]?.fanIn, 1);
});
