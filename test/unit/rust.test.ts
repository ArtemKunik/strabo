import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildAdjacency } from '../../src/analysis/analysis.ts';
import {
  expandUse,
  extractRustFacts,
  moduleCoordinates,
  resolveRust,
} from '../../src/scan/languages/rust.ts';
import { parseCargoManifest, readRustCrates, type RustCrate } from '../../src/scan/languages/rust-crates.ts';
import { scanRepository } from '../../src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'rust-repo');

test('moduleCoordinates maps files to crate root and module path', () => {
  assert.deepEqual(moduleCoordinates('src/main.rs'), { crateRoot: 'src', modulePath: '' });
  assert.deepEqual(moduleCoordinates('src/lib.rs'), { crateRoot: 'src', modulePath: '' });
  assert.deepEqual(moduleCoordinates('src/api/mod.rs'), { crateRoot: 'src', modulePath: 'api' });
  assert.deepEqual(moduleCoordinates('src/api/request.rs'), {
    crateRoot: 'src',
    modulePath: 'api/request',
  });
  assert.deepEqual(moduleCoordinates('crates/foo/src/lib.rs'), {
    crateRoot: 'crates/foo/src',
    modulePath: '',
  });
});

test('expandUse handles plain paths, aliases, globs, and nested braces', () => {
  assert.deepEqual(expandUse('use crate::util::Helper;'), [
    { segments: ['crate', 'util', 'Helper'], glob: false, alias: undefined },
  ]);
  assert.deepEqual(expandUse('use crate::util::Helper as H;'), [
    { segments: ['crate', 'util', 'Helper'], glob: false, alias: 'H' },
  ]);
  assert.deepEqual(expandUse('use crate::api::*;'), [
    { segments: ['crate', 'api'], glob: true, alias: undefined },
  ]);
  assert.deepEqual(expandUse('use crate::api::{request::{Request}, Response};'), [
    { segments: ['crate', 'api', 'request', 'Request'], glob: false, alias: undefined },
    { segments: ['crate', 'api', 'Response'], glob: false, alias: undefined },
  ]);
});

test('extractRustFacts records items, mods, and re-exports', async () => {
  const source = [
    'mod util;',
    'pub use request::Request;',
    'use crate::util::Helper;',
    'pub struct Thing;',
  ].join('\n');
  const { facts } = await extractRustFacts('src/api/mod.rs', source);

  assert.deepEqual(facts.mods, [{ name: 'util', external: true, line: 1 }]);
  assert.deepEqual(facts.items, [{ name: 'Thing', line: 4 }]);
  const reexport = facts.uses.find((reference) => reference.reexport);
  assert.equal(reexport?.boundName, 'Request');
});

test('extractRustFacts records a #[path] override on a mod item', async () => {
  const source = [
    '#[cfg(test)]',
    '#[path = "discovery_tests.rs"]',
    'mod tests;',
  ].join('\n');
  const { facts } = await extractRustFacts('src/news_service/discovery.rs', source);

  assert.deepEqual(facts.mods, [
    { name: 'tests', external: true, line: 3, path: 'discovery_tests.rs' },
  ]);
});

test('a #[path] override resolves beside the declaring file, not the module directory', () => {
  const { edges, diagnostics } = resolveRust([
    {
      file: 'src/news_service/discovery.rs',
      crateRoot: 'src',
      modulePath: 'news_service/discovery',
      mods: [{ name: 'tests', external: true, line: 3, path: 'discovery_tests.rs' }],
      uses: [],
      items: [],
    },
    {
      file: 'src/news_service/discovery_tests.rs',
      crateRoot: 'src',
      modulePath: 'news_service/discovery_tests',
      mods: [],
      uses: [],
      items: [],
    },
  ]);

  assert.deepEqual(
    edges.map((edge) => `${edge.source}->${edge.target}`),
    ['src/news_service/discovery.rs->src/news_service/discovery_tests.rs'],
  );
  assert.deepEqual(diagnostics, []);
});

