import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { scanRepository } from '../../src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'alias-repo');

function edgesTo(report: { graph: { edges: Array<{ source: string; target: string; evidence: { specifier?: string; resolution?: string } }> } }) {
  return report.graph.edges.map((edge) => ({
    source: edge.source,
    pair: `${edge.source}->${edge.target}`,
    specifier: edge.evidence.specifier,
    resolution: edge.evidence.resolution,
  }));
}

function edgeFor(edges: ReturnType<typeof edgesTo>, source: string, specifier: string) {
  return edges.find((edge) => edge.source === source && edge.specifier === specifier);
}

test('tsconfig paths aliases resolve to internal files', async () => {
  const report = await scanRepository(fixture);
  const edges = edgesTo(report);

  const at = edgeFor(edges, 'src/main.ts', '@/components/Button');
  assert.ok(at, 'expected @/ alias edge');
  assert.equal(at.pair, 'src/main.ts->src/components/Button.tsx');
  assert.equal(at.resolution, 'alias');

  const tilde = edgeFor(edges, 'src/main.ts', '~utils/format');
  assert.ok(tilde, 'expected ~utils alias edge');
  assert.equal(tilde.pair, 'src/main.ts->src/shared/utils/format.ts');
  assert.equal(tilde.resolution, 'alias');

  const exact = edgeFor(edges, 'packages/app/tool.ts', '@app');
  assert.ok(exact, 'expected exact @app alias edge');
  assert.equal(exact.pair, 'packages/app/tool.ts->src/app/index.ts');
  assert.equal(exact.resolution, 'alias');
});

test('root-relative and baseUrl specifiers resolve', async () => {
  const report = await scanRepository(fixture);
  const edges = edgesTo(report);

  const rooted = edgeFor(edges, 'src/main.ts', '/src/lib/store');
  assert.ok(rooted, 'expected root-relative edge');
  assert.equal(rooted.pair, 'src/main.ts->src/lib/store.ts');
  assert.equal(rooted.resolution, 'root');

  const baseUrl = edgeFor(edges, 'src/main.ts', 'src/lib/store');
  assert.ok(baseUrl, 'expected baseUrl edge for a bare specifier');
  assert.equal(baseUrl.pair, 'src/main.ts->src/lib/store.ts');
  assert.equal(baseUrl.resolution, 'alias');
});

test('package subpath imports resolve through the nearest package.json', async () => {
  const report = await scanRepository(fixture);
  const edges = edgesTo(report);

  const subpath = edgeFor(edges, 'src/main.ts', '#lib/store');
  assert.ok(subpath, 'expected # subpath edge');
  assert.equal(subpath.pair, 'src/main.ts->src/lib/store.ts');
  assert.equal(subpath.resolution, 'subpath-import');
});

test('aliases work through tsconfig extends in nested packages', async () => {
  const report = await scanRepository(fixture);
  const edges = edgesTo(report);

  const nested = edges.find(
    (edge) => edge.pair === 'packages/app/tool.ts->src/lib/store.ts',
  );
  assert.ok(nested, 'expected nested package to inherit root paths via extends');
  assert.equal(nested.resolution, 'alias');
});

test('vite object-form aliases resolve, including root-absolute values', async () => {
  const report = await scanRepository(fixture);
  const edges = edgesTo(report);

  const prefix = edgeFor(edges, 'src/main.ts', '@ui/Button');
  assert.ok(prefix, 'expected vite prefix alias edge');
  assert.equal(prefix.pair, 'src/main.ts->src/components/Button.tsx');
  assert.equal(prefix.resolution, 'alias');

  const exact = edgeFor(edges, 'src/main.ts', '~store');
  assert.ok(exact, 'expected vite exact alias edge');
  assert.equal(exact.pair, 'src/main.ts->src/lib/store.ts');
  assert.equal(exact.resolution, 'alias');
});

test('webpack array-form aliases resolve computed path.resolve replacements', async () => {
  const report = await scanRepository(fixture);
  const edges = edgesTo(report);

  const data = edgeFor(edges, 'src/main.ts', '@data/store');
  assert.ok(data, 'expected webpack alias edge');
  assert.equal(data.pair, 'src/main.ts->src/lib/store.ts');
  assert.equal(data.resolution, 'alias');
});

test('claimed-but-missing aliases are diagnostics, bare packages stay silent', async () => {
  const report = await scanRepository(fixture);

  const aliasMiss = report.graph.diagnostics.find((item) => item.specifier === '@/does-not-exist');
  assert.ok(aliasMiss, 'expected a diagnostic for the unresolved alias');
  assert.equal(aliasMiss.kind, 'unresolved');

  const bare = report.graph.diagnostics.find((item) => item.specifier === 'react');
  assert.equal(bare, undefined);

  const bareEdge = report.graph.edges.some(
    (edge) => edge.source === 'src/main.ts' && edge.target.includes('react'),
  );
  assert.equal(bareEdge, false);
});
