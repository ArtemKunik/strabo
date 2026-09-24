import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_DELEGATE_PROMPT,
  MAX_DIAMETER,
  MIN_DIAMETER,
  SHAPES,
  breadcrumb,
  buildAgentPrompt,
  buildElements,
  buildGraphQuery,
  cohesionDelta,
  constellationLayout,
  constellationPoints,
  diameter,
  edgeEvidenceFor,
  edgeStrokeWidth,
  explainClass,
  fieldCard,
  fileWebUrl,
  filterNodes,
  findPath,
  flowGraph,
  folderLocation,
  graphSummary,
  isWiredField,
  isWiredMethod,
  layoutFlowGraph,
  mapCounts,
  memberClusters,
  memberMapSteps,
  methodCard,
  neighbourhood,
  normalizeGitUrl,
  orderMembers,
  overlayFor,
  passportFor,
  polygonPoints,
  radarFrame,
  radarPoints,
  readingLegend,
  reviewFileLabel,
  reviewGroups,
  reviewOverlay,
  shortcutSheet,
  summarizeDiagnostics,
  tierClass,
  tierColorVar,
  tierFilterIds,
  tierOfFile,
  tierSummaryLabel,
  tierSummaryRows,
  topLevelDirectory,
  unitDiameter,
} from '../../ui/strabo-core.js';
import {
  functionCallers,
  functionCalls,
  functionLabel,
  functionMetrics,
  functionSignature,
  functionSignals,
} from '../../ui/strabo-functions.js';
import {
  GROUP_NAMING_INSTRUCTION,
  MEMBER_NARRATION_INSTRUCTION,
  REVIEW_NARRATION_INSTRUCTION,
  buildGroupNamingEvidence,
  buildMemberNarratorEvidence,
  buildNarratorEvidence,
  buildReviewNarrationEvidence,
  narrativeBlocks,
  narratorDisabledReason,
  narratorKeyLabel,
  narratorMenuState,
  narratorNeedsSetup,
  narratorReplyLabel,
  narratorStatusLabel,
  narratorTestLabel,
} from '../../ui/strabo-narrator.js';
import {
  contractRows,
  crossRepoNodeIds,
  driftRows,
  flowRows,
  repositoryRows,
  serviceEndpointRows,
  serviceFlowRows,
  workspaceSummary,
} from '../../ui/strabo-workspace.js';

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

test('graphSummary counts nodes and edges without internal vocabulary', () => {
  assert.equal(graphSummary(model), '3 nodes · 2 edges');
  assert.equal(graphSummary({ nodes: [], edges: [] }), '0 nodes · 0 edges');
});

test('graphSummary names units at System L0, where the shelves are folded away', () => {
  const system = {
    system: true,
    nodes: [{ id: 'a', kind: 'unit' }, { id: 'b', kind: 'unit' }],
    edges: [{ source: 'a', target: 'b' }],
  };
  assert.equal(graphSummary(system), '2 units · 1 edge');
  // A drill-down draws files, so it stays a node count.
  assert.equal(graphSummary({ ...system, systemUnit: 'a' }), '2 nodes · 1 edge');
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
  assert.deepEqual([...overlay.changedItems], ['c.ts · distance 0']);
  assert.deepEqual([...overlay.affectedItems], ['b.ts · distance 1', 'a.ts · distance 2']);
});

