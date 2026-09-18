import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_DELEGATE_PROMPT,
  MAX_DIAMETER,
  MIN_DIAMETER,
  breadcrumb,
  buildAgentPrompt,
  buildElements,
  buildGraphQuery,
  constellationLayout,
  constellationPoints,
  diameter,
  drillTarget,
  edgeEvidenceFor,
  explainClass,
  fieldCard,
  fileWebUrl,
  filterNodes,
  findPath,
  folderLocation,
  graphSummary,
  isWiredField,
  isWiredMethod,
  mapCounts,
  memberClusters,
  memberMapSteps,
  methodCard,
  neighbourhood,
  normalizeGitUrl,
  orderMembers,
  overlayFor,
  paletteColor,
  passportFor,
  polygonPoints,
  radarFrame,
  radarPoints,
  resolutionLabel,
  reviewFileLabel,
  reviewGroups,
  reviewOverlay,
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

test('edgeEvidenceFor explains an edge from recorded evidence', () => {
  const evidence = edgeEvidenceFor(model, 'e0');
  assert.equal(evidence?.source, 'src/index.ts');
  assert.equal(evidence?.target, 'src/util.ts');
  assert.equal(evidence?.line, 1);
  assert.equal(evidence?.specifier, './util.ts');
  assert.equal(evidence?.resolutionLabel, 'not recorded');
  assert.equal(edgeEvidenceFor(model, 'e1')?.resolutionLabel, 'not recorded');
});

test('edgeEvidenceFor maps resolution codes to readable labels and hides unknowns', () => {  const withResolution = {
    edges: [
      { source: 'a.ts', target: 'b.ts', kind: 'import', evidence: { line: 4, specifier: './b', resolution: 'index-of-package' } },
    ],
  };
  const evidence = edgeEvidenceFor(withResolution, 'e0');
  assert.equal(evidence?.resolutionLabel, 'package member');
  assert.equal(evidence?.line, 4);

  assert.equal(edgeEvidenceFor(model, 'e99'), null);
  assert.equal(edgeEvidenceFor({ edges: [] }, 'e0'), null);
  assert.equal(resolutionLabel('module-tree'), 'module tree');
  assert.equal(resolutionLabel(undefined), 'not recorded');
});

test('folderLocation explains the scan ceiling when Up is disabled', () => {
  const atCeiling = folderLocation({ path: 'D:\\repos', parent: null, ceiling: 'D:\\repos' });
  assert.equal(atCeiling.atCeiling, true);
  assert.equal(atCeiling.upLabel, 'Top of scan ceiling');
  assert.match(atCeiling.note, /Scan ceiling reached/);
  assert.match(atCeiling.note, /STRABO_SCAN_CEILING/);

  const inside = folderLocation({
    path: 'D:\\repos\\demo',
    parent: 'D:\\repos',
    ceiling: 'D:\\repos',
  });
  assert.equal(inside.atCeiling, false);
  assert.equal(inside.upLabel, 'Up to repos');
  assert.equal(inside.note, 'Scan ceiling: D:\\repos');
});

test('reviewOverlay marks changed and affected nodes from a review result', () => {
  const data = {
    available: true,
    kind: 'commit',
    files: [
      { path: 'b.ts', status: 'modified', group: 'commit', insertions: 2, deletions: 1, inGraph: true },
      { path: 'notes.md', status: 'added', group: 'commit', insertions: 4, deletions: 0, inGraph: false },
    ],
    totals: { files: 2, insertions: 6, deletions: 1, uncounted: 0 },
    impact: {
      affected: [
        { id: 'b.ts', distance: 0 },
        { id: 'a.ts', distance: 1 },
      ],
      outsideGraph: ['notes.md'],
    },
  };

  const overlay = reviewOverlay(data);
  assert.equal(overlay.classes.get('b.ts'), 'ov-changed');
  assert.equal(overlay.classes.get('a.ts'), 'ov-affected');
  // A file outside the graph is never annotated as if it had impact.
  assert.equal(overlay.classes.has('notes.md'), false);
  assert.match(overlay.summary, /2 file\(s\) · \+6 −1 · 1 affected/);
});

test('reviewOverlay stays empty when the review is unavailable', () => {
  const overlay = reviewOverlay({ available: false, reason: 'no-git' });
  assert.equal(overlay.classes.size, 0);
  assert.equal(overlay.summary, '');
});

