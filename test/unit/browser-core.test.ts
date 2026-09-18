import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_DIAMETER,
  MIN_DIAMETER,
  breadcrumb,
  buildElements,
  buildGraphQuery,
  diameter,
  drillTarget,
  fileWebUrl,
  filterNodes,
  findPath,
  graphSummary,
  mapCounts,
  neighbourhood,
  normalizeGitUrl,
  overlayFor,
  paletteColor,
  passportFor,
  summarizeDiagnostics,
  topLevelDirectory,
} from '../../public/strabo-core.js';

const model = {
  repository: { name: 'demo', root: '/demo', gitUrl: 'git@github.com:owner/demo.git' },
  cache: { status: 'memory' },
  hubs: ['src/util.ts'],
  positions: [
    { id: 'src/index.ts', x: 10, y: 20 },
    { id: 'src/util.ts', x: 30, y: 40 },
  ],
  nodes: [
    { id: 'src/index.ts', kind: 'module', transitiveDependents: 1 },
    { id: 'src/util.ts', kind: 'module', transitiveDependents: 4 },
    { id: 'src/feature.test.ts', kind: 'test', transitiveDependents: 0 },
  ],
  edges: [
    {
      source: 'src/index.ts',
      target: 'src/util.ts',
      semanticSource: 'src/index.ts',
      semanticTarget: 'src/util.ts',
      evidence: { line: 1, specifier: './util.ts' },
    },
    {
      source: 'src/feature.test.ts',
      target: 'src/index.ts',
      semanticSource: 'src/feature.test.ts',
      semanticTarget: 'src/index.ts',
      evidence: { line: 3, specifier: './index.ts' },
    },
  ],
  diagnostics: [
    { file: 'src/dangling.ts', line: 1, message: 'unresolved', kind: 'unresolved', severity: 'warning' },
  ],
  excluded: [{ path: 'node_modules/', reason: 'generated' }],
};

test('buildGraphQuery omits block params in file mode', () => {
  const query = buildGraphQuery({ repository: '/demo', mode: 'file', depth: 1, prefix: '' });
  assert.equal(query, '?repository=%2Fdemo');
});

test('buildGraphQuery adds refresh=1 as a cache bypass', () => {
  const query = buildGraphQuery({ repository: '/demo', mode: 'file' }, { refresh: true });
  assert.ok(query.includes('refresh=1'));
});

test('buildGraphQuery sends blockDepth and a drilled prefix', () => {
  const query = buildGraphQuery({ repository: '/demo', mode: 'block', depth: 1, prefix: 'src/api' });
  assert.ok(query.includes('blockDepth=1'));
  assert.ok(query.includes('blockPrefix=src%2Fapi'));
});

test('paletteColor honours a server-assigned index and is stable otherwise', () => {
  assert.equal(paletteColor(0, 'anything'), paletteColor(0, 'other'));
  assert.equal(paletteColor(undefined, 'src/util.ts'), paletteColor(undefined, 'src/util.ts'));
});

test('diameter uses a square-root scale bounded to the documented range', () => {
  assert.equal(diameter(0), MIN_DIAMETER);
  assert.equal(diameter(1_000_000), MAX_DIAMETER);
  assert.ok(diameter(16) > MIN_DIAMETER);
});

test('buildElements joins positions and marks hub nodes', () => {
  const { nodes, edges } = buildElements(model);
  const util = nodes.find((node) => node.data.id === 'src/util.ts');
  const test = nodes.find((node) => node.data.id === 'src/feature.test.ts');

  assert.deepEqual(util.position, { x: 30, y: 40 });
  assert.equal(util.data.hub, true);
  assert.equal(util.classes, 'kind-module');
  assert.equal(test.classes, 'kind-test');
  assert.equal(edges[0].data.evidenceLine, 1);
});

test('buildElements falls back to the origin when a position is missing', () => {
  const sparse = { nodes: [{ id: 'orphan.ts', kind: 'module' }], edges: [], positions: [] };
  const { nodes } = buildElements(sparse);
  assert.deepEqual(nodes[0].position, { x: 0, y: 0 });
});

test('neighbourhood and findPath report connections or no path explicitly', () => {
  assert.deepEqual(neighbourhood(model, 'src/util.ts').sort(), [
    'src/index.ts',
    'src/util.ts',
  ]);
  assert.deepEqual(findPath(model, 'src/feature.test.ts', 'src/util.ts'), [
    'src/feature.test.ts',
    'src/index.ts',
    'src/util.ts',
  ]);
  assert.equal(findPath(model, 'src/util.ts', 'src/feature.test.ts'), null);
});

test('drillTarget drills one segment in block mode and opens files in file mode', () => {
  const block = drillTarget({ mode: 'block', depth: 1, prefix: '' }, 'src');
  assert.equal(block.prefix, 'src');

  const file = drillTarget({ mode: 'file' }, 'src/index.ts');
  assert.equal(file.file, 'src/index.ts');
});

test('breadcrumb starts at the repository and grows with the prefix', () => {
  assert.deepEqual(breadcrumb({ mode: 'file', prefix: 'src/api' }), []);
  assert.deepEqual(breadcrumb({ mode: 'block', prefix: 'src/api' }), [
    { label: 'repository', prefix: '' },
    { label: 'src', prefix: 'src' },
    { label: 'api', prefix: 'src/api' },
  ]);
});

