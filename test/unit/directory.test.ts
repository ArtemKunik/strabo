import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blockRegion, topLevelDirectory } from '../../src/analysis/directory.ts';

test('topLevelDirectory uses the root marker for a file with no directory', () => {
  assert.equal(topLevelDirectory('src/a.ts'), 'src');
  assert.equal(topLevelDirectory('README.md'), '.');
});

test('blockRegion treats a bare block id as its own directory, not the root', () => {
  assert.equal(blockRegion('.'), '.');
  assert.equal(blockRegion('ui'), 'ui');
  assert.equal(blockRegion('src/api'), 'src');
});
