import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  blockRegion,
  compressDirectoryChains,
  directoriesOf,
  parentDirectory,
  topLevelDirectory,
  unitAnchoredLabel,
} from '../../src/analysis/directory.ts';

test('topLevelDirectory uses the root marker for a file with no directory', () => {
  assert.equal(topLevelDirectory('src/a.ts'), 'src');
  assert.equal(topLevelDirectory('README.md'), '.');
});

test('blockRegion treats a bare block id as its own directory, not the root', () => {
  assert.equal(blockRegion('.'), '.');
  assert.equal(blockRegion('ui'), 'ui');
  assert.equal(blockRegion('src/api'), 'src');
});

test('parentDirectory and directoriesOf use the root marker', () => {
  assert.equal(parentDirectory('a.ts'), '.');
  assert.equal(parentDirectory('src/api/a.ts'), 'src/api');
  assert.deepEqual(directoriesOf(['src/api/a.ts']), ['.', 'src', 'src/api']);
});

test('unitAnchoredLabel names the unit and its tail', () => {
  assert.equal(unitAnchoredLabel('handlers', 'service'), 'service › handlers');
  assert.equal(unitAnchoredLabel('', 'service'), 'service');
});

test('compressDirectoryChains drops an empty single-child hop and anchors at the unit', () => {
  const directories = ['service-rust', 'service-rust/src', 'service-rust/src/handlers'];
  const content = new Set(['service-rust/src/handlers']);
  const labels = compressDirectoryChains(directories, (directory) => content.has(directory), [
    { id: 'service-rust', name: 'service' },
  ]);

  assert.equal(labels.get('service-rust/src/handlers'), 'service › handlers');
  assert.equal(labels.get('service-rust'), 'service');
});

test('compressDirectoryChains keeps a branching or content-bearing directory', () => {
  const directories = ['src', 'src/api', 'src/lib'];
  const content = new Set(['src/api', 'src/lib']);
  const labels = compressDirectoryChains(directories, (directory) => content.has(directory));

  assert.equal(labels.get('src/api'), 'src/api');
  assert.equal(labels.get('src'), 'src');
});

test('compressDirectoryChains compresses without a unit too', () => {
  const directories = ['service-rust', 'service-rust/src', 'service-rust/src/handlers'];
  const content = new Set(['service-rust/src/handlers']);
  const labels = compressDirectoryChains(directories, (directory) => content.has(directory));
  assert.equal(labels.get('service-rust/src/handlers'), 'service-rust/handlers');
});
