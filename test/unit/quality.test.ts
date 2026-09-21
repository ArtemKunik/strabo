import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { computeQualityScorecard } from '../../src/index.ts';

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