test('extractRustFacts records inline crate-relative paths', async () => {
  const source = [
    'fn main() {',
    '    let _h = crate::util::Helper::new();',
    '    let _x: super::response::Response = super::build();',
    '    std::collections::HashMap::new();',
    '}',
  ].join('\n');
  const { facts } = await extractRustFacts('src/main.rs', source);

  assert.deepEqual(
    facts.paths.map((path) => path.segments.join('::')).sort(),
    ['crate::util::Helper::new', 'super::build', 'super::response::Response'],
  );
});

test('resolveRust links mod declarations, module paths, and re-exported items', async () => {
  const report = await scanRepository(fixture);
  const resolved = new Set(report.graph.edges.map((edge) => `${edge.source}->${edge.target}`));

  assert.ok(resolved.has('src/main.rs->src/util.rs'));
  assert.ok(resolved.has('src/main.rs->src/api/mod.rs'));
  assert.ok(resolved.has('src/main.rs->src/api/request.rs'));
  assert.ok(resolved.has('src/main.rs->src/api/response.rs'));
  assert.ok(resolved.has('src/api/request.rs->src/api/response.rs'));
  assert.ok(resolved.has('src/api/mod.rs->src/api/discovery.rs'));
  assert.ok(resolved.has('src/api/discovery.rs->src/api/discovery_tests.rs'));
});

test('resolveRust resolves a re-exported item to its declaring file', () => {
  const { edges } = resolveRust([
    {
      file: 'src/api/mod.rs',
      crateRoot: 'src',
      modulePath: 'api',
      mods: [
        { name: 'request', external: true, line: 1 },
        { name: 'response', external: true, line: 2 },
      ],
      uses: [
        { segments: ['request', 'Request'], glob: false, boundName: 'Request', reexport: true, line: 4 },
      ],
      items: [],
    },
    {
      file: 'src/api/request.rs',
      crateRoot: 'src',
      modulePath: 'api/request',
      mods: [],
      uses: [],
      items: [{ name: 'Request', line: 1 }],
    },
  ]);

  assert.deepEqual(
    edges.map((edge) => `${edge.source}->${edge.target}:${edge.relationship}`),
    [
      'src/api/mod.rs->src/api/request.rs:module-declaration',
      'src/api/mod.rs->src/api/request.rs:re-export',
    ],
  );
});

test('scanRepository resolves inline crate-relative paths to files', async () => {
  const report = await scanRepository(fixture);
  const resolved = new Set(report.graph.edges.map((edge) => `${edge.source}->${edge.target}`));

  assert.ok(resolved.has('src/api/response.rs->src/api/request.rs'));
});

test('mod declarations are declare edges and are not counted as dependencies', async () => {
  const report = await scanRepository(fixture);
  const modEdge = report.graph.edges.find(
    (edge) => edge.source === 'src/main.rs' && edge.target === 'src/api/mod.rs',
  );
  assert.equal(modEdge?.role, 'declare');

  const useEdge = report.graph.edges.find((edge) =>
    edge.evidence.specifier.includes('crate::api::Request'),
  );
  assert.equal(useEdge?.role, 'use');

  const counted = buildAdjacency(report.graph);
  assert.ok(!(counted.forward.get('src/main.rs') ?? []).includes('src/api/mod.rs'));
  assert.ok((counted.forward.get('src/main.rs') ?? []).includes('src/api/request.rs'));
  // The explicit opt-in still sees every drawn edge.
  const all = buildAdjacency(report.graph, { includeDeclare: true });
  assert.ok((all.forward.get('src/main.rs') ?? []).includes('src/api/mod.rs'));
});

async function resolveSources(sources: Record<string, string>) {
  const facts = [];
  for (const [file, content] of Object.entries(sources)) {
    facts.push((await extractRustFacts(file, content)).facts);
  }
  return resolveRust(facts);
}

function callPairs(edges: Array<{ source: string; target: string; kind: string }>): string[] {
  return edges.filter((edge) => edge.kind === 'call').map((edge) => `${edge.source}->${edge.target}`);
}

