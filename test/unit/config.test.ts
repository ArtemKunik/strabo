import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { configFromEnv, readEnv } from '../../src/index.ts';
import { positionals } from '../../src/config.ts';

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

test('readEnv permits coverage refresh only from the environment or a CLI flag', () => {
  assert.equal(readEnv({}).allowCoverageRefresh, false);
  assert.equal(readEnv({ STRABO_ALLOW_COVERAGE_REFRESH: '1' }).allowCoverageRefresh, true);
  assert.equal(readEnv({}, ['--allow-coverage-refresh']).allowCoverageRefresh, true);
});

test('readEnv keeps the terminal daemon on unless it is explicitly disabled', () => {
  assert.equal(readEnv({}).terminalDaemon, true);
  assert.equal(readEnv({ STRABO_TERMINAL_DAEMON: '1' }).terminalDaemon, true);
  assert.equal(readEnv({ STRABO_TERMINAL_DAEMON: '0' }).terminalDaemon, false);
  assert.equal(readEnv({ STRABO_TERMINAL_DAEMON: 'off' }).terminalDaemon, false);
  assert.equal(readEnv({}, ['--no-terminal-daemon']).terminalDaemon, false);
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

test('readEnv never reads a flag value as the repository path', () => {
  assert.equal(readEnv({}, ['--base', 'main']).root, path.resolve(process.cwd()));
  assert.equal(readEnv({}, ['--host', '0.0.0.0', 'repo']).root, path.resolve('repo'));
  assert.deepEqual(positionals(['--format', 'dot', 'a', '--out=x', '--no-smells', 'b']), ['a', 'b']);
});

test('readEnv takes --port over PORT', () => {
  assert.equal(readEnv({ PORT: '4000' }, ['--port', '4100']).port, 4100);
  assert.equal(readEnv({ PORT: '4000' }).port, 4000);
});

test('the terminal stays local unless remote use is opted into', () => {
  assert.equal(configFromEnv({}).allowRemoteTerminal, false);
  assert.equal(configFromEnv({ STRABO_ALLOW_REMOTE_TERMINAL: '1' }).allowRemoteTerminal, true);
  assert.equal(configFromEnv({}, ['--allow-remote-terminal']).allowRemoteTerminal, true);
});
