import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { configFromEnv, readEnv } from '../../src/index.ts';

test('readEnv falls back to the working directory when no root is given', () => {
  const env = readEnv({});

  assert.equal(env.root, path.resolve(process.cwd()));
  assert.equal(env.scanCeiling, env.root);
  assert.equal(env.port, 3000);
});

test('readEnv resolves STRABO_ROOT relative to the working directory', () => {
  const env = readEnv({ STRABO_ROOT: '.' });

  assert.equal(env.root, path.resolve('.'));
});

test('readEnv prefers a path argument over STRABO_ROOT', () => {
  const env = readEnv({ STRABO_ROOT: 'from-env' }, ['from-argv']);

  assert.equal(env.root, path.resolve('from-argv'));
});

test('readEnv ignores flags when looking for the path argument', () => {
  const env = readEnv({ STRABO_ROOT: 'from-env' }, ['--help']);

  assert.equal(env.root, path.resolve('from-env'));
});

test('readEnv binds loopback unless STRABO_HOST or --host says otherwise', () => {
  assert.equal(readEnv({}).host, '127.0.0.1');
  assert.equal(readEnv({ STRABO_HOST: '0.0.0.0' }).host, '0.0.0.0');
  assert.equal(readEnv({}, ['--host', '0.0.0.0']).host, '0.0.0.0');
  assert.equal(readEnv({}, ['--host=0.0.0.0']).host, '0.0.0.0');
  // A flag without a value leaves the default in force rather than binding nothing.
  assert.equal(readEnv({}, ['--host']).host, '127.0.0.1');
});

test('readEnv enables widening only from the environment or a CLI flag, never a request', () => {
  assert.equal(readEnv({}).allowCeilingWidening, false);
  assert.equal(readEnv({ STRABO_ALLOW_CEILING_WIDENING: '1' }).allowCeilingWidening, true);
  assert.equal(readEnv({}, ['--allow-ceiling-widening']).allowCeilingWidening, true);
});

test('readEnv ignores the host arguments unless they are passed in', () => {
  const env = readEnv({ STRABO_ROOT: 'from-env' });

  assert.equal(env.root, path.resolve('from-env'));
});

test('readEnv keeps STRABO_SCAN_CEILING independent of the root', () => {
  const env = readEnv({ STRABO_ROOT: 'repo', STRABO_SCAN_CEILING: '.' });

  assert.equal(env.root, path.resolve('repo'));
  assert.equal(env.scanCeiling, path.resolve('.'));
});

test('configFromEnv threads the path argument through to the workspace root', () => {
  const config = configFromEnv({}, ['from-argv']);

  assert.equal(config.workspaceRoot, path.resolve('from-argv'));
  assert.equal(config.scanCeiling, path.resolve('from-argv'));
});