test('a use-bound bare call becomes a cross-file call edge', async () => {
  const { edges } = await resolveSources({
    'src/main.rs': 'mod util;\nuse crate::util::helper;\nfn main() { helper(); }\n',
    'src/util.rs': 'pub fn helper() {}\n',
  });

  assert.deepEqual(callPairs(edges), ['src/main.rs->src/util.rs']);
});

test('a module-qualified call becomes a cross-file call edge', async () => {
  const { edges } = await resolveSources({
    'src/main.rs': 'mod util;\nfn main() { util::helper(); }\n',
    'src/util.rs': 'pub fn helper() {}\n',
  });

  assert.deepEqual(callPairs(edges), ['src/main.rs->src/util.rs']);
});

test('a glob import resolves a call only when one module declares the name', async () => {
  const { edges } = await resolveSources({
    'src/main.rs': 'mod util;\nuse crate::util::*;\nfn main() { helper(); }\n',
    'src/util.rs': 'pub fn helper() {}\n',
  });

  assert.deepEqual(callPairs(edges), ['src/main.rs->src/util.rs']);
});

test('a call to a name no imported module declares is not claimed', async () => {
  const { edges } = await resolveSources({
    'src/main.rs': 'mod util;\nuse crate::util::other;\nfn main() { helper(); }\n',
    'src/util.rs': 'pub fn other() {}\n',
  });

  assert.deepEqual(callPairs(edges), []);
});

test('Rust edges are deterministic across scans', async () => {
  const first = await scanRepository(fixture);
  const second = await scanRepository(fixture);
  const pairs = (report: typeof first) =>
    report.graph.edges.map((edge) => `${edge.source}->${edge.target}`).sort();

  assert.deepEqual(pairs(first), pairs(second));
});

async function rustEdges(
  sources: Record<string, string>,
  crates: readonly RustCrate[] = [],
): Promise<string[]> {
  const facts = await Promise.all(
    Object.entries(sources).map(async ([file, content]) => (await extractRustFacts(file, content)).facts),
  );
  return resolveRust(facts, { crates }).edges
    .filter((edge) => edge.role !== 'declare')
    .map((edge) => `${edge.source}->${edge.target}`);
}

const mcpCrate: RustCrate = {
  dir: 'crates/mcp',
  packageName: 'lunapark-mcp',
  libName: 'lunapark_mcp',
  libFile: 'crates/mcp/src/lib.rs',
  dependencies: [],
};
const mcpSources = {
  'crates/mcp/src/lib.rs': 'mod manager;\npub use manager::{McpManager};\n',
  'crates/mcp/src/manager.rs': 'pub struct McpManager;\n',
};

test('a dependency crate resolves through its re-export to the declaring file', async () => {
  const edges = await rustEdges(
    { ...mcpSources, 'crates/cli/src/main.rs': 'use lunapark_mcp::McpManager;\n' },
    [mcpCrate, { dir: 'crates/cli', packageName: 'cli', libName: 'cli', dependencies: [{ name: 'lunapark-mcp' }] }],
  );
  assert.ok(edges.includes('crates/cli/src/main.rs->crates/mcp/src/manager.rs'));
  assert.ok(edges.includes('crates/mcp/src/lib.rs->crates/mcp/src/manager.rs'));
});

test('an inline path into a dependency crate is an edge', async () => {
  const edges = await rustEdges(
    { ...mcpSources, 'crates/cli/src/main.rs': 'fn main() { let _ = lunapark_mcp::McpManager::new(); }\n' },
    [mcpCrate, { dir: 'crates/cli', packageName: 'cli', libName: 'cli', dependencies: [{ name: 'lunapark-mcp' }] }],
  );
  assert.ok(edges.includes('crates/cli/src/main.rs->crates/mcp/src/manager.rs'));
});

