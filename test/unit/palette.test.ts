import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PALETTE_SIZE,
  assignPaletteIndexes,
  blockRegion,
  topLevelDirectory,
} from '../../src/analysis/palette.ts';

test('assignPaletteIndexes gives every top-level directory its own rank, sorted for stability', () => {
  const indexes = assignPaletteIndexes(
    new Map([
      ['src/a.ts', 'src'],
      ['ui/b.ts', 'ui'],
      ['test/c.ts', 'test'],
      ['src/d.ts', 'src'],
    ]),
  );

  assert.equal(indexes.get('src/a.ts'), indexes.get('src/d.ts'));
  assert.notEqual(indexes.get('src/a.ts'), indexes.get('ui/b.ts'));
  assert.deepEqual([...indexes.keys()], ['src/a.ts', 'ui/b.ts', 'test/c.ts', 'src/d.ts']);
  // Sorted region order: src=0, test=1, ui=2.
  assert.equal(indexes.get('src/a.ts'), 0);
  assert.equal(indexes.get('test/c.ts'), 1);
  assert.equal(indexes.get('ui/b.ts'), 2);
});

test('assignPaletteIndexes wraps the palette once the regions outnumber the colours', () => {
  const indexes = assignPaletteIndexes(
    new Map(Array.from({ length: PALETTE_SIZE + 1 }, (_, i) => [`f${i}.ts`, `dir${i}`])),
  );

  assert.equal(indexes.get('f0.ts'), 0);
  assert.equal(indexes.get(`f${PALETTE_SIZE}.ts`), 0);
});

test('topLevelDirectory uses the root marker for a file with no directory', () => {
  assert.equal(topLevelDirectory('src/a.ts'), 'src');
  assert.equal(topLevelDirectory('README.md'), '.');
});

test('blockRegion treats a bare block id as its own directory, not the root', () => {
  assert.equal(blockRegion('.'), '.');
  assert.equal(blockRegion('ui'), 'ui');
  assert.equal(blockRegion('src/api'), 'src');
});
