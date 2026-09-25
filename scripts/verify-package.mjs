import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Release readiness check.
 *
 * Packs the real tarball, asserts the published file set, installs it into a clean
 * consumer project, and exercises the shipped entry points (`strabo-map`, `strabo-map/server`)
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
    'parsers/vendor/python/tree-sitter-python.wasm',
    'parsers/vendor/cpp/tree-sitter-cpp.wasm',
    'parsers/vendor/typescript/tree-sitter-typescript.wasm',
    'parsers/vendor/tsx/tree-sitter-tsx.wasm',
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

  // One tiny repository holding a representative file per supported language, each with an
  // internal dependency the shipped scanner must resolve. Java proves a package-based
  // resolver; Python a module-tree resolver; Rust a module/use resolver; C# a namespace
  // resolver; Kotlin an import resolver; C++ a quoted-include resolver; SQL a relation
  // resolver; and TypeScript/JavaScript the lexical JS/TS resolver. Every resolved edge
  // exercises the packed grammar set (or, for JS/TS, the shipped lexical scanner).
  const repo = path.join(consumer, 'repo');
  const fixtureFiles = [
    ['src/main/java/com/acme/Helper.java', 'package com.acme;\npublic class Helper {}\n'],
    [
      'src/main/java/com/acme/Main.java',
      'package com.acme;\nimport com.acme.Helper;\npublic class Main { private Helper helper; }\n',
    ],
    ['src/app/__init__.py', ''],
    ['src/app/models/__init__.py', ''],
    ['src/app/services/__init__.py', ''],
    ['src/app/models/user.py', 'class User:\n    pass\n'],
    [
      'src/app/services/user_service.py',
      'from app.models.user import User\n\n\ndef get_user():\n    return User()\n',
    ],
    ['src/main.rs', 'mod util;\nuse crate::util::helper;\nfn main() { helper(); }\n'],
    ['src/util.rs', 'pub fn helper() {}\n'],
    ['src/dotnet/App/Main.cs', 'using Acme.Util;\nnamespace Acme.App {\n  class Main { void Run() { Helper.DoWork(); } }\n}\n'],
    ['src/dotnet/Util/Helper.cs', 'namespace Acme.Util {\n  class Helper { public static void DoWork() {} }\n}\n'],
    [
      'src/main/kotlin/com/acme/app/Main.kt',
      'package com.acme.app\n\nimport com.acme.util.Helper\n\nclass Main {\n    fun run() {\n        Helper.doWork()\n    }\n}\n',
    ],
    [
      'src/main/kotlin/com/acme/util/Helper.kt',
      'package com.acme.util\n\nobject Helper {\n    fun doWork() {}\n}\n',
    ],
    ['native/widget.h', '#pragma once\nvoid render();\n'],
    ['native/widget.cpp', '#include "widget.h"\nvoid run() { render(); }\n'],
    ['db/schema/001_users.sql', 'CREATE TABLE users (id INT PRIMARY KEY);\n'],
    ['db/order_totals.sql', 'SELECT u.id FROM users u;\n'],
    ['src/web/helper.ts', 'export function helper(): number { return 1; }\n'],
    ['src/web/main.ts', "import { helper } from './helper.ts';\nexport const value = helper();\n"],
    ['src/web/legacy.js', 'export function legacy() { return 2; }\n'],
    ['src/web/app.js', "import { legacy } from './legacy.js';\nexport const total = legacy();\n"],
  ];
  for (const [relative, content] of fixtureFiles) {
    const absolute = path.join(repo, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }

  fs.writeFileSync(
    path.join(consumer, 'verify.mjs'),
    `import assert from 'node:assert/strict';
import path from 'node:path';
import { scanRepository } from 'strabo-map';
import { createStraboServer } from 'strabo-map/server';

const repo = path.join(import.meta.dirname, 'repo');
const report = await scanRepository(repo);
const ids = report.graph.nodes.map((node) => node.id);
const edges = report.graph.edges;

// One supported language per row: the representative file, then the internal dependency
// the installed package must resolve to. Every supported language must appear as a node;
// every language whose scanner records a dependency must also record that resolved edge.
const languages = [
  ['java', 'src/main/java/com/acme/Main.java', 'src/main/java/com/acme/Helper.java'],
  ['python', 'src/app/services/user_service.py', 'src/app/models/user.py'],
  ['rust', 'src/main.rs', 'src/util.rs'],
  ['csharp', 'src/dotnet/App/Main.cs', 'src/dotnet/Util/Helper.cs'],
  ['kotlin', 'src/main/kotlin/com/acme/app/Main.kt', 'src/main/kotlin/com/acme/util/Helper.kt'],
  ['cpp', 'native/widget.cpp', 'native/widget.h'],
  ['sql', 'db/order_totals.sql', 'db/schema/001_users.sql'],
  ['typescript', 'src/web/main.ts', 'src/web/helper.ts'],
  ['javascript', 'src/web/app.js', 'src/web/legacy.js'],
];

for (const [language, file, dependency] of languages) {
  assert.ok(ids.includes(file), language + ' file scanned: ' + file);
  assert.ok(
    edges.some((edge) => edge.source === file && edge.target === dependency),
    language + ' dependency resolved: ' + file + ' -> ' + dependency,
  );
}
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
  check(
    output.includes('consumer verification passed'),
    'installed package scans and resolves one file per supported language, and serves',
  );

  // A fixture repository whose second commit adds a cycle, so `strabo report` has two
  // revisions to diff structurally. The base graph is scanned from a temporary worktree.
  const fixture = path.join(consumer, 'fixture');
  fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
  const gitIn = (args) => execSync(`git ${args}`, { cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  gitIn('init -q');
  gitIn('config user.email test@example.com');
  gitIn('config user.name Tester');
  gitIn('config core.autocrlf false');
  fs.writeFileSync(path.join(fixture, 'src', 'a.ts'), "import './b.ts';\nexport const a = 1;\n");
  fs.writeFileSync(path.join(fixture, 'src', 'b.ts'), 'export const b = 1;\n');
  gitIn('add .');
  gitIn('commit -q -m base');
  const baseHash = gitIn('rev-parse HEAD').trim();
  fs.writeFileSync(path.join(fixture, 'src', 'b.ts'), "import './a.ts';\nexport const b = 1;\n");
  gitIn('add .');
  gitIn('commit -q -m cycle');

  const straboBin = path.join(consumer, 'node_modules', 'strabo-map', 'bin', 'strabo.js');
  const report = execSync(`node "${straboBin}" report . --base ${baseHash} --format md`, { cwd: fixture }).toString();
  check(/Cycles introduced/.test(report), 'report names the introduced cycle');
  check(report.includes('src/a.ts') && report.includes('src/b.ts'), 'report names the cycle members');

  // The whole-repository report, from the installed tarball. Analyses are skipped so the
  // check stays fast; a skipped section is named, never shown as empty.
  const summary = execSync(
    `node "${straboBin}" summary . --no-change --no-smells --no-hotspots --no-ownership`,
    { cwd: fixture },
  ).toString();
  check(/## Pain points \(/.test(summary), 'summary report has a pain points section');
  check(/### critical \(/.test(summary), 'summary ranks the cycle critical');
  check(/Break the cycle/.test(summary), 'summary suggests breaking the cycle');
  check(summary.includes('src/a.ts') && summary.includes('src/b.ts'), 'summary names the cycle members');
  check(/## Suggestions \(/.test(summary), 'summary has a suggestions section');
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
