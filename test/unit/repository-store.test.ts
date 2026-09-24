import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  createRepositoryStore,
  knownRepositoriesInside,
  repositoryStorePath,
} from '../../src/state/repository-store.ts';

function tempFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-store-'));
  return path.join(directory, 'repositories.json');
}

test('remember adds a repository and makes the most recent active', () => {
  const file = tempFile();
  // A ticking clock: two calls inside one millisecond would tie on the wall clock and fall
  // back to name order, which made this test flaky on fast CI runners.
  let tick = 0;
  const store = createRepositoryStore({
    file,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });

  assert.deepEqual(store.list(), []);
  store.remember('/repos/alpha');
  store.remember('/repos/beta');

  const list = store.list();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((entry) => entry.name), ['beta', 'alpha']);
  assert.equal(list[0].root, path.resolve('/repos/beta'));
});

test('remember is idempotent and touches lastOpenedAt', () => {
  const file = tempFile();
  let tick = 0;
  const store = createRepositoryStore({
    file,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });

  store.remember('/repos/alpha');
  const first = store.get('/repos/alpha');
  store.remember('/repos/beta');
  store.remember('/repos/alpha');

  const list = store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'alpha', 'the most recently opened repository sorts first');
  assert.notEqual(store.get('/repos/alpha')?.lastOpenedAt, first?.lastOpenedAt);
});

test('active tracks the last selected repository and survives a reload', () => {
  const file = tempFile();
  const store = createRepositoryStore({ file });
  store.remember('/repos/alpha');
  store.setActive('/repos/alpha');

  const reloaded = createRepositoryStore({ file });
  assert.equal(reloaded.active(), path.resolve('/repos/alpha'));
});

test('forget removes an entry and clears active when it pointed there', () => {
  const file = tempFile();
  const store = createRepositoryStore({ file });
  store.remember('/repos/alpha');
  store.remember('/repos/beta');
  store.setActive('/repos/beta');

  assert.equal(store.forget('/repos/beta'), true);
  assert.equal(store.get('/repos/beta'), null);
  assert.equal(store.active(), path.resolve('/repos/alpha'));

  assert.equal(store.forget('/repos/missing'), false);
});

test('a corrupt store file is treated as empty rather than failing', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ not json');
  const store = createRepositoryStore({ file });

  assert.deepEqual(store.list(), []);
  assert.equal(store.active(), null);
  store.remember('/repos/alpha');
  assert.equal(store.list().length, 1);
});

test('knownRepositoriesInside filters entries outside the scan ceiling', () => {
  const file = tempFile();
  const store = createRepositoryStore({ file });
  store.remember('/ceiling/inside');
  store.remember('/elsewhere/outside');

  const inside = knownRepositoriesInside(store, '/ceiling');
  assert.deepEqual(inside.map((entry) => entry.name), ['inside']);
});

test('repositoryStorePath honours STRABO_STATE_DIR', () => {
  const previous = process.env.STRABO_STATE_DIR;
  process.env.STRABO_STATE_DIR = path.join(os.tmpdir(), 'strabo-state-probe');
  try {
    assert.equal(
      repositoryStorePath(),
      path.join(path.resolve(process.env.STRABO_STATE_DIR), 'strabo-repositories.json'),
    );
  } finally {
    if (previous === undefined) {
      delete process.env.STRABO_STATE_DIR;
    } else {
      process.env.STRABO_STATE_DIR = previous;
    }
  }
});