test('overlayFor maps cycles and test reach onto their node classes', () => {
  const cycles = overlayFor('cycles', [{ id: 'a.ts', members: ['a.ts', 'b.ts'] }]);
  assert.equal(cycles.classes.get('a.ts'), 'ov-cycle');
  assert.equal(cycles.classes.get('b.ts'), 'ov-cycle');
  assert.equal(cycles.summary, '1 cycle(s)');

  const reach = overlayFor('test-reach', { testFiles: ['t.ts'], reached: ['a.ts'], unreachedWithDependents: ['d.ts'] });
  assert.equal(reach.classes.get('d.ts'), 'ov-unreached');
  assert.equal(reach.summary, '1 unreached · 1 reached · 1 test files');
  assert.deepEqual(reach.items, ['d.ts']);

  const reachEmpty = overlayFor('test-reach', { testFiles: [], reached: [], unreachedWithDependents: [] });
  assert.equal(reachEmpty.summary, 'no test files identified');

  const reachAll = overlayFor('test-reach', { testFiles: ['t.ts'], reached: ['a.ts'], unreachedWithDependents: [] });
  assert.equal(reachAll.items.length, 0);
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

test('overlayFor maps function hotspots onto their files with their signals', () => {
  const overlay = overlayFor('hotspots', {
    filesScanned: 12,
    filesSkipped: 2,
    hotspots: [
      {
        file: 'src/scan.ts',
        owner: 'scan',
        name: 'walk',
        line: 4,
        signals: [
          { kind: 'nested-loops', line: 4, detail: 'loop nesting 2' },
          { kind: 'long-function', line: 4, detail: '60 lines' },
        ],
      },
      { file: 'src/scan.ts', owner: 'scan', name: 'other', line: 90, signals: [{ kind: 'recursion', line: 90, detail: 'calls itself' }] },
    ],
  });

  assert.deepEqual([...overlay.classes.entries()], [['src/scan.ts', 'ov-hotspot']]);
  assert.equal(overlay.summary, '2 hotspot(s) · 12 file(s) scanned · 2 skipped');
  assert.deepEqual(overlay.items, [
    'src/scan.ts · scan.walk (L4) · nested-loops, long-function · coverage unavailable',
    'src/scan.ts · scan.other (L90) · recursion · coverage unavailable',
  ]);
});

test('overlayFor flags module depth and single-author modules', () => {
  const depth = overlayFor('module-depth', [
    { file: 'thin.ts', signal: 'pass-through', implementationLines: 1, interfaceWidth: 2 },
    { file: 'wide.ts', signal: 'wide-interface', implementationLines: 10, interfaceWidth: 20 },
    { file: 'ok.ts', signal: 'ok', implementationLines: 40, interfaceWidth: 4 },
  ]);

  assert.equal(depth.classes.get('thin.ts'), 'ov-pass-through');
  assert.equal(depth.classes.get('wide.ts'), 'ov-wide-interface');
  assert.equal(depth.classes.has('ok.ts'), false);
  assert.equal(depth.summary, '2 flagged · 1 pass-through · 3 file(s)');

  const ownership = overlayFor('ownership', [
    { file: 'shared.ts', distinctAuthors: 1, commits: 4, transitiveDependents: 3 },
    { file: 'crowded.ts', distinctAuthors: 5, commits: 9, transitiveDependents: 2 },
    { file: 'leaf.ts', distinctAuthors: 1, commits: 1, transitiveDependents: 0 },
  ]);

  assert.equal(ownership.classes.get('shared.ts'), 'ov-sole-owner');
  assert.equal(ownership.classes.has('crowded.ts'), false);
  assert.equal(ownership.classes.has('leaf.ts'), false);
  assert.match(ownership.summary, /1 single-author module/);
});

test('node elements carry no directory colour; the neutral fill is stylesheet-owned', () => {
  const { nodes } = buildElements({
    nodes: [
      { id: 'src/a.ts', kind: 'module' },
      { id: 'src/b.ts', kind: 'module' },
      { id: 'lib/c.ts', kind: 'module' },
    ],
    edges: [],
    positions: [],
  });

  assert.ok(nodes.every((node) => !('color' in node.data)));
});

test('the reading legend names position, not colour, as the directory encoding', () => {
  assert.deepEqual(readingLegend(), ['size = dependents', 'island = directory', 'diamond = test', 'star = entry']);
});

test('buildGraphQuery sends system=1 in system mode', () => {
  const query = buildGraphQuery({ repository: '/demo', mode: 'system', depth: 1, prefix: '' });
  assert.ok(query.includes('system=1'));
  assert.ok(!query.includes('blockDepth'));
});

test('buildGraphQuery sends the open unit and outside links in a system drill-down', () => {
  const query = buildGraphQuery({
    repository: '/demo',
    mode: 'system',
    systemUnit: 'crates/api',
    unitFile: 'crates/api/src/service/ledger.rs',
    showOutside: true,
    expandedUnits: ['crates/core'],
  });
  assert.ok(query.includes('systemUnit=crates%2Fapi'));
  assert.ok(query.includes('outside=1'));
  assert.ok(query.includes('selected=crates%2Fapi%2Fsrc%2Fservice%2Fledger.rs'));
  assert.ok(query.includes('expanded=crates%2Fcore'));

  // Nothing crosses the unit frame unless the action was taken.
  const closed = buildGraphQuery({
    repository: '/demo',
    mode: 'system',
    systemUnit: 'crates/api',
    unitFile: 'crates/api/src/service/ledger.rs',
    showOutside: false,
  });
  assert.ok(!closed.includes('outside=1'));
  assert.ok(!closed.includes('selected='));
});

test('breadcrumb reads System › unit inside a drill-down', () => {
  assert.deepEqual(breadcrumb({ mode: 'system', systemUnit: null }), [
    { label: 'System', prefix: '' },
  ]);
  assert.deepEqual(
    breadcrumb({ mode: 'system', systemUnit: 'crates/api', systemUnitLabel: 'ledger-api' }),
    [
      { label: 'System', prefix: '' },
      { label: 'ledger-api', prefix: 'crates/api' },
    ],
  );
});

test('the reading legend names layers and the outside badge in a drill-down', () => {
  assert.deepEqual(readingLegend({ system: true, systemUnit: 'crates/api' }), [
    'box = unit frame',
    'lane = layer',
    'edge = selected file import',
    'badge = files in another unit',
    'tag = support shelf',
  ]);
});

test('a drill-down file splits its blast radius into in-unit and outside counts', () => {
  const model = {
    system: true,
    systemUnit: 'crates/api',
    nodes: [
      {
        id: 'crates/api/src/service/ledger.rs',
        kind: 'module',
        systemUnit: 'crates/api',
        inUnitDependents: 12,
        outsideDependents: 27,
        transitiveDependents: 39,
      },
    ],
    edges: [],
    positions: [],
  };
  const passport = passportFor(model, 'crates/api/src/service/ledger.rs');
  assert.ok(
    passport.metrics.some(
      (metric) => metric.label === 'Blast radius in unit' && metric.value === 12,
    ),
  );
  assert.ok(
    passport.metrics.some(
      (metric) => metric.label === 'Blast radius outside' && metric.value === 27,
    ),
  );
});

test('mapCounts lists the open unit layers instead of one chip per file', () => {
  const counts = mapCounts({
    system: true,
    systemUnit: 'crates/api',
    nodes: [
      { id: 'crates/api/src/http/routes.rs', kind: 'module', systemLayer: 'http', systemUnit: 'crates/api' },
      { id: 'crates/api/src/http/middleware.rs', kind: 'module', systemLayer: 'http', systemUnit: 'crates/api' },
      { id: 'crates/api/src/service/ledger.rs', kind: 'module', systemLayer: 'service', systemUnit: 'crates/api' },
      { id: 'crates/core', kind: 'module', collapsed: true },
    ],
  });
  const labels = counts.entries.map((entry) => entry.label);
  assert.ok(labels.includes('http'));
  assert.ok(labels.includes('service'));
  assert.ok(labels.includes('outside units'));
  assert.equal(counts.entries.find((entry) => entry.label === 'http')?.count, 2);
});

test('the reading legend names units and files in system mode', () => {
  assert.deepEqual(readingLegend({ system: true }), [
    'box = build unit',
    'size = files',
    'edge = import between units',
    'support = unit footer',
  ]);
});

test('a system unit sizes by files and reports its why caption', () => {
  const systemModel = {
    system: true,
    nodes: [
      {
        id: 'crates/api',
        kind: 'unit',
        label: 'ledger-api',
        files: 12,
        periphery: 3,
        transitiveDependents: 2,
        transitiveDependencies: 1,
        why: 'crate `ledger-api` (Cargo.toml)',
      },
    ],
    edges: [],
    positions: [{ id: 'crates/api', x: 0, y: 0 }],
  };

  const elements = buildElements(systemModel);
  assert.equal(elements.nodes[0].classes, 'kind-unit');
  assert.equal(elements.nodes[0].data.diameter, unitDiameter(12));

  const passport = passportFor(systemModel, 'crates/api');
  assert.equal(passport.why, 'crate `ledger-api` (Cargo.toml)');
  assert.ok(passport.metrics.some((metric) => metric.label === 'Files' && metric.value === 12));
  assert.ok(passport.metrics.some((metric) => metric.label === 'Support files' && metric.value === 3));
});

test('unit and shelf are their own kinds with their own shapes', () => {
  assert.equal(SHAPES.unit, 'round-rectangle');
  assert.equal(SHAPES.shelf, 'rectangle');
  const { nodes } = buildElements({
    nodes: [
      { id: 'crates/api', kind: 'unit' },
      { id: 'crates/api#support', kind: 'shelf' },
    ],
    edges: [],
    positions: [],
  });
  assert.deepEqual(nodes.map((node) => node.classes), ['kind-unit', 'kind-shelf']);
});

test('a unit edge widens with the file count it rolled up', () => {
  const { edges } = buildElements({
    nodes: [{ id: 'a', kind: 'unit' }, { id: 'b', kind: 'unit' }],
    edges: [
      { source: 'a', target: 'b', kind: 'import', weight: 1, evidence: { line: 1, specifier: 'x', resolution: 'exact' } },
      { source: 'b', target: 'a', kind: 'import', weight: 40, evidence: { line: 1, specifier: 'y', resolution: 'exact' } },
    ],
    positions: [],
  });
  assert.equal(edges[0].data.weight, 1);
  assert.equal(edges[0].data.edgeWidth, edgeStrokeWidth(1));
  assert.ok(edges[1].data.edgeWidth > edges[0].data.edgeWidth);
  assert.equal(edges[1].data.edgeWidth, edgeStrokeWidth(40));
  // A file edge carries no weight and stays the base hairline.
  assert.equal(edgeStrokeWidth(undefined), 1.2);
  assert.ok(edgeStrokeWidth(40) <= 4);
});

test('buildElements carries the edge kind so the calls lens can filter on it', () => {
  const { edges } = buildElements({
    nodes: [{ id: 'a', kind: 'module' }, { id: 'b', kind: 'module' }],
    edges: [
      { source: 'a', target: 'b', kind: 'import', evidence: { line: 1, specifier: './b', resolution: 'exact' } },
      { source: 'a', target: 'b', kind: 'call', evidence: { line: 2, specifier: 'b', resolution: 'exact' } },
    ],
    positions: [],
  });

  assert.equal(edges[0].data.kind, 'import');
  assert.equal(edges[1].data.kind, 'call');
});

test('buildGroupNamingEvidence reports only recorded unit facts', () => {
  const systemModel = {
    system: true,
    nodes: [
      { id: 'crates/api', label: 'ledger-api', files: 4, periphery: 2, why: 'crate `ledger-api` (Cargo.toml)' },
      { id: 'crates/core', label: 'ledger-core' },
    ],
    edges: [{ source: 'crates/api', target: 'crates/core', evidence: { specifier: 'ledger-core' } }],
  };
  const evidence = buildGroupNamingEvidence(systemModel, 'crates/api');
  assert.match(evidence, /Unit: ledger-api/);
  assert.match(evidence, /Grouped by: crate `ledger-api`/);
  assert.match(evidence, /Component files: 4/);
  assert.match(evidence, /Support files folded into its shelf: 2/);
  assert.match(evidence, /Recorded imports: ledger-core/);
  assert.match(GROUP_NAMING_INSTRUCTION, /do not create, merge, or split/i);
});

test('the tier helpers map a report to classes, colours, and a filter set', () => {
  const report = {
    files: [
      { file: 'src/handlers/a.ts', tier: 'api' },
      { file: 'src/data/b.ts', tier: 'data' },
      { file: 'src/thing.ts', tier: 'unclassified' },
    ],
    summary: { frontend: 0, api: 1, domain: 0, data: 1, integration: 0, infra: 0, build: 0, tests: 0, unclassified: 1, total: 3, mixed: 0 },
  };

  assert.equal(tierClass('api'), 'tier-api');
  assert.equal(tierClass('nonsense'), 'tier-unclassified');
  assert.equal(tierColorVar('data'), 'var(--tier-data)');
  assert.equal(tierColorVar('unclassified'), 'var(--series-other)');

  const map = tierOfFile(report);
  assert.equal(map.get('src/handlers/a.ts'), 'api');
  assert.equal(tierFilterIds(map, 'all').size, 3);
  assert.deepEqual([...tierFilterIds(map, 'data')], ['src/data/b.ts']);

  assert.deepEqual(
    tierSummaryRows(report).map((row) => [row.tier, row.count, row.color]),
    [
      ['api', 1, 'var(--tier-api)'],
      ['data', 1, 'var(--tier-data)'],
      ['unclassified', 1, 'var(--series-other)'],
    ],
  );
  assert.equal(tierSummaryLabel(report), '3 file(s) classified · 1 unclassified');
});

test('mapCounts lists units in system mode', () => {
  const counts = mapCounts({
    system: true,
    nodes: [
      { id: 'crates/api', kind: 'module' },
      { id: 'crates/core', kind: 'module' },
    ],
  });
  assert.equal(counts.modules, 2);
  assert.deepEqual(
    counts.entries.map((entry) => entry.label),
    ['crates/api', 'crates/core'],
  );
});

test('shortcutSheet carries the gestures the legend no longer mixes in', () => {
  const keys = shortcutSheet().map((entry) => entry.keys);
  assert.ok(keys.includes('?'));
  assert.ok(keys.includes('C'));
  assert.ok(keys.includes('S'));
  assert.ok(keys.some((key) => key.includes('hover')));
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
});

test('passportFor counts distinct files, not the edges that record them', () => {
  const withCalls = {
    ...model,
    edges: [
      ...model.edges,
      // A recorded call beside the import, plus a second import line, are one importer.
      { source: 'src/index.ts', target: 'src/util.ts', kind: 'call', evidence: { line: 4, specifier: 'util' } },
      { source: 'src/index.ts', target: 'src/util.ts', kind: 'import', evidence: { line: 5, specifier: './util.ts' } },
    ],
  };
  const passport = passportFor(withCalls, 'src/util.ts');
  const importers = passport.metrics.find((metric) => metric.label === 'Direct importers');

  assert.equal(importers?.value, 1);
  assert.equal(importers?.unit, 'files');
  assert.deepEqual(passport.usedBy.map((entry) => entry.id), ['src/index.ts']);
});

test('passportFor shows the file line count when the scan recorded one', () => {
  const withLines = {
    ...model,
    nodes: model.nodes.map((node) => (node.id === 'src/util.ts' ? { ...node, lines: 42 } : node)),
  };
  const lines = passportFor(withLines, 'src/util.ts').metrics.find((metric) => metric.label === 'Lines');
  assert.equal(lines?.value, 42);
  assert.equal(
    passportFor(model, 'src/util.ts').metrics.some((metric) => metric.label === 'Lines'),
    false,
  );
});

test('buildElements labels a block node from the server directoryLabels', () => {
  const elements = buildElements({
    nodes: [{ id: 'src/api', kind: 'module', transitiveDependents: 0 }],
    edges: [],
    positions: [],
    directoryLabels: { 'src/api': 'service › api' },
  });
  assert.equal(elements.nodes[0].data.label, 'service › api');
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
  const moduleTree = {
    edges: [{ source: 'a.ts', target: 'b.ts', kind: 'import', evidence: { resolution: 'module-tree' } }],
  };
  assert.equal(edgeEvidenceFor(moduleTree, 'e0')?.resolutionLabel, 'module tree');
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

test('cohesionDelta reports direction and names a missing side instead of a zero', () => {
  assert.deepEqual(cohesionDelta({ before: 67, after: 100 }), {
    tone: 'up',
    text: 'cohesion 67 → 100 (+33)',
  });
  assert.deepEqual(cohesionDelta({ before: 100, after: 80 }), {
    tone: 'down',
    text: 'cohesion 100 → 80 (-20)',
  });
  assert.equal(cohesionDelta({ before: 80, after: 80 }).tone, 'flat');
  assert.deepEqual(cohesionDelta({ before: null, after: 100, note: 'no baseline revision' }), {
    tone: 'new',
    text: 'new · cohesion 100',
  });
  assert.deepEqual(cohesionDelta({ before: 80, after: null, note: 'deleted — no reviewed state' }), {
    tone: 'removed',
    text: 'removed · cohesion 80',
  });
  assert.match(cohesionDelta({ before: null, after: null, note: 'no symbol extractor' }).text, /unavailable/);
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

test('memberMapSteps attributes a multi-type file to the file, never to its first type', () => {
  // Regression: RiffStep.kt held RiffNote (2 fields) and RiffStep (1 field), and the caption
  // claimed "RiffNote contains 3 field(s)" — the first type wearing its siblings' members.
  const multi = {
    ...memberMap,
    types: [
      { ...memberMap.types[0], name: 'RiffNote' },
      { name: 'RiffStep', visibility: 'public', line: 8, fields: [{ name: 'notes', visibility: 'public', line: 9, reads: 0, writes: 0 }], methods: [] },
    ],
  };
  const steps = memberMapSteps(multi, {});
  assert.equal(steps[0].caption, 'This file (2 types) contains 4 field(s) and 3 behavior(s).');
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

test('flowGraph draws reads field-to-method and writes method-to-field', () => {
  const graph = flowGraph(memberMap);
  assert.deepEqual(
    graph.nodes.map((node) => node.id).sort(),
    ['field:label', 'field:lastError', 'field:value', 'method:add', 'method:fail', 'method:reset'],
  );
  const kinds = new Map(graph.edges.map((edge) => [`${edge.from}→${edge.to}`, edge.kind]));
  assert.equal(kinds.get('field:value→method:add'), 'read');
  assert.equal(kinds.get('method:add→field:value'), 'write');
  assert.equal(kinds.get('field:label→method:reset'), 'read');
  assert.equal(kinds.get('method:reset→field:value'), 'write');
  assert.equal(kinds.get('method:fail→field:lastError'), 'write');
  assert.equal(graph.edges.length, 5);
});

test('flowGraph drops references to undeclared members instead of dangling', () => {
  const graph = flowGraph({
    types: [
      {
        name: 'Orphan',
        fields: [{ name: 'kept' }],
        methods: [{ name: 'touch', reads: ['kept', 'ghost'], writes: [] }],
      },
    ],
  });
  assert.deepEqual(graph.edges, [{ from: 'field:kept', to: 'method:touch', kind: 'read' }]);
});

test('flowGraph reports nothing to draw without wiring', () => {
  assert.deepEqual(flowGraph(null), { nodes: [], edges: [] });
  assert.deepEqual(flowGraph({ types: [] }).edges, []);
});

test('layoutFlowGraph columns fields left and methods right, deterministically', () => {
  const first = layoutFlowGraph(flowGraph(memberMap));
  const second = layoutFlowGraph(flowGraph(memberMap));
  assert.deepEqual(first, second);
  const byId = new Map(first.nodes.map((node) => [node.id, node]));
  for (const node of first.nodes) {
    assert.equal(node.x, node.kind === 'field' ? 0 : first.width - node.w);
  }
  assert.ok(byId.get('field:value').y < byId.get('field:lastError').y);
  assert.ok(first.height > 0);
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

test('buildAgentPrompt frames a review target around functional effect', () => {
  const prompt = buildAgentPrompt({
    agent: 'claude',
    repository: { name: 'demo', root: '/demo' },
    target: {
      kind: 'review',
      label: 'pending working tree',
      evidence: [
        'modified (unstaged): public/strabo.js — +12 -3',
        'potentially affected: public/index.html (distance 1)',
      ],
    },
  });
  assert.match(prompt, /# Strabo task — pending working tree/);
  assert.match(prompt, /Target: review/);
  assert.match(prompt, /modified \(unstaged\): public\/strabo\.js/);
  assert.match(prompt, /as a function of the app/);
});

test('buildAgentPrompt carries highlighted text as a quoted section', () => {
  const selection = 'yaml@2.2.2 · stack overflow\nFixed in: 2.8.3';
  const repository = { name: 'strabo', root: '/repo' };

  const alone = buildAgentPrompt({
    agent: 'claude',
    repository,
    target: { kind: 'selection', label: '“yaml”', evidence: ['244 nodes'], selection },
  });
  assert.match(alone, /## Selected text/);
  assert.match(alone, /> yaml@2\.2\.2 · stack overflow\n> Fixed in: 2\.8\.3/);
  assert.match(alone, /Address the selected text/);

  const onNode = buildAgentPrompt({
    agent: 'claude',
    repository,
    target: { kind: 'node', id: 'src/a.ts', evidence: [], selection },
  });
  assert.match(onNode, /> Fixed in: 2\.8\.3/);
  assert.match(onNode, /Assess this file/);
  assert.match(onNode, /particular attention/);

  const without = buildAgentPrompt({ agent: 'claude', repository, target: { kind: 'node', id: 'src/a.ts' } });
  assert.doesNotMatch(without, /Selected text/);

  const huge = buildAgentPrompt({
    agent: 'claude',
    repository,
    target: { kind: 'selection', selection: 'x'.repeat(9000) },
  });
  assert.match(huge, /selection truncated/);
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

test('buildAgentPrompt renders a group target as one subsection per file', () => {
  const prompt = buildAgentPrompt({
    agent: 'opencode',
    repository: { name: 'demo', root: '/demo' },
    target: {
      kind: 'group',
      items: [
        { id: 'src/a.ts', label: 'a.ts', evidence: ['Blast radius: 2'] },
        { id: 'src/b.ts', label: 'b.ts', evidence: ['Blast radius: 5'] },
      ],
    },
  });
  assert.match(prompt, /# Strabo task — 2 file\(s\)/);
  assert.match(prompt, /Target: group \(2 file\(s\)\)/);
  assert.match(prompt, /### a\.ts \(`src\/a\.ts`\)/);
  assert.match(prompt, /Blast radius: 2/);
  assert.match(prompt, /### b\.ts \(`src\/b\.ts`\)/);
  assert.match(prompt, /Blast radius: 5/);
  assert.match(prompt, /Assess this set of files together/);
});

test('buildAgentPrompt degrades an empty group and truncates a huge one', () => {
  const empty = buildAgentPrompt({
    agent: 'claude',
    repository: null,
    target: { kind: 'group', items: [] },
  });
  assert.match(empty, /No files recorded in this selection/);

  const many = buildAgentPrompt({
    agent: 'claude',
    repository: { name: 'demo', root: '/demo' },
    target: {
      kind: 'group',
      items: Array.from({ length: 45 }, (_, i) => ({ id: `src/f${i}.ts`, evidence: [`fact ${i}`] })),
    },
  });
  assert.match(many, /### …and 15 more file\(s\) \(not detailed\)/);
  assert.match(many, /src\/f44\.ts/);
});

test('functionLabel and functionSignature describe a recorded function', () => {
  assert.equal(functionLabel({ owner: 'Counter', name: 'add' }), 'Counter.add');
  assert.equal(functionLabel({ owner: '', name: 'util' }), 'util');
  assert.equal(
    functionSignature({ name: 'add', visibility: 'public', parameters: 1, type: 'void' }),
    'public add(1 param): void',
  );
  assert.equal(functionSignature({ name: 'reset', visibility: 'private', parameters: 0 }), 'private reset(0 params)');
});

test('functionMetrics reports body measurements or a signature without a body', () => {
  const withBody = functionMetrics({
    line: 3,
    metrics: {
      endLine: 7,
      lines: 5,
      statementCount: 3,
      decisionPoints: 2,
      maxNestingDepth: 1,
      loops: 1,
      recursive: true,
    },
  });
  assert.match(withBody, /L3-7/);
  assert.match(withBody, /complexity 2/);
  assert.match(withBody, /recursive/);
  assert.equal(functionMetrics({ line: 9, metrics: undefined }), 'signature only; no body recorded');
});

test('functionCalls and functionCallers state the absence of wiring instead of an empty list', () => {
  assert.equal(functionCalls({ calls: [] }), 'no same-file calls recorded');
  assert.equal(functionCallers({ callers: [] }), 'no callers recorded in this file');
  assert.equal(
    functionCalls({ calls: [{ name: 'helper', line: 3 }, { name: 'util', line: 4 }] }),
    'helper (L3), util (L4)',
  );
  assert.equal(functionCallers({ callers: ['A.run', 'A.branchy'] }), 'A.run, A.branchy');
});

test('functionSignals lists the recorded cost signals or says there are none', () => {
  assert.equal(functionSignals({ signals: [] }), 'no cost signals');
  assert.equal(
    functionSignals({
      signals: [
        { kind: 'nested-loops', detail: 'loop nesting 2 (threshold 2)' },
        { kind: 'recursion', detail: 'calls itself' },
      ],
    }),
    'nested-loops (loop nesting 2 (threshold 2)); recursion (calls itself)',
  );
});

test('narratorStatusLabel names the off state once and reports the budget', () => {
  assert.equal(narratorStatusLabel(null), 'Narrator is off.');
  assert.equal(narratorStatusLabel({ configured: false, reason: 'not-configured' }), 'Narrator is off.');
  assert.equal(
    narratorStatusLabel({ configured: true, model: 'gpt-x', requestBudget: 20, remaining: 18 }),
    'Narrator ready · gpt-x · 18/20 requests left',
  );
});

test('narratorNeedsSetup and narratorDisabledReason collapse the old two lines', () => {
  assert.equal(narratorNeedsSetup(null), true);
  assert.equal(narratorNeedsSetup({ configured: false }), true);
  assert.equal(narratorNeedsSetup({ configured: true, model: 'm' }), false);
  assert.match(narratorDisabledReason({ configured: false }) ?? '', /off/i);
  assert.equal(narratorDisabledReason({ configured: true, model: 'm' }), null);
  assert.match(
    narratorDisabledReason({ configured: true, model: 'm', reason: 'not-authenticated', detail: 'set X' }) ?? '',
    /not-authenticated — set X/,
  );
});

test('narratorTestLabel reports latency and model, or the problem in plain words', () => {
  assert.match(narratorTestLabel({ ok: true, model: 'gpt-x', latencyMs: 42 }), /gpt-x replied in 42 ms/);
  assert.match(narratorTestLabel({ ok: false, reason: 'provider-error', detail: '401: key rejected' }), /401: key rejected/);
  assert.match(narratorTestLabel(null), /Test the connection/);
});

test('narratorKeyLabel reports set / found / missing, never a key value', () => {
  assert.match(narratorKeyLabel({ source: 'env', envVar: 'STRABO_NARRATOR_API_KEY' }), /Key found in STRABO_NARRATOR_API_KEY/);
  assert.match(narratorKeyLabel({ source: 'stored', host: 'api.example.com' }), /stored on this machine for api.example.com/);
  assert.match(narratorKeyLabel({ source: 'none', envVar: 'STRABO_NARRATOR_API_KEY', host: 'api.example.com' }), /Key missing/);
});

test('narratorReplyLabel renders the narrative or the reason it is unavailable', () => {
  assert.equal(narratorReplyLabel({ available: true, text: 'Clustered in src/api.' }), 'Clustered in src/api.');
  assert.equal(
    narratorReplyLabel({ available: false, reason: 'not-configured' }),
    'Narrator unavailable: not-configured',
  );
  assert.equal(
    narratorReplyLabel({ available: false, reason: 'provider-error', detail: 'endpoint returned 500' }),
    'Narrator unavailable: provider-error — endpoint returned 500',
  );
});

test('buildNarratorEvidence lists recorded metrics, signals, and calls only', () => {
  const evidence = buildNarratorEvidence({
    functions: {
      file: 'src/a.ts',
      available: true,
      functions: [
        {
          name: 'run',
          owner: 'A',
          line: 3,
          metrics: { decisionPoints: 4, maxNestingDepth: 2, lines: 12 },
          signals: [{ kind: 'nested-loops', detail: 'loop nesting 2 (threshold 2)' }],
          calls: [{ name: 'helper', line: 5 }],
        },
      ],
    },
  });
  assert.match(evidence, /File: src\/a\.ts/);
  assert.match(evidence, /- A\.run \(line 3\)/);
  assert.match(evidence, /complexity 4, nesting 2, lines 12/);
  assert.match(evidence, /nested-loops \(loop nesting 2/);
  assert.match(evidence, /helper \(L5\)/);
  assert.equal(
    buildNarratorEvidence({ functions: { available: true, functions: [] } }),
    'No function inventory is recorded for this file.',
  );
});

test('buildMemberNarratorEvidence lists recorded members and data flow only', () => {
  const evidence = buildMemberNarratorEvidence({
    types: [
      {
        name: 'Counter',
        visibility: 'public',
        fields: [
          { name: 'value', visibility: 'private', type: 'int', mutable: true, reads: 2, writes: 1 },
          { name: 'label', visibility: 'public', type: undefined, mutable: false, reads: 0, writes: 0 },
        ],
        methods: [
          { name: 'increment', visibility: 'public', parameters: 0, reads: ['value'], writes: ['value'] },
          { name: 'reset', visibility: 'private', parameters: 1, type: 'void', reads: [], writes: [] },
        ],
      },
    ],
    dataFlow: {
      available: true,
      sources: [],
      resources: ['value'],
      transforms: ['Counter.increment'],
      sinks: [],
    },
  });
  assert.match(evidence, /Type: Counter \(public\)/);
  assert.match(evidence, /- value: int · private · mutable · reads 2 · writes 1/);
  assert.match(evidence, /- label: unrecorded type · public · readonly · reads 0 · writes 0/);
  assert.match(evidence, /- increment\(0\) · public/);
  assert.match(evidence, /reads: value/);
  assert.match(evidence, /- reset\(1\): void · private/);
  assert.match(evidence, /reads: none recorded/);
  assert.match(evidence, /Data flow resources: value/);
  assert.match(evidence, /Data flow transforms: Counter\.increment/);
  assert.match(evidence, /Data flow sources: none recorded/);

  assert.equal(buildMemberNarratorEvidence({ types: [] }), 'No type is recorded for this file.');
  const noFlow = buildMemberNarratorEvidence({
    types: [{ name: 'Plain', visibility: 'public', fields: [], methods: [] }],
    dataFlow: { available: false, detail: 'No field references were recorded in this file.' },
  });
  assert.match(noFlow, /Data flow: not recorded — No field references were recorded/);
});

test('the member narration instruction forbids inferring beyond recorded evidence', () => {
  assert.match(MEMBER_NARRATION_INSTRUCTION, /recorded evidence/);
  assert.match(MEMBER_NARRATION_INSTRUCTION, /not recorded/);
});

test('buildMemberNarratorEvidence frames module-level members and adds the file neighbours', () => {
  const evidence = buildMemberNarratorEvidence(
    {
      file: 'ui/strabo-virtual.js',
      types: [
        {
          name: 'strabo-virtual',
          fields: [],
          methods: [{ name: 'virtualRange', visibility: 'public', parameters: 5, reads: [], writes: [] }],
        },
      ],
      dataFlow: { available: false, detail: 'No field references were recorded in this file.' },
    },
    {
      imports: [],
      usedBy: ['ui/strabo-panels.js', 'ui/strabo.js'],
      functions: {
        available: true,
        file: 'ui/strabo-virtual.js',
        functions: [{ name: 'virtualRange', line: 4, metrics: { decisionPoints: 3, maxNestingDepth: 1, lines: 20 } }],
      },
    },
  );
  assert.match(evidence, /^File: ui\/strabo-virtual\.js/);
  assert.match(evidence, /Recorded imports \(0\): none recorded/);
  assert.match(evidence, /Recorded used-by \(2\): ui\/strabo-panels\.js, ui\/strabo\.js/);
  assert.match(evidence, /Module-level members \(declared directly in the file/);
  assert.doesNotMatch(evidence, /Type: strabo-virtual/, 'the file-derived name must not read as a declared type');
  assert.doesNotMatch(evidence, /Fields: 0/);
  assert.match(evidence, /complexity 3, nesting 1, lines 20/);
});

test('the narration instruction asks for short prose, allows a hedged reading, and bars invention', () => {
  assert.match(MEMBER_NARRATION_INSTRUCTION, /three to five sentences/);
  assert.match(MEMBER_NARRATION_INSTRUCTION, /appears to/);
  assert.match(MEMBER_NARRATION_INSTRUCTION, /never invent/);
});

test('buildReviewNarrationEvidence lists the recorded change set only', () => {
  const evidence = buildReviewNarrationEvidence({
    kind: 'commit',
    commit: { shortHash: '9f98c81', author: 'opencode', date: '2026-09-21T10:00:00Z', subject: 'fix(android): remove negative padding' },
    totals: { files: 1, insertions: 0, deletions: 1, uncounted: 0 },
    files: [
      { path: 'app/CommuteComponents.kt', status: 'modified', group: 'commit', insertions: 0, deletions: 1, inGraph: true },
    ],
    impact: { affected: [{ id: 'app/HomeScreen.kt', distance: 2 }], outsideGraph: [] },
    metrics: {
      totals: {
        measured: 1,
        files: 1,
        complexity: { before: 24, after: 24, added: 0, removed: 0 },
        coupling: { added: 0, removed: 0 },
      },
    },
    cohesion: { baseline: 'HEAD', files: [{ path: 'app/CommuteComponents.kt', before: 0, after: 0, note: '' }] },
  });
  assert.match(evidence, /^Commit review/);
  assert.match(evidence, /Commit: fix\(android\): remove negative padding \(9f98c81 by opencode, 2026-09-21\)/);
  assert.match(evidence, /Changed: 1 file\(s\), \+0 −1 lines/);
  assert.match(evidence, /- app\/CommuteComponents\.kt \(modified, \+0 −1, in graph\)/);
  assert.match(evidence, /Recorded dependents the change can reach: 1/);
  assert.match(evidence, /- app\/HomeScreen\.kt \(distance 2\)/);
  assert.match(evidence, /Change metrics: complexity \+0 −0 \(24 → 24\); coupling \+0 −0 import\(s\)/);
  assert.match(evidence, /Cohesion from recorded member wiring compared with HEAD:/);
  assert.match(evidence, /- app\/CommuteComponents\.kt: cohesion 0 → 0/);
});

test('buildReviewNarrationEvidence names missing counts and empty change sets', () => {
  const evidence = buildReviewNarrationEvidence({
    kind: 'working-tree',
    totals: { files: 1, insertions: 0, deletions: 0, uncounted: 1 },
    files: [{ path: 'logo.png', status: 'untracked', group: 'untracked', insertions: null, deletions: null, inGraph: false }],
    impact: { affected: [], outsideGraph: ['logo.png'] },
  });
  assert.match(evidence, /^Working-tree review/);
  assert.match(evidence, /1 uncounted/);
  assert.match(evidence, /- logo\.png \(untracked, line counts unavailable, outside the scanned graph\)/);
  assert.match(evidence, /Recorded dependents the change can reach: 0/);
  assert.match(evidence, /Changed paths outside the scanned graph: 1/);
  assert.doesNotMatch(evidence, /Change metrics/);

  const empty = buildReviewNarrationEvidence({ kind: 'commit', files: [], totals: { files: 0, insertions: 0, deletions: 0, uncounted: 0 }, impact: { affected: [], outsideGraph: [] } });
  assert.match(empty, /Changed files \(0\):\n- none recorded/);
});

test('the review narration instruction asks what the change does for the app', () => {
  assert.match(REVIEW_NARRATION_INSTRUCTION, /three to six sentences/);
  assert.match(REVIEW_NARRATION_INSTRUCTION, /capability or behaviour/);
  assert.match(REVIEW_NARRATION_INSTRUCTION, /appears to/);
  assert.match(REVIEW_NARRATION_INSTRUCTION, /never invent/);
});

test('narrativeBlocks turns light markdown into paragraphs, lists, and inline runs', () => {
  const blocks = narrativeBlocks(
    'It wraps `virtualRange` and is **hot**.\n\nNotes:\n1. first\n2) second\n- a\n\n## Heading\nDone',
  );
  assert.deepEqual(blocks[0], {
    type: 'p',
    runs: [
      { text: 'It wraps ' },
      { text: 'virtualRange', code: true },
      { text: ' and is ' },
      { text: 'hot', strong: true },
      { text: '.' },
    ],
  });
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['p', 'p', 'ol', 'ul', 'p'],
  );
  assert.equal(blocks[2].items.length, 2);
  assert.deepEqual(blocks[4].runs, [{ text: 'Heading Done' }]);
  assert.deepEqual(narrativeBlocks(''), []);
});

test('narratorMenuState is inactive with the reason while the narrator is off or failing', () => {
  assert.deepEqual(narratorMenuState({ configured: true, model: 'm' }), { enabled: true, hint: null });
  assert.equal(narratorMenuState(null).enabled, false);
  assert.match(narratorMenuState({ configured: false }).hint ?? '', /off/i);
  const failing = narratorMenuState({ configured: true, model: 'm', reason: 'not-authenticated', detail: 'set X' });
  assert.equal(failing.enabled, false);
  assert.match(failing.hint ?? '', /set X/);
});

test('workspaceSummary reports the recorded counts or says it is unrecorded', () => {
  assert.equal(workspaceSummary(null), 'Workspace not recorded.');
  assert.equal(
    workspaceSummary({ summary: { repositories: 2, flows: 1, serviceFlows: 4, contracts: 3, drifting: 1 } }),
    '2 repositories · 1 cross-repo flows · 4 service flows · 3 contracts · 1 drifting',
  );
  assert.equal(
    workspaceSummary({ summary: { repositories: 1, flows: 0, contracts: 0, drifting: 0 } }),
    '1 repositories · 0 cross-repo flows · 0 service flows · 0 contracts · 0 drifting',
  );
});

test('repositoryRows reports commit, dirty state, and published coordinate', () => {
  const [first, second] = repositoryRows({
    repositories: [
      { name: 'api', head: 'abcdef123456', dirty: true, publishes: { ecosystem: 'npm', name: '@acme/api' } },
      { name: 'web', head: null, dirty: false, publishes: null },
    ],
  });
  assert.deepEqual(first, { name: 'api', head: 'abcdef1', dirty: true, publishes: 'npm:@acme/api' });
  assert.deepEqual(second, { name: 'web', head: null, dirty: false, publishes: null });
});

test('flowRows, contractRows, and driftRows shape the recorded workspace', () => {
  const [flow] = flowRows({
    flows: [
      {
        from: 'web',
        to: 'api',
        ecosystem: 'npm',
        package: '@acme/api',
        files: [{ file: 'a.ts', line: 1, specifier: '@acme/api' }],
        publishedBy: 'package.json',
      },
    ],
  });
  assert.equal(flow.label, 'web → api (npm @acme/api)');
  assert.equal(flow.files, 1);
  assert.equal(flow.publishedBy, 'package.json');

  const [contract] = contractRows({
    contracts: [
      { id: 'acme.User', format: 'protobuf', repository: 'api', source: 'u.proto', fields: [{}, {}] },
    ],
  });
  assert.equal(contract.label, 'acme.User (protobuf) — api');
  assert.equal(contract.fields, 2);

  const [clean, drifting] = driftRows({
    drift: [
      { id: 'acme.User', format: 'protobuf', repositories: ['api', 'web'], deviations: [] },
      {
        id: 'acme.Address',
        format: 'json-schema',
        repositories: ['api', 'web'],
        deviations: [{ name: 'zip', declared: [], issue: 'missing' }],
      },
    ],
  });
  assert.equal(clean.clean, true);
  assert.deepEqual(clean.deviations, []);
  assert.equal(drifting.clean, false);
  assert.deepEqual(drifting.deviations, ['zip: missing']);
});

test('serviceEndpointRows and serviceFlowRows shape the recorded service wiring', () => {
  const [endpoint] = serviceEndpointRows({
    serviceEndpoints: [
      { repository: 'api', source: 'openapi.yaml', method: 'GET', path: '/users/{id}', host: 'api.acme.dev' },
    ],
  });
  assert.equal(endpoint.label, 'GET api.acme.dev/users/{id}');
  assert.equal(endpoint.repository, 'api');
  assert.equal(endpoint.source, 'openapi.yaml');

  const [hostless] = serviceEndpointRows({
    serviceEndpoints: [{ repository: 'api', source: 'openapi.yaml', method: 'POST', path: '/users', host: null }],
  });
  assert.equal(hostless.label, 'POST /users');

  const [flow] = serviceFlowRows({
    serviceFlows: [
      {
        from: 'web',
        to: 'api',
        method: 'GET',
        path: '/users/{id}',
        host: 'api.acme.dev',
        calls: [{ file: 'src/client.ts', line: 12, target: 'https://api.acme.dev/users/1', method: 'GET' }],
        declaredBy: 'openapi.yaml',
      },
    ],
  });
  assert.equal(flow.label, 'web → api (GET api.acme.dev/users/{id})');
  assert.equal(flow.calls, 1);
  assert.equal(flow.declaredBy, 'openapi.yaml');
});

test('crossRepoNodeIds keeps only recorded files the current graph actually drew', () => {
  const report = {
    flows: [{ files: [{ file: 'src/uses-api.ts' }, { file: 'src/absent.ts' }] }],
    serviceFlows: [{ calls: [{ file: 'src/client.ts' }, { file: 'src/uses-api.ts' }] }],
    serviceEndpoints: [{ source: 'openapi.yaml' }],
  };
  const nodes = ['src/uses-api.ts', 'src/client.ts', 'src/other.ts'];

  assert.deepEqual(crossRepoNodeIds(report, nodes), ['src/client.ts', 'src/uses-api.ts']);
  assert.deepEqual(crossRepoNodeIds(null, nodes), []);
  assert.deepEqual(crossRepoNodeIds(report, []), []);
});

test('buildElements qualifies a file name that another file shares, and only that one', () => {
  const elements = buildElements({
    nodes: [
      { id: 'portfolio/types.rs', kind: 'module' },
      { id: 'market/types.rs', kind: 'module' },
      { id: 'market/engine.rs', kind: 'module' },
      { id: 'README.md', kind: 'module' },
    ],
    edges: [],
    positions: [],
  });
  const labels = Object.fromEntries(elements.nodes.map((node) => [node.data.id, node.data.label]));
  assert.equal(labels['portfolio/types.rs'], 'portfolio/types.rs');
  assert.equal(labels['market/types.rs'], 'market/types.rs');
  assert.equal(labels['market/engine.rs'], 'engine.rs');
  assert.equal(labels['README.md'], 'README.md');
});
