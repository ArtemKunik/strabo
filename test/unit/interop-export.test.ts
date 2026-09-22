import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exportGraph, renderViewModelSvg } from '../../src/index.ts';
import type { ViewModel } from '../../src/index.ts';
import { tinyGraph } from './support/interop.ts';

test('exportGraph json is deterministic and drops declare edges by default', () => {
  const body = exportGraph(tinyGraph(), {
    format: 'json',
    fingerprint: 'abc1234:deadbeef',
    revision: 'abc1234',
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
  const parsed = JSON.parse(body) as {
    version: string;
    nodes: Array<{ id: string }>;
    edges: unknown[];
    revision: string;
    fingerprint: string;
  };
  assert.equal(parsed.version, 'strabo-export-1');
  assert.deepEqual(parsed.nodes.map((node) => node.id), ['src/a.ts', 'src/b.ts']);
  assert.equal(parsed.edges.length, 1);
  assert.equal(parsed.revision, 'abc1234');
  assert.equal(parsed.fingerprint, 'abc1234:deadbeef');
});

test('exportGraph includeDeclare draws declare edges and marks them dashed', () => {
  const graph = tinyGraph();
  const dot = exportGraph(graph, { format: 'dot', includeDeclare: true });
  assert.match(dot, /"src\/a\.ts" -> "src\/b\.ts"/);
  assert.match(dot, /"src\/b\.ts" -> "src\/a\.ts" \[style=dashed\]/);

  const mermaid = exportGraph(graph, { format: 'mermaid', includeDeclare: true });
  assert.match(mermaid, /graph TD/);
  assert.match(mermaid, /"src\/b\.ts" -\.-> "src\/a\.ts"/);

  const without = exportGraph(graph, { format: 'mermaid' });
  assert.doesNotMatch(without, /-\.->/);
});

test('renderViewModelSvg embeds labels, a legend, and a fingerprint caption', () => {
  const model: ViewModel = {
    repository: { name: 'demo', root: '/demo', head: null, dirty: false, gitUrl: null },
    nodes: [
      {
        id: 'src/a.ts',
        kind: 'module',
        directory: 'src',
        label: 'a.ts',
        workspacePath: 'demo/src/a.ts',
        fanIn: 0,
        fanOut: 1,
        transitiveDependencies: 1,
        transitiveDependents: 0,
      },
      {
        id: 'src/b.ts',
        kind: 'module',
        directory: 'src',
        label: 'b.ts',
        workspacePath: 'demo/src/b.ts',
        fanIn: 1,
        fanOut: 0,
        transitiveDependencies: 0,
        transitiveDependents: 1,
      },
    ],
    edges: [
      {
        source: 'src/a.ts',
        target: 'src/b.ts',
        kind: 'import',
        evidence: { line: 1, specifier: './b', resolution: 'exact' },
        semanticSource: 'src/a.ts',
        semanticTarget: 'src/b.ts',
      },
    ],
    positions: [
      { id: 'src/a.ts', x: 0, y: 0 },
      { id: 'src/b.ts', x: 100, y: 0 },
    ],
    hubs: [],
    diagnostics: [],
    excluded: [],
    cache: {
      status: 'memory',
      fingerprint: 'abc1234:deadbeef',
      artifactVersion: 'v',
      generatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  const svg = renderViewModelSvg(model, { title: 'demo', generatedAt: '2026-01-01T00:00:00.000Z' });
  assert.match(svg, /^<svg/);
  assert.match(svg, /a\.ts/);
  assert.match(svg, /indexed at abc1234/);
  assert.match(svg, /module/);
});
