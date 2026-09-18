import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  expandUse,
  extractRustFacts,
  moduleCoordinates,
  resolveRust,
} from '../../src/scan/languages/rust.ts';
import { scanRepository } from '../../src/scan/scan.ts';

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

test('Rust edges are deterministic across scans', async () => {
  const first = await scanRepository(fixture);
  const second = await scanRepository(fixture);
  const pairs = (report: typeof first) =>
    report.graph.edges.map((edge) => `${edge.source}->${edge.target}`).sort();

  assert.deepEqual(pairs(first), pairs(second));
});