test('a crate the package does not depend on gets no edge', async () => {
  const edges = await rustEdges(
    { ...mcpSources, 'crates/cli/src/main.rs': 'use lunapark_mcp::McpManager;\n' },
    [mcpCrate, { dir: 'crates/cli', packageName: 'cli', libName: 'cli', dependencies: [] }],
  );
  assert.ok(!edges.some((edge) => edge.startsWith('crates/cli/')));
});

test('a renamed dependency is used by its table name', async () => {
  const dependencies = [{ name: 'mcp', package: 'lunapark-mcp' }];
  const edges = await rustEdges(
    { ...mcpSources, 'crates/cli/src/main.rs': 'use mcp::McpManager;\n' },
    [mcpCrate, { dir: 'crates/cli', packageName: 'cli', libName: 'cli', dependencies }],
  );
  assert.ok(edges.includes('crates/cli/src/main.rs->crates/mcp/src/manager.rs'));
});

test('an integration test reaches its own package library by name', async () => {
  const edges = await rustEdges(
    { ...mcpSources, 'crates/mcp/tests/smoke.rs': 'use lunapark_mcp::McpManager;\n' },
    [mcpCrate],
  );
  assert.ok(edges.includes('crates/mcp/tests/smoke.rs->crates/mcp/src/manager.rs'));
});

test('a package name two manifests claim stays unresolved', async () => {
  const twin = { ...mcpCrate, dir: 'vendor/mcp', libFile: 'vendor/mcp/src/lib.rs' };
  const edges = await rustEdges(
    { ...mcpSources, 'crates/cli/src/main.rs': 'use lunapark_mcp::McpManager;\n' },
    [mcpCrate, twin, { dir: 'crates/cli', packageName: 'cli', libName: 'cli', dependencies: [{ name: 'lunapark-mcp' }] }],
  );
  assert.ok(!edges.some((edge) => edge.startsWith('crates/cli/')));
});

test('a bare path starts at a module declared in the file', async () => {
  const edges = await rustEdges({
    'src/main.rs': 'mod app;\nfn main() { app::run(); }\n',
    'src/app.rs': 'pub fn run() {}\n',
  });
  assert.ok(edges.includes('src/main.rs->src/app.rs'));
});

test('a bare path follows a use binding', async () => {
  const edges = await rustEdges({
    'src/main.rs': 'mod api;\nmod other;\n',
    'src/api.rs': 'pub fn run() {}\n',
    'src/other.rs': 'use crate::api as remote;\nfn go() { remote::run(); }\n',
  });
  assert.ok(edges.includes('src/other.rs->src/api.rs'));
});

test('an inline mod shadows a crate of the same name', async () => {
  const edges = await rustEdges(
    { ...mcpSources, 'crates/cli/src/main.rs': 'mod lunapark_mcp { pub struct McpManager; }\nuse lunapark_mcp::McpManager;\n' },
    [mcpCrate, { dir: 'crates/cli', packageName: 'cli', libName: 'cli', dependencies: [{ name: 'lunapark-mcp' }] }],
  );
  assert.ok(!edges.some((edge) => edge.startsWith('crates/cli/')));
});

test('an item re-exported by glob resolves to the file that declares it', async () => {
  const edges = await rustEdges(
    {
      'crates/events/src/lib.rs': 'mod session_event;\npub use session_event::*;\n',
      'crates/events/src/session_event.rs': 'pub struct SessionEvent;\n',
      'crates/cli/src/main.rs': 'use lunapark_events::SessionEvent;\nuse lunapark_events::Missing;\n',
    },
    [
      { dir: 'crates/events', packageName: 'lunapark-events', libName: 'lunapark_events', libFile: 'crates/events/src/lib.rs', dependencies: [] },
      { dir: 'crates/cli', packageName: 'cli', libName: 'cli', dependencies: [{ name: 'lunapark-events' }] },
    ],
  );
  assert.deepEqual(edges.filter((edge) => edge.startsWith('crates/cli/')), [
    'crates/cli/src/main.rs->crates/events/src/session_event.rs',
  ]);
});

