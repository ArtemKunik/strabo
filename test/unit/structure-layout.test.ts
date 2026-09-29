import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nodeDiameter } from '../../ui/strabo-graph-sizing.js';
import { packStructureStack, structureEdgeBends, structureStackRank } from '../../ui/strabo-structure-layout.js';

function stackModel(direction: 'vertical' | 'horizontal') {
  const along = (index: number) => (direction === 'horizontal' ? { x: index * 260, y: 0 } : { x: 0, y: index * 170 });
  return {
    structure: true,
    structureDirection: direction,
    nodes: [
      { id: 'frontend', kind: 'tier', files: 110 },
      { id: 'api', kind: 'tier', files: 1 },
      { id: 'domain', kind: 'tier', files: 144 },
      { id: 'tests', kind: 'shelf', files: 155 },
      { id: 'build', kind: 'shelf', files: 10 },
    ],
    positions: [
      { id: 'frontend', ...along(0) },
      { id: 'api', ...along(1) },
      { id: 'domain', ...along(2) },
      { id: 'tests', x: 460, y: 0 },
      { id: 'build', x: 460, y: 150 },
    ],
    edges: [
      { source: 'api', target: 'domain' },
      { source: 'domain', target: 'api' },
      { source: 'frontend', target: 'domain' },
      { source: 'frontend', target: 'api' },
    ],
  };
}

test('packStructureStack leaves the same clear gap between every pair of stack cards', () => {
  for (const direction of ['vertical', 'horizontal'] as const) {
    const model = stackModel(direction);
    const axis = direction === 'horizontal' ? 'x' : 'y';
    const packed = packStructureStack(model);
    const at = new Map(packed.positions.map((p: { id: string; x: number; y: number }) => [p.id, p]));
    const radius = (id: string) => nodeDiameter(model.nodes.find((n) => n.id === id)) / 2;
    const gap = (a: string, b: string) => at.get(b)[axis] - radius(b) - (at.get(a)[axis] + radius(a));
    assert.equal(at.get('frontend')[axis], 0);
    assert.equal(gap('frontend', 'api'), gap('api', 'domain'));
    // Packing is stable: a packed model packs to itself.
    assert.deepEqual(packStructureStack(packed).positions, packed.positions);
  }
});

test('packStructureStack leaves a grid or file model untouched', () => {
  const grid = { structure: true, structureLevel: 'grid', nodes: [], positions: [] };
  assert.equal(packStructureStack(grid), grid);
});

test('structureEdgeBends splits a two-way pair and arcs a skip-layer edge around the band it jumps', () => {
  const model = stackModel('vertical');
  const bends = structureEdgeBends(model, structureStackRank(model));
  const [apiDomain, domainApi, skip, adjacent] = bends;
  assert.ok(apiDomain > 0);
  // Same signed distance on opposite directions: the two arcs bow to opposite sides.
  assert.equal(apiDomain, domainApi);
  assert.ok(skip > apiDomain);
  assert.equal(adjacent, 0);
});
