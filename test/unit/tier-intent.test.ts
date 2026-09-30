import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { buildTierIntent } from '../../src/analysis/tiers/intent.ts';
import type { Tier, TierClassification, TierFlow, TierFlowEdge } from '../../src/analysis/tiers/types.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function repositoryWithRules(rules: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-intent-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'strabo.rules.yml'), rules);
  return root;
}

const files = (entries: Array<[string, Tier]>): TierClassification[] =>
  entries.map(([file, tier]) => ({ file, tier })) as unknown as TierClassification[];

const edge = (
  source: Tier,
  target: Tier,
  kind: TierFlowEdge['kind'],
  imports: Array<[string, string]>,
): TierFlowEdge => ({
  source,
  target,
  kind,
  weight: imports.length,
  crossUnit: 0,
  typeOnly: 0,
  units: ['.'],
  imports: imports.map(([from, to], index) => ({ source: from, target: to, line: index + 1, specifier: to })),
});

const graphEdges = (edges: TierFlowEdge[]) =>
  edges.flatMap((entry) =>
    (entry.imports ?? []).map((item) => ({
      source: item.source,
      target: item.target,
      kind: 'import',
      evidence: { line: item.line, specifier: item.specifier },
    })),
  );

const assignment = (classified: TierClassification[]) => new Map(classified.map((entry) => [entry.file, '.']));

const flowOf = (edges: TierFlowEdge[]): TierFlow => ({
  tiers: ['api', 'domain', 'data'],
  edges,
  intraByTier: [],
  total: edges.reduce((sum, entry) => sum + entry.weight, 0),
  intraRatio: 0,
});

const classified = files([
  ['src/api/a.ts', 'api'],
  ['src/api/b.ts', 'api'],
  ['src/state/store.ts', 'data'],
  ['src/cache/cache.ts', 'data'],
  ['src/domain/x.ts', 'domain'],
]);

test('a rule excuses only the imports it matches, and an edge it covers in part keeps the count', () => {
  const root = repositoryWithRules(
    'rules:\n  - id: api-reads-stores\n    from: "src/api/**"\n    to: "src/state/**"\n    allow: import\n',
  );
  const skip = edge('api', 'data', 'skip-layer', [
    ['src/api/a.ts', 'src/state/store.ts'],
    ['src/api/b.ts', 'src/state/store.ts'],
    ['src/api/b.ts', 'src/cache/cache.ts'],
  ]);
  const flow = flowOf([skip]);
  buildTierIntent(root, classified, flow, graphEdges([skip]), assignment(classified));

  assert.equal(skip.allowedCount, 2);
  assert.equal(skip.intended, undefined, 'one import is not covered, so the edge is not intended');
  assert.deepEqual(skip.allowedRules, ['api-reads-stores']);
  // The unexplained import is in the sample and is not flagged allowed.
  const uncovered = skip.imports?.find((entry) => entry.target === 'src/cache/cache.ts');
  assert.ok(uncovered);
  assert.equal(uncovered.allowed, undefined);
  assert.equal(skip.imports?.filter((entry) => entry.allowed === true).length, 2);
});

test('an edge whose every import is covered is intended and names its rule', () => {
  const root = repositoryWithRules(
    'rules:\n  - id: api-reads-data\n    from: "src/api/**"\n    to: "src/**"\n    allow: import\n',
  );
  const skip = edge('api', 'data', 'skip-layer', [
    ['src/api/a.ts', 'src/state/store.ts'],
    ['src/api/b.ts', 'src/cache/cache.ts'],
  ]);
  buildTierIntent(root, classified, flowOf([skip]), graphEdges([skip]), assignment(classified));
  assert.equal(skip.intended, true);
  assert.equal(skip.allowedCount, 2);
  assert.equal(skip.ruleId, 'api-reads-data');
});

test('several rules covering one edge are all named and no single rule is claimed', () => {
  const root = repositoryWithRules(
    [
      'rules:',
      '  - { id: reads-stores, from: "src/api/**", to: "src/state/**", allow: import }',
      '  - { id: reads-caches, from: "src/api/**", to: "src/cache/**", allow: import }',
      '',
    ].join('\n'),
  );
  const skip = edge('api', 'data', 'skip-layer', [
    ['src/api/a.ts', 'src/state/store.ts'],
    ['src/api/b.ts', 'src/cache/cache.ts'],
    ['src/api/a.ts', 'src/cache/cache.ts'],
  ]);
  buildTierIntent(root, classified, flowOf([skip]), graphEdges([skip]), assignment(classified));
  assert.equal(skip.intended, true);
  assert.equal(skip.ruleId, undefined);
  assert.deepEqual(skip.allowedRules, ['reads-caches', 'reads-stores']);
});

test('the sample lists unexplained imports first, so its cap never hides them', () => {
  const root = repositoryWithRules(
    'rules:\n  - id: api-reads-stores\n    from: "src/api/**"\n    to: "src/state/**"\n    allow: import\n',
  );
  const pairs: Array<[string, string]> = [
    ['src/api/a.ts', 'src/state/store.ts'],
    ['src/api/a.ts', 'src/state/store.ts'],
    ['src/api/a.ts', 'src/state/store.ts'],
    ['src/api/b.ts', 'src/cache/cache.ts'],
  ];
  const skip = edge('api', 'data', 'skip-layer', pairs);
  const all = graphEdges([skip]);
  // The report keeps a capped sample; here the cap is two and the first two are covered ones.
  skip.imports = skip.imports?.slice(0, 2);
  buildTierIntent(root, classified, flowOf([skip]), all, assignment(classified));
  assert.equal(skip.imports?.length, 2);
  assert.equal(skip.allowedCount, 3);
  assert.ok(skip.imports?.some((entry) => entry.target === 'src/cache/cache.ts' && entry.allowed !== true));
});

test('a rule never excuses an upward import, and a quiet rule draws no intended edge', () => {
  const root = repositoryWithRules(
    [
      'rules:',
      '  - { id: anything, from: "src/state/**", to: "**", allow: import, ghost: false }',
      '  - { id: loud, from: "src/api/**", to: "src/domain/**", allow: import }',
      '',
    ].join('\n'),
  );
  const upward = edge('data', 'api', 'upward', [['src/state/store.ts', 'src/api/a.ts']]);
  const flow = flowOf([upward]);
  const result = buildTierIntent(root, classified, flow, graphEdges([upward]), assignment(classified));
  assert.equal(upward.violation, true, 'an upward edge stays a violation whatever the rules say');
  // The loud rule draws its missing api → domain flow as a ghost; the quiet one draws none.
  assert.deepEqual(
    result.ghostEdges.map((ghost) => ghost.ruleId),
    ['loud'],
  );
});

test('a rule whose two ends share a tier draws no intended flow from that tier to itself', () => {
  const root = repositoryWithRules(
    'rules:\n  - id: api-to-api\n    from: "src/api/a.ts"\n    to: "src/api/**"\n    allow: import\n',
  );
  const result = buildTierIntent(root, classified, flowOf([]), [], assignment(classified));
  assert.deepEqual(result.ghostEdges, []);
});
