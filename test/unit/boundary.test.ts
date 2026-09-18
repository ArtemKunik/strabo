import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertReadable,
  isInside,
  resolveRepositoryRoot,
  StraboScopeError,
} from '../../src/boundary/repository-root.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'sample-repo');

test('resolveRepositoryRoot accepts a path inside the scan ceiling', () => {
  const resolved = resolveRepositoryRoot({
    workspaceRoot: fixture,
    scanCeiling: fixture,
    requested: fixture,
  });
  assert.equal(resolved.name, 'sample-repo');
  assert.equal(resolved.root, fixture);
  assert.equal(resolved.workspaceRoot, '.');
});

test('resolveRepositoryRoot rejects a path outside the scan ceiling', () => {
  assert.throws(
    () =>
      resolveRepositoryRoot({
        workspaceRoot: fixture,
        scanCeiling: fixture,
        requested: path.resolve(fixture, '..'),
      }),
    StraboScopeError,
  );
});

test('isInside uses path-relative containment, not prefix matching', () => {
  assert.equal(isInside(path.join(fixture, 'src'), fixture), true);
  assert.equal(isInside(`${fixture}-sibling`, fixture), false);
  assert.equal(isInside('..', fixture), false);
});

test('assertReadable rejects traversal outside the repository root', () => {
  assert.throws(() => assertReadable(fixture, '../secrets.txt'), StraboScopeError);
  assert.equal(assertReadable(fixture, 'src/util.ts'), path.join(fixture, 'src', 'util.ts'));
});