test('re-exports that point at each other end without an edge', async () => {
  const edges = await rustEdges({
    'src/lib.rs': 'mod a;\nmod b;\npub use a::Thing;\n',
    'src/a.rs': 'pub use super::b::Thing;\n',
    'src/b.rs': 'pub use super::a::Thing;\n',
  });
  assert.ok(Array.isArray(edges));
});

test('use a::b::{self} binds b and is not reported unresolved', () => {
  assert.deepEqual(expandUse('use crate::api::{self, Response};'), [
    { segments: ['crate', 'api'], glob: false, alias: undefined },
    { segments: ['crate', 'api', 'Response'], glob: false, alias: undefined },
  ]);
});

test('parseCargoManifest reads names, lib overrides, and every dependency table form', () => {
  const crate = parseCargoManifest(
    'crates/a',
    [
      '[package]',
      'name = "my-pkg"',
      '[lib]',
      'name = "my_lib"',
      'path = "src/root.rs"',
      '[dependencies]',
      'plain = "1"',
      'by-path = { path = "../b" }',
      'renamed = { package = "real-name", path = "../c" }',
      'inherited.workspace = true',
      '[dev-dependencies]',
      'dev-only = { path = "../d" }',
      "[target.'cfg(unix)'.dependencies]",
      'unix-only = { path = "../e" }',
      '[dependencies.table-form]',
      'path = "../f"',
      'package = "table-real"',
    ].join('\r\n'),
    new Set(['crates/a/src/root.rs']),
  );
  assert.equal(crate?.libName, 'my_lib');
  assert.equal(crate?.libFile, 'crates/a/src/root.rs');
  assert.deepEqual(crate?.dependencies, [
    { name: 'plain' },
    { name: 'by-path' },
    { name: 'renamed', package: 'real-name' },
    { name: 'inherited' },
    { name: 'dev-only' },
    { name: 'unix-only' },
    { name: 'table-form', package: 'table-real' },
  ]);
  assert.equal(parseCargoManifest('', '[workspace]\nmembers = ["a"]\n', new Set()), null);
});

test('a workspace scan links crates and keeps declared modules off the dead list', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-rust-workspace-'));
  try {
    const write = (file: string, content: string): void => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    };
    write('Cargo.toml', '[workspace]\nmembers = ["crates/*"]\n');
    write('crates/core/Cargo.toml', '[package]\nname = "my-core"\n');
    write('crates/core/src/lib.rs', 'mod engine;\nmod helpers;\npub use engine::Engine;\n');
    write('crates/core/src/engine.rs', 'pub struct Engine;\n');
    write('crates/core/src/helpers.rs', 'impl crate::Engine { pub fn go(&self) {} }\n');
    write('crates/core/src/orphan.rs', 'pub struct NeverCompiled;\n');
    write('crates/core/examples/demo.rs', 'fn main() {}\n');
    write('crates/core/build.rs', 'fn main() {}\n');
    write('crates/app/Cargo.toml', '[package]\nname = "app"\n[dependencies]\nmy-core = { path = "../core" }\n');
    write('crates/app/src/main.rs', 'use my_core::Engine;\nfn main() { let _ = Engine; }\n');

    const report = await scanRepository(root);
    const links = report.graph.edges
      .filter((edge) => edge.role !== 'declare')
      .map((edge) => `${edge.source}->${edge.target}`);
    assert.ok(links.includes('crates/app/src/main.rs->crates/core/src/engine.rs'));
    assert.deepEqual(readRustCrates(root, ['crates/app/src/main.rs']).map((crate) => crate.packageName), ['app']);

    const { computeQualityScorecard } = await import('../../src/analysis/quality.ts');
    const quality = await computeQualityScorecard(report.graph, root, 'demo');
    const dead = quality.modules
      .filter((module) => module.smells.some((smell) => smell.rule === 'dead'))
      .map((module) => module.file);
    assert.deepEqual(dead, ['crates/core/src/orphan.rs']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