test('reviewFileLabel reports renames and unavailable line counts honestly', () => {
  assert.equal(
    reviewFileLabel({ path: 'new.ts', previousPath: 'old.ts', status: 'renamed', insertions: 3, deletions: 2 }),
    'renamed · old.ts → new.ts · +3 −2',
  );
  assert.equal(
    reviewFileLabel({ path: 'logo.png', status: 'modified', insertions: null, deletions: null }),
    'modified · logo.png · line counts unavailable',
  );
});

test('reviewGroups orders commit, staged, unstaged, then untracked and drops empty groups', () => {
  const groups = reviewGroups([
    { path: 'u.ts', group: 'untracked' },
    { path: 's.ts', group: 'staged' },
    { path: 'c.ts', group: 'commit' },
  ]);
  assert.deepEqual(groups.map(([name]) => name), ['commit', 'staged', 'untracked']);
});

const memberMap = {
  available: true,
  types: [
    {
      name: 'Counter',
      visibility: 'public',
      line: 1,
      fields: [
        { name: 'value', visibility: 'private', type: 'Int', mutable: true, line: 2, reads: 1, writes: 2 },
        { name: 'label', visibility: 'private', type: 'String', mutable: false, line: 3, reads: 1, writes: 0 },
        { name: 'lastError', visibility: 'private', type: 'String', mutable: true, line: 4, reads: 0, writes: 1 },
      ],
      methods: [
        { name: 'add', visibility: 'public', parameters: 1, line: 5, reads: ['value'], writes: ['value'] },
        { name: 'reset', visibility: 'public', parameters: 0, line: 6, reads: ['label'], writes: ['value'] },
        { name: 'fail', visibility: 'public', parameters: 0, line: 7, reads: [], writes: ['lastError'] },
      ],
    },
  ],
  dataFlow: {
    available: true,
    sources: ['label'],
    resources: ['value'],
    transforms: ['Counter.add', 'Counter.reset'],
    sinks: ['lastError'],
    caveat: 'Derived from field references recorded in this file.',
  },
};

test('memberMapSteps produces the five flow steps with derived captions', () => {
  const steps = memberMapSteps(memberMap, { consumers: 3 });
  assert.deepEqual(
    steps.map((step) => step.key),
    ['fingerprint', 'members', 'wiring', 'data-flow', 'consumption'],
  );
  assert.equal(steps[0].caption, 'Counter contains 3 field(s) and 3 behavior(s).');
  assert.match(steps[2].caption, /2 transform\(s\)/);
  assert.equal(steps[4].caption, '3 repository consumer(s) import this file.');
});

test('memberMapSteps reports missing wiring and consumers instead of inventing them', () => {
  const steps = memberMapSteps(
    { available: true, types: memberMap.types, dataFlow: { available: false, reason: 'no-field-access' } },
    {},
  );
  assert.equal(steps[2].caption, 'No field-to-behavior wiring was recorded in the scan.');
  assert.equal(steps[4].caption, 'Repository consumers were not recorded for this file.');
});

test('fieldCard and methodCard describe recorded signatures and wiring', () => {
  const value = fieldCard(memberMap.types[0].fields[0]);
  assert.equal(value.eyebrow, 'FIELD · PRIVATE · MUTABLE');
  assert.equal(value.signature, 'value: Int');
  assert.equal(value.tag, '1 read · 2 write');
  assert.equal(value.metrics, 'public data · local reads 1 · local writes 2');

  const label = fieldCard(memberMap.types[0].fields[1]);
  assert.equal(label.eyebrow, 'FIELD · PRIVATE · READONLY');
  assert.equal(label.tag, '1 read · 0 write');

  const unconnected = fieldCard({ name: 'x', visibility: 'public', mutable: false, reads: 0, writes: 0 });
  assert.equal(unconnected.tag, 'unconnected');

  const add = methodCard(memberMap.types[0].methods[0]);
  assert.equal(add.signature, 'add(1)');
  assert.equal(add.tag, 'wired');
  assert.equal(add.metrics, 'reads value · writes value');
});

test('memberClusters groups members connected by recorded wiring', () => {
  const { clusters, clusterOf } = memberClusters(memberMap);
  assert.equal(clusters.length, 2);
  assert.equal(clusterOf.get('value'), clusterOf.get('add'));
  assert.equal(clusterOf.get('value'), clusterOf.get('reset'));
  assert.notEqual(clusterOf.get('value'), clusterOf.get('fail'));
  assert.equal(clusterOf.get('fail'), clusterOf.get('lastError'));
});

