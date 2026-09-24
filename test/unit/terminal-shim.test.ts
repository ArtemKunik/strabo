import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  resetTerminalShimCache,
  terminalShimDir,
  withTerminalShimPath,
} from '../../src/terminal/shim.ts';

test('terminalShimDir writes a runnable shim', () => {
  resetTerminalShimCache();
  const dir = terminalShimDir();
  assert.ok(dir, 'the shim directory is created');
  assert.ok(fs.existsSync(path.join(dir, 'strabo.js')));
  const wrapper = process.platform === 'win32' ? 'strabo.cmd' : 'strabo';
  assert.ok(fs.existsSync(path.join(dir, wrapper)));
});

test('the shim prints a repository-relative directive', () => {
  const dir = terminalShimDir();
  assert.ok(dir);
  const result = spawnSync(process.execPath, [path.join(dir, 'strabo.js'), 'focus', 'D:\\repo\\src\\a.ts'], {
    encoding: 'utf8',
    env: { ...process.env, STRABO_REPO: 'D:\\repo' },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '::strabo::focus src/a.ts\n');
});

test('the shim leaves a path outside the repository as given', () => {
  const dir = terminalShimDir();
  assert.ok(dir);
  const result = spawnSync(process.execPath, [path.join(dir, 'strabo.js'), 'open', 'other/b.ts', '7'], {
    encoding: 'utf8',
    env: { ...process.env, STRABO_REPO: 'D:\\repo' },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '::strabo::open other/b.ts 7\n');
});

test('the shim rejects an unknown verb', () => {
  const dir = terminalShimDir();
  assert.ok(dir);
  const result = spawnSync(process.execPath, [path.join(dir, 'strabo.js'), 'rm', '-rf', '/'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});

test('withTerminalShimPath prepends without duplicating the PATH key', () => {
  resetTerminalShimCache();
  const env: Record<string, string> = { Path: 'C:\\Windows', FOO: 'bar' };
  withTerminalShimPath(env);
  const dir = terminalShimDir();
  assert.ok(dir);
  assert.ok(env.Path.startsWith(`${dir}${path.delimiter}`));
  assert.equal(env.PATH, undefined);
  assert.equal(env.FOO, 'bar');
});
