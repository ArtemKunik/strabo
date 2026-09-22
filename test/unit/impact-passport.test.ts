import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildAdjacency,
  buildFileImpactPassport,
  computeFileImpactPassport,
  computeGraphMetrics,
  computeRisk,
  fingerprint,
  functionFacts,
  riskBandFor,
  rollUpImpactPassports,
  scanRepository,
  symbolExtractorFor,
} from '../../src/index.ts';
import type { FileImpactPassport, Graph } from '../../src/index.ts';
import { snapshotFor } from '../../src/analysis/impact-passport.ts';
import { graphProvenance } from '../../src/api/routes/analysis.ts';

const fixturesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/**
 * The passport records `blastRadius` as the transitive dependents over the same adjacency
 * it counts `directImporters` from, so the former can never be the smaller of the two.
 * Assert that for every node, not a hand-picked one.
 */
function assertBlastRadiusCoversImporters(graph: Graph, label: string): void {
  const { forward, backward } = buildAdjacency(graph, { includeReExports: true });
  const { transitiveDependents } = computeGraphMetrics(graph, { forward, backward });
  for (const node of graph.nodes) {
    const snapshot = snapshotFor(node.id, forward, backward, transitiveDependents);
    assert.ok(
      snapshot.blastRadius >= snapshot.directImporters,
      `${label}: ${node.id} records blastRadius ${snapshot.blastRadius} but directImporters ${snapshot.directImporters}`,
    );
  }
}

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-impact-'));
  created.push(directory);
  return directory;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
}

function initRepo(root: string): void {
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Tester');
}

async function factsFor(file: string, content: string) {
  const extractor = symbolExtractorFor(file);
  assert.ok(extractor, `expected an extractor for ${file}`);
  const result = await extractor.extract(file, content);
  return functionFacts(file, result.symbols, result.calls ?? []);
}

test('riskBandFor maps a score to a coarse band', () => {
  assert.equal(riskBandFor(100), 'critical');
  assert.equal(riskBandFor(85), 'critical');
  assert.equal(riskBandFor(84), 'high');
  assert.equal(riskBandFor(60), 'high');
  assert.equal(riskBandFor(59), 'moderate');
  assert.equal(riskBandFor(30), 'moderate');
  assert.equal(riskBandFor(29), 'low');
  assert.equal(riskBandFor(0), 'low');
});

test('computeRisk is bounded and keeps its inputs', () => {
  const extreme = computeRisk({ maxComplexity: 400, blastRadius: 500, signals: 50, untestedShare: 4, directImporters: 9 });
  assert.equal(extreme.score, 100);
  assert.equal(extreme.band, 'critical');
  assert.equal(extreme.inputs.maxComplexity, 400);

  const empty = computeRisk({ maxComplexity: 0, blastRadius: 0, signals: 0, untestedShare: 0, directImporters: 0 });
  assert.equal(empty.score, 0);
  assert.equal(empty.band, 'low');

  const partial = computeRisk({ maxComplexity: 20, blastRadius: 25, signals: 0, untestedShare: 0.5, directImporters: 4 });
  assert.ok(partial.score > 0 && partial.score < 100);
});

test('functionFacts records max, sum, average, and types from the parse tree', async () => {
  const facts = await factsFor(
    'a.ts',
    [
      'export class Store {',
      '  private value = 0;',
      '  read(): number { return this.value; }',
      '}',
      'export function simple(): number { return 1; }',
      'export function branchy(x: number): number {',
      '  if (x > 0) { return 1; }',
      '  if (x < 0) { return -1; }',
      '  return 0;',
      '}',
    ].join('\n'),
  );
  assert.equal(facts.maxComplexity, 3);
  assert.equal(facts.sumComplexity, 5);
  assert.equal(facts.measuredCount, 3);
  assert.equal(facts.count, 3);
  assert.ok(facts.types.some((type) => type.name === 'Store' && type.memberCount >= 2));
});