test('normalizeGitUrl handles scp, ssh, and https remotes', () => {
  assert.equal(normalizeGitUrl('git@github.com:owner/demo.git'), 'https://github.com/owner/demo');
  assert.equal(normalizeGitUrl('ssh://git@gitlab.com/owner/demo.git'), 'https://gitlab.com/owner/demo');
  assert.equal(normalizeGitUrl('https://github.com/owner/demo.git'), 'https://github.com/owner/demo');
  assert.equal(normalizeGitUrl('not-a-url'), null);
  assert.equal(normalizeGitUrl(undefined), null);
});

test('fileWebUrl builds a blob link and degrades to null without a remote', () => {
  assert.equal(
    fileWebUrl(model.repository, 'src/index.ts'),
    'https://github.com/owner/demo/blob/HEAD/src/index.ts',
  );
  assert.equal(fileWebUrl({ gitUrl: null }, 'src/index.ts'), null);
});

test('summarizeDiagnostics groups diagnostics and exclusions', () => {
  const summary = summarizeDiagnostics(model);
  assert.equal(summary.diagnostics, 1);
  assert.equal(summary.excluded, 1);
  assert.equal(summary.byKind.unresolved, 1);
  assert.equal(summary.excludedByReason.generated, 1);
});

test('filterNodes matches case-insensitively and returns everything when empty', () => {
  assert.deepEqual(filterNodes(model, 'UTIL'), ['src/util.ts']);
  assert.deepEqual(filterNodes(model, '  '), ['src/index.ts', 'src/util.ts', 'src/feature.test.ts']);
});

test('graphSummary reports cache status and staleness', () => {
  assert.equal(graphSummary(model), '3 nodes · 2 edges · cache: memory');
  assert.equal(
    graphSummary({ nodes: [], edges: [], cache: { status: 'disk', stale: true } }),
    '0 nodes · 0 edges · cache: disk (stale)',
  );
});

test('overlayFor maps change impact onto changed and affected nodes', () => {
  const overlay = overlayFor('impact', {
    changed: [{ path: 'c.ts' }],
    affected: [
      { id: 'c.ts', distance: 0 },
      { id: 'b.ts', distance: 1 },
      { id: 'a.ts', distance: 2 },
    ],
  });

  assert.equal(overlay.classes.get('c.ts'), 'ov-changed');
  assert.equal(overlay.classes.get('b.ts'), 'ov-affected');
  assert.equal(overlay.classes.get('a.ts'), 'ov-affected');
  assert.equal(overlay.summary, '1 changed · 2 affected');
});

test('overlayFor maps cycles and test reach onto their node classes', () => {
  const cycles = overlayFor('cycles', [{ id: 'a.ts', members: ['a.ts', 'b.ts'] }]);
  assert.equal(cycles.classes.get('a.ts'), 'ov-cycle');
  assert.equal(cycles.classes.get('b.ts'), 'ov-cycle');
  assert.equal(cycles.summary, '1 cycle(s)');

  const reach = overlayFor('test-reach', { unreachedWithDependents: ['d.ts'] });
  assert.equal(reach.classes.get('d.ts'), 'ov-unreached');
  assert.equal(reach.summary, '1 unreached with dependents');
});

test('overlayFor returns an empty overlay for an unknown kind', () => {
  const overlay = overlayFor('nonsense', {});
  assert.equal(overlay.classes.size, 0);
  assert.equal(overlay.summary, '');
});

test('overlayFor reports architecture health as a repository-level summary', () => {
  const overlay = overlayFor('architecture', {
    score: 88,
    axes: [
      { key: 'cohesion', label: 'Cohesion', value: 50, detail: '4 of 8 connections' },
      { key: 'coverage', label: 'Coverage', value: null, detail: 'no test files identified' },
    ],
  });

  assert.equal(overlay.classes.size, 0);
  assert.equal(overlay.summary, 'score 88/100');
  assert.deepEqual(overlay.items, [
    'Cohesion: 50/100 (4 of 8 connections)',
    'Coverage: unavailable (no test files identified)',
  ]);
});

test('nodes in the same top-level directory share a colour', () => {
  const { nodes } = buildElements({
    nodes: [
      { id: 'src/a.ts', kind: 'module' },
      { id: 'src/b.ts', kind: 'module' },
      { id: 'lib/c.ts', kind: 'module' },
    ],
    edges: [],
    positions: [],
  });

  assert.equal(nodes[0].data.color, nodes[1].data.color);
});

test('passportFor reports metrics, imports, and used-by from evidence', () => {
  const passport = passportFor(model, 'src/util.ts');

  assert.deepEqual(
    passport.metrics.map((metric) => [metric.label, metric.value]),
    [
      ['Direct importers', 1],
      ['Blast radius', 4],
      ['Direct imports', 0],
      ['Depends on (all)', 0],
    ],
  );
  assert.deepEqual(passport.usedBy.map((entry) => entry.id).sort(), ['src/index.ts']);
  assert.equal(passport.functions, null);
});

test('mapCounts groups by directory and kind for the strip', () => {
  const counts = mapCounts(model);

  assert.equal(counts.tests, 1);
  assert.equal(counts.modules, 2);
  assert.deepEqual(counts.entries, [{ label: 'src', count: 3, filter: 'src/' }]);
});

test('topLevelDirectory falls back to the root marker', () => {
  assert.equal(topLevelDirectory('src/util.ts'), 'src');
  assert.equal(topLevelDirectory('main.ts'), '.');
});