test('explainClass summarises members and wiring in one sentence', () => {
  assert.equal(
    explainClass(memberMap),
    'Counter declares 3 field(s) and 3 method(s). 2 method(s) read and write state across 1 shared field(s).',
  );
  assert.match(explainClass({ types: [], dataFlow: { available: false } }), /No type was recorded/);
});

test('radarPoints collapse an unavailable axis to the centre', () => {
  const axes = [
    { label: 'Cohesion', value: 100 },
    { label: 'Coverage', value: null },
  ];
  const [full, missing] = radarPoints(axes, { radius: 50, center: 70 });
  assert.equal(Math.hypot(full.x - 70, full.y - 70).toFixed(1), '50.0');
  assert.equal(missing.x, 70);
  assert.equal(missing.y, 70);

  const frame = radarFrame(axes, { radius: 50, center: 70 });
  assert.equal(frame.length, 2);
  assert.match(polygonPoints(frame), /^\d+\.\d,\d+\.\d /);
});

test('constellationLayout is deterministic and includes consumers', () => {
  const points = constellationPoints(memberMap, 2);
  assert.equal(points.filter((point) => point.kind === 'consumer').length, 2);
  const first = constellationLayout(points);
  const second = constellationLayout(points);
  assert.deepEqual(first, second);
  assert.ok(first.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
});

test('orderMembers sorts by source order, name, or visibility', () => {
  const fields = memberMap.types[0].fields;
  assert.deepEqual(orderMembers(fields, 'name').map((field) => field.name), [
    'label',
    'lastError',
    'value',
  ]);
  assert.equal(orderMembers(fields, 'source')[0].name, 'value');
  assert.equal(orderMembers(fields, 'visibility')[0].name, 'label');
});

test('isWiredField and isWiredMethod flag recorded wiring only', () => {
  assert.equal(isWiredField(memberMap.types[0].fields[0]), true);
  assert.equal(isWiredMethod(memberMap.types[0].methods[2]), true);
  assert.equal(isWiredField({ reads: 0, writes: 0 }), false);
  assert.equal(isWiredMethod({ reads: [], writes: [] }), false);
});

test('buildAgentPrompt renders recorded evidence and a kind-aware task', () => {
  const prompt = buildAgentPrompt({
    agent: 'opencode',
    repository: { name: 'demo', root: '/demo' },
    target: {
      kind: 'node',
      id: 'src/util.ts',
      label: 'util.ts',
      evidence: ['Direct importers: 1', 'Blast radius: 4', 'imports src/index.ts (L1 ./util.ts)'],
    },
  });
  assert.match(prompt, /# Strabo task — util\.ts/);
  assert.match(prompt, /Repository: demo \(\/demo\)/);
  assert.match(prompt, /Target: node `src\/util\.ts`/);
  assert.match(prompt, /Blast radius: 4/);
  assert.match(prompt, /do not invent links/);
  assert.match(prompt, /Assess this file/);
});

test('buildAgentPrompt degrades gracefully and rejects unknown agents', () => {
  const bare = buildAgentPrompt({ agent: 'claude', repository: null, target: null });
  assert.match(bare, /Target: view/);
  assert.match(bare, /No further evidence recorded/);
  assert.match(bare, /architectural overview/);

  const unknownKind = buildAgentPrompt({
    agent: 'claude',
    repository: { name: 'demo', root: '/demo' },
    target: { kind: 'nonsense', id: 'x.ts', evidence: [] },
  });
  assert.match(unknownKind, /Target: view/);

  assert.throws(() => buildAgentPrompt({ agent: 'codex', repository: null, target: null }), /Unknown delegate agent/);
});

test('buildAgentPrompt caps runaway evidence', () => {
  const prompt = buildAgentPrompt({
    agent: 'opencode',
    repository: { name: 'demo', root: '/demo' },
    target: { kind: 'diagnostic', id: 'a.ts:1', evidence: Array.from({ length: 40 }, (_, i) => `fact ${i}`) },
  });
  assert.ok(prompt.length <= MAX_DELEGATE_PROMPT + 20);
  assert.match(prompt, /truncated/);
});