test('buildFileImpactPassport concentrates coherence on connected changed symbols', async () => {
  const connected = await factsFor(
    'a.ts',
    ['export function a(): number { return b(); }', 'export function b(): number { return 1; }'].join('\n'),
  );
  const snapshot = { blastRadius: 0, directImporters: 0, directImports: 0 };
  const card = buildFileImpactPassport({
    path: 'a.ts',
    status: 'modified',
    snapshot,
    before: null,
    after: connected,
    changedFunctions: [
      { owner: 'a', name: 'a' },
      { owner: 'a', name: 'b' },
    ],
    changedTypes: [],
    impact: null,
    testsToRun: [],
    untestedDependents: [],
  });
  assert.ok(card.coherence);
  assert.equal(card.coherence.changedSymbols, 2);
  assert.equal(card.coherence.score, 100, 'a calls b, so the two changed symbols form one component');

  const disconnected = await factsFor(
    'a.ts',
    ['export function a(): number { return 1; }', 'export function b(): number { return 2; }'].join('\n'),
  );
  const split = buildFileImpactPassport({
    path: 'a.ts',
    status: 'modified',
    snapshot,
    before: null,
    after: disconnected,
    changedFunctions: [
      { owner: 'a', name: 'a' },
      { owner: 'a', name: 'b' },
    ],
    changedTypes: [],
    impact: null,
    testsToRun: [],
    untestedDependents: [],
  });
  assert.ok(split.coherence);
  assert.equal(split.coherence.score, 50, 'two unrelated changed functions are two components');

  const single = buildFileImpactPassport({
    path: 'a.ts',
    status: 'modified',
    snapshot,
    before: null,
    after: disconnected,
    changedFunctions: [{ owner: 'a', name: 'a' }],
    changedTypes: [],
    impact: null,
    testsToRun: [],
    untestedDependents: [],
  });
  assert.ok(single.coherence);
  assert.equal(single.coherence.score, 100);
});

test('buildFileImpactPassport counts unchanged functions and classes across sides', async () => {
  const before = await factsFor(
    'a.ts',
    [
      'export class Store { private value = 0; read(): number { return this.value; } }',
      'export function stable(): number { return 1; }',
      'export function moving(): number { return 2; }',
    ].join('\n'),
  );
  const after = await factsFor(
    'a.ts',
    [
      'export class Store { private value = 0; read(): number { return this.value; } }',
      'export function stable(): number { return 1; }',
      'export function moving(x: number): number { if (x > 0) { return 1; } return 2; }',
    ].join('\n'),
  );
  const card = buildFileImpactPassport({
    path: 'a.ts',
    status: 'modified',
    snapshot: { blastRadius: 3, directImporters: 2, directImports: 1 },
    before,
    after,
    changedFunctions: [{ owner: '', name: 'moving' }],
    changedTypes: [],
    impact: null,
    testsToRun: [],
    untestedDependents: ['caller.ts'],
  });
  assert.equal(card.complexity.functionsUnchanged, 2);
  assert.equal(card.complexity.classesUnchanged, 1);
  assert.equal(card.snapshot.blastRadius, 3);
  assert.equal(card.snapshot.directImporters, 2);
  assert.equal(card.risk?.inputs.untestedShare, 0.5);
});

test('rollUpImpactPassports unions blast radius and imports over the drawn graph', () => {
  const graph: Graph = {
    nodes: [
      { id: 'a.ts', kind: 'module', directory: '.' },
      { id: 'b.ts', kind: 'module', directory: '.' },
      { id: 'c.ts', kind: 'module', directory: '.' },
    ],
    edges: [
      { source: 'b.ts', target: 'a.ts', kind: 'import', evidence: { line: 1, specifier: './a', resolution: 'exact' } },
      { source: 'c.ts', target: 'b.ts', kind: 'import', evidence: { line: 1, specifier: './b', resolution: 'exact' } },
    ],
    diagnostics: [],
    excluded: [],
  };
  const card: FileImpactPassport = {
    path: 'a.ts',
    status: 'modified',
    risk: { score: 40, band: 'moderate', inputs: { maxComplexity: 10, blastRadius: 2, signals: 1, untestedShare: 0, directImporters: 1 } },
    complexity: {
      maxBefore: 5,
      maxAfter: 10,
      averageBefore: 3,
      averageAfter: 4,
      sumBefore: 5,
      sumAfter: 10,
      functionCountBefore: 1,
      functionCountAfter: 2,
      functionsUnchanged: 1,
      classesUnchanged: 0,
    },
    coherence: { score: 100, changedSymbols: 1, detail: '1 changed symbol(s); concentration heuristic' },
    snapshot: { blastRadius: 2, directImporters: 1, directImports: 0 },
    signals: [{ kind: 'high-complexity', label: 'High complexity logic', detail: 'maximum C10' }],
    mostComplex: [{ name: 'a', owner: '', complexity: 10, before: 5, delta: 5 }],
    impact: null,
    testsToRun: [],
    untestedDependents: [],
  };

  const set = rollUpImpactPassports(graph, [card], 'change-set', 'HEAD', false);
  assert.equal(set.scope, 'change-set');
  assert.equal(set.baseline, 'HEAD');
  assert.equal(set.totals.files, 1);
  assert.equal(set.totals.risk?.score, 40);
  assert.equal(set.totals.blastRadius, 2, 'b and c are reachable from a over use edges');
  assert.equal(set.totals.directImporters, 1);
  assert.equal(set.totals.maxComplexity, 10);
  assert.equal(set.totals.mostComplex[0]?.name, 'a');
});

