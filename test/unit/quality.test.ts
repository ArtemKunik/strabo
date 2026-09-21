import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { computeQualityScorecard, smellsFromScorecard } from '../../src/index.ts';

const created: string[] = [];
after(() => {
  for (const dir of created) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-quality-'));
  created.push(dir);
  return dir;
}

function write(root: string, relative: string, content: string): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function makeGraph(root: string, files: string[], edges: { source: string; target: string; kind: string; evidence: { line: number; specifier: string; resolution: string } }[]): { graph: ReturnType<typeof import('../../src/types.ts').Graph>; root: string } {
  const nodes = files.map((id) => ({ id, kind: 'module' as const, directory: '.' }));
  return {
    graph: { nodes, edges, diagnostics: [], excluded: [] },
    root,
  };
}

test('computeQualityScorecard returns percentiles for all measures', async () => {
  const root = tempDir();
  write(root, 'a.ts', 'export const a = 1;\n');
  write(root, 'b.ts', 'import { a } from "./a";\nexport const b = 2;\n');
  write(root, 'c.ts', 'import { a } from "./a";\n');

  const { graph, root: r } = makeGraph(root, ['a.ts', 'b.ts', 'c.ts'], [
    { source: 'b.ts', target: 'a.ts', kind: 'import', evidence: { line: 1, specifier: './a', resolution: 'exact' } },
    { source: 'c.ts', target: 'a.ts', kind: 'import', evidence: { line: 2, specifier: './a', resolution: 'exact' } },
  ]);

  const scorecard = await computeQualityScorecard(graph, r, 'demo');

  assert.equal(scorecard.repository, 'demo');
  assert.equal(scorecard.modules.length, 3);
  assert.ok(scorecard.percentiles.complexity);
  assert.ok(scorecard.percentiles.shape);
  assert.ok(scorecard.percentiles.centrality);
  assert.ok(scorecard.percentiles.evolution);
  assert.ok(scorecard.percentiles.protection);
});

test('percentiles are 100 when all modules have identical measures', async () => {
  const root = tempDir();
  write(root, 'a.ts', 'export const a = 1;\n');
  write(root, 'b.ts', 'export const b = 2;\n');

  const { graph, root: r } = makeGraph(root, ['a.ts', 'b.ts'], []);

  const scorecard = await computeQualityScorecard(graph, r, 'demo');

  for (const group of ['complexity', 'shape', 'centrality', 'evolution', 'protection'] as const) {
    for (const key of Object.keys(scorecard.percentiles[group])) {
      const p = (scorecard.percentiles[group] as Record<string, { percentile: number }>)[key];
      assert.equal(p.percentile, 100);
    }
  }
});

test('computeQualityScorecard handles modules with no symbol extractor', async () => {
  const root = tempDir();
  write(root, 'a.md', '# Hello\n');

  const { graph, root: r } = makeGraph(root, ['a.md'], []);

  const scorecard = await computeQualityScorecard(graph, r, 'demo');
  const mod = scorecard.modules[0];

  assert.equal(mod.complexity.loc, 0);
  assert.equal(mod.complexity.functionCount, 0);
  assert.equal(mod.shape.interfaceWidth, 0);
  assert.equal(mod.shape.memberCount, 0);
});

test('composite scores stay in 0-100 and follow the measures', async () => {
  const root = tempDir();
  write(root, 'a.ts', 'export const a = 1;\n');
  write(root, 'b.ts', 'import { a } from "./a";\n');
  write(root, 'c.ts', 'import { a } from "./a";\n');

  const { graph, root: r } = makeGraph(root, ['a.ts', 'b.ts', 'c.ts'], [
    { source: 'b.ts', target: 'a.ts', kind: 'import', evidence: { line: 1, specifier: './a', resolution: 'exact' } },
    { source: 'c.ts', target: 'a.ts', kind: 'import', evidence: { line: 2, specifier: './a', resolution: 'exact' } },
  ]);

  const scorecard = await computeQualityScorecard(graph, r, 'demo');
  for (const module of scorecard.modules) {
    for (const key of ['complexity', 'churn', 'hotspot', 'blastRadius', 'testReach', 'risk'] as const) {
      const value = module.scores[key];
      assert.ok(value >= 0 && value <= 100, `${key} should be 0-100, got ${value}`);
    }
  }
  const a = scorecard.modules.find((m) => m.file === 'a.ts');
  const b = scorecard.modules.find((m) => m.file === 'b.ts');
  assert.equal(a?.scores.blastRadius, 100, 'a.ts is depended on, so its blast radius ranks highest');
  assert.equal(b?.scores.blastRadius, 0);
});

test('risk is zero when a test reaches the module', async () => {
  const root = tempDir();
  write(root, 'a.ts', 'export const a = 1;\n');
  write(root, 't.test.ts', 'import { a } from "./a";\n');

  const nodes = [
    { id: 'a.ts', kind: 'module' as const, directory: '.' },
    { id: 't.test.ts', kind: 'test' as const, directory: '.' },
  ];
  const graph = {
    nodes,
    edges: [
      { source: 't.test.ts', target: 'a.ts', kind: 'import' as const, evidence: { line: 1, specifier: './a', resolution: 'exact' as const } },
    ],
    diagnostics: [],
    excluded: [],
  };

  const scorecard = await computeQualityScorecard(graph, root, 'demo');
  const a = scorecard.modules.find((m) => m.file === 'a.ts');
  assert.equal(a?.protection.testReach, true);
  assert.equal(a?.scores.testReach, 100);
  assert.equal(a?.scores.risk, 0, 'a reached module carries no untested risk');
});

test('smells fire with their tripping inputs, and roll up per rule', async () => {
  const root = tempDir();
  write(root, 'a.ts', "import { b } from './b';\nexport const a = b;\n");
  write(root, 'b.ts', "import { a } from './a';\nexport const b = a;\n");
  write(root, 'c.ts', 'export const c = 3;\n');
  write(root, 'd.ts', "import React from 'react';\nimport express from 'express';\nexport const d = React.name;\n");

  const { graph, root: r } = makeGraph(root, ['a.ts', 'b.ts', 'c.ts', 'd.ts'], [
    { source: 'a.ts', target: 'b.ts', kind: 'import', evidence: { line: 1, specifier: './b', resolution: 'exact' } },
    { source: 'b.ts', target: 'a.ts', kind: 'import', evidence: { line: 1, specifier: './a', resolution: 'exact' } },
  ]);

  const scorecard = await computeQualityScorecard(graph, r, 'demo');
  const byFile = new Map(scorecard.modules.map((m) => [m.file, m]));

  assert.ok(byFile.get('a.ts')?.smells.some((s) => s.rule === 'cyclic'), 'a.ts is in a cycle');
  assert.ok(byFile.get('c.ts')?.smells.some((s) => s.rule === 'dead'), 'c.ts is imported by nobody');
  const leak = byFile.get('d.ts')?.smells.find((s) => s.rule === 'tier-leak');
  assert.ok(leak, 'd.ts imports a frontend and an api framework at equal strength');
  assert.equal(leak?.inputs.mixed, true);

  const report = smellsFromScorecard(scorecard);
  assert.equal(report.repository, 'demo');
  assert.ok(report.summary.cyclic >= 2, 'both ends of the cycle are flagged');
  assert.ok(report.summary.dead >= 1);
  assert.ok(report.files.some((entry) => entry.file === 'c.ts'));
});

test('centrality measures are computed from the graph', async () => {
  const root = tempDir();
  write(root, 'a.ts', 'export const a = 1;\n');
  write(root, 'b.ts', 'import { a } from "./a";\n');
  write(root, 'c.ts', 'import { a } from "./a";\n');

  const { graph, root: r } = makeGraph(root, ['a.ts', 'b.ts', 'c.ts'], [
    { source: 'b.ts', target: 'a.ts', kind: 'import', evidence: { line: 1, specifier: './a', resolution: 'exact' } },
    { source: 'c.ts', target: 'a.ts', kind: 'import', evidence: { line: 2, specifier: './a', resolution: 'exact' } },
  ]);

  const scorecard = await computeQualityScorecard(graph, r, 'demo');
  const aMod = scorecard.modules.find((m) => m.file === 'a.ts');
  const bMod = scorecard.modules.find((m) => m.file === 'b.ts');

  assert.equal(aMod?.centrality.directImporters, 2);
  assert.equal(bMod?.centrality.directImporters, 0);
});
