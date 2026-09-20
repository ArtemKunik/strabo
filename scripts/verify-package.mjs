import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Release readiness check.
 *
 * Packs the real tarball, asserts the published file set, installs it into a clean
 * consumer project, and exercises the shipped entry points (`strabo`, `strabo/server`)
 * including a language resolver so packaged grammar assets are proven to load.
 *
 * Opt-in via `npm run test:pack`; it installs dependencies and is not part of `npm test`.
 */

const repoRoot = process.cwd();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-pack-'));
const packDir = path.join(work, 'pack');
const consumer = path.join(work, 'consumer');
fs.mkdirSync(packDir, { recursive: true });
fs.mkdirSync(consumer, { recursive: true });

const failures = [];
const check = (condition, message) => {
  if (condition) {
    console.log(`  ok  ${message}`);
  } else {
    failures.push(message);
    console.log(`  FAIL ${message}`);
  }
};

try {
  console.log('Packing...');
  const packed = execSync(`npm pack --pack-destination "${packDir}"`, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
    .toString()
    .trim()
    .split('\n')
    .at(-1);
  const tarball = path.join(packDir, packed);
  check(fs.existsSync(tarball), `tarball created: ${packed}`);

  const entries = execSync(`tar -tzf "${tarball}"`, { cwd: repoRoot })
    .toString()
    .split('\n')
    .map((line) => line.replace(/^package\//, '').trim())
    .filter(Boolean);

  console.log('Checking published file set...');
  for (const required of [
    'dist/index.js',
    'dist/server.js',
    'dist/cli.js',
    'bin/strabo.js',
    'public/index.html',
    'public/strabo.bundle.js',
    'parsers/vendor/java/tree-sitter-java.wasm',
    'parsers/vendor/rust/tree-sitter-rust.wasm',
    'parsers/vendor/c_sharp/tree-sitter-c_sharp.wasm',
    'parsers/vendor/kotlin/tree-sitter-kotlin.wasm',
    'parsers/vendor/sql/tree-sitter-sql.wasm',
    'README.md',
  ]) {
    check(entries.includes(required), `includes ${required}`);
  }
  for (const forbidden of ['src/index.ts', 'ui/strabo.js', 'test/unit/scan.test.ts', 'node_modules/express/package.json']) {
    check(!entries.includes(forbidden), `excludes ${forbidden}`);
  }

  console.log('Installing into a clean consumer...');
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify({ name: 'strabo-consumer', private: true, type: 'module' }, null, 2),
  );
  execSync(`npm install --no-audit --no-fund "${tarball}"`, { cwd: consumer, stdio: ['ignore', 'inherit', 'inherit'] });

  // A tiny repository so the shipped scanner and a grammar-backed resolver both run.
  const repo = path.join(consumer, 'repo');
  fs.mkdirSync(path.join(repo, 'src', 'main', 'java', 'com', 'acme'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'main', 'java', 'com', 'acme', 'Helper.java'), 'package com.acme;\npublic class Helper {}\n');
  fs.writeFileSync(
    path.join(repo, 'src', 'main', 'java', 'com', 'acme', 'Main.java'),
    'package com.acme;\nimport com.acme.Helper;\npublic class Main { private Helper helper; }\n',
  );

  fs.writeFileSync(
    path.join(consumer, 'verify.mjs'),
    `import assert from 'node:assert/strict';
import path from 'node:path';
import { scanRepository } from 'strabo';
import { createStraboServer } from 'strabo/server';

const repo = path.join(import.meta.dirname, 'repo');
const report = await scanRepository(repo);
const ids = report.graph.nodes.map((node) => node.id);
assert.ok(ids.includes('src/main/java/com/acme/Main.java'), 'java file scanned');
assert.ok(
  report.graph.edges.some((edge) => edge.source.endsWith('Main.java') && edge.target.endsWith('Helper.java')),
  'java import resolved using packaged grammar assets',
);
assert.ok(
  !report.graph.diagnostics.some((d) => /No parser grammar available/.test(d.message)),
  'grammar loaded from the package',
);

const server = createStraboServer({ workspaceRoot: repo });
const httpServer = server.listen(0);
await new Promise((resolve) => httpServer.once('listening', resolve));
const { port } = httpServer.address();
const health = await fetch('http://127.0.0.1:' + port + '/api/strabo/health');
assert.deepEqual(await health.json(), { ok: true });
httpServer.close();
console.log('consumer verification passed');
`,
  );

  console.log('Running the shipped package in the consumer...');
  const output = execSync('node verify.mjs', { cwd: consumer }).toString().trim();
  check(output.includes('consumer verification passed'), 'installed package scans, resolves Java, and serves');
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.error(error);
} finally {
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

if (failures.length > 0) {
  console.error(`\nRelease readiness FAILED (${failures.length}):`);
  for (const failure of failures) {
    console.error(` - ${failure}`);
  }
  process.exit(1);
}
console.log('\nRelease readiness passed.');