test('computeFileImpactPassport reports the current snapshot against HEAD', async () => {
  const root = tempDir();
  const file = path.join(root, 'src/store.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ['export function save(x: number): number {', '  if (x > 0) { return x; }', '  return 0;', '}'].join('\n'));
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'baseline');

  fs.writeFileSync(
    file,
    ['export function save(x: number): number {', '  if (x > 0) { return x; }', '  if (x < 0) { return -x; }', '  return 0;', '}'].join('\n'),
  );

  const report = await scanRepository(root);
  const card = await computeFileImpactPassport(root, report.graph, 'src/store.ts');
  assert.equal(card.path, 'src/store.ts');
  assert.equal(card.complexity.maxBefore, 2);
  assert.equal(card.complexity.maxAfter, 3);
  assert.ok(card.risk && card.risk.score > 0);
  assert.equal(card.mostComplex[0]?.name, 'save');
  assert.equal(card.mostComplex[0]?.delta, 1);
  assert.ok(card.coherence && card.coherence.changedSymbols >= 1);
});

test('graphProvenance carries fingerprint, scan time, and a working-tree staleness check', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  initRepo(root);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'baseline');

  const report = await scanRepository(root);
  const indexed = await fingerprint(root);
  const fresh = await graphProvenance(root, { fingerprint: indexed, report });
  assert.equal(fresh.fingerprint, indexed);
  assert.equal(fresh.revision, indexed?.split(':')[0] ?? null);
  assert.equal(fresh.scannedAt, report.scannedAt);
  assert.equal(fresh.currentFingerprint, indexed);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.behind, 0);

  // An edit after the scan makes the same served graph older than the working tree.
  fs.appendFileSync(path.join(root, 'a.ts'), '// edit\n');
  const stale = await graphProvenance(root, { fingerprint: indexed, report });
  assert.equal(stale.stale, true, 'the served graph is older than the working tree');
  assert.notEqual(stale.currentFingerprint, indexed);
});

test('blast radius covers direct importers for every node of every fixture', async () => {
  const names = fs
    .readdirSync(fixturesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(names.length > 0, 'the shared fixture directory holds repositories to scan');
  for (const name of names) {
    const report = await scanRepository(path.join(fixturesRoot, name));
    assertBlastRadiusCoversImporters(report.graph, name);
  }

  // The hand-built graphs the passport tests draw, including a re-export barrel: impact
  // traversal follows it, so the barrel and its importer both fall inside the blast radius.
  const inline: Graph = {
    nodes: [
      { id: 'a.ts', kind: 'module', directory: '.' },
      { id: 'index.ts', kind: 'module', directory: '.' },
      { id: 'b.ts', kind: 'module', directory: '.' },
    ],
    edges: [
      { source: 'a.ts', target: 'index.ts', kind: 'import', evidence: { line: 1, specifier: './index', resolution: 'exact' } },
      { source: 'index.ts', target: 'b.ts', kind: 're-export', role: 'declare', evidence: { line: 1, specifier: './b', resolution: 'exact' } },
    ],
    diagnostics: [],
    excluded: [],
  };
  assertBlastRadiusCoversImporters(inline, 'inline re-export graph');
});
