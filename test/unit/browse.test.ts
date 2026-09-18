import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { browseDirectories } from '../../src/boundary/browse.ts';
import { StraboScopeError } from '../../src/boundary/repository-root.ts';

const ceiling = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-browse-'));
fs.mkdirSync(path.join(ceiling, 'alpha'));
fs.writeFileSync(path.join(ceiling, 'alpha', 'package.json'), '{}');
fs.mkdirSync(path.join(ceiling, 'beta'));
fs.mkdirSync(path.join(ceiling, 'beta', 'nested'));
fs.mkdirSync(path.join(ceiling, '.git'));

after(() => {
  fs.rmSync(ceiling, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('browseDirectories lists subdirectories and flags repositories', () => {
  const result = browseDirectories({ ceiling });

  assert.equal(result.path, ceiling);
  assert.equal(result.ceiling, ceiling);
  assert.deepEqual(
    result.directories.map((entry) => [entry.name, entry.isRepository]),
    [
      ['alpha', true],
      ['beta', false],
    ],
  );
});

test('browseDirectories hides .git and reports a parent inside the ceiling', () => {
  const result = browseDirectories({ ceiling, requested: path.join(ceiling, 'beta') });

  assert.equal(result.parent, ceiling);
  assert.deepEqual(result.directories.map((entry) => entry.name), ['nested']);
});

test('the ceiling itself has no parent, so the dialog cannot escape upward', () => {
  assert.equal(browseDirectories({ ceiling }).parent, null);
});

test('browseDirectories rejects a path outside the ceiling', () => {
  assert.throws(
    () => browseDirectories({ ceiling, requested: path.dirname(ceiling) }),
    StraboScopeError,
  );
});

test('browseDirectories rejects a missing directory', () => {
  assert.throws(
    () => browseDirectories({ ceiling, requested: path.join(ceiling, 'nope') }),
    StraboScopeError,
  );
});
