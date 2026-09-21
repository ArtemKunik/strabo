import assert from 'node:assert/strict';
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
    edges.map((edge) => `${edge.source}->${edge.target}`),
    ['src/api/mod.rs->src/api/request.rs'],
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
