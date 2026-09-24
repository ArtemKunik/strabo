import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { resolveExecutable } from '../../src/terminal/executable.ts';

const created: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-executable-'));
  created.push(dir);
  return dir;
}

/** Windows resolves `PATHEXT` suffixes with their declared case; the filesystem is case-insensitive. */
function equalPath(actual: string, expected: string): void {
  if (process.platform === 'win32') {
    assert.equal(actual.toLowerCase(), expected.toLowerCase());
  } else {
    assert.equal(actual, expected);
  }
}

after(() => {
  for (const dir of created) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an absolute path is returned unchanged', () => {
  const file = path.join(os.tmpdir(), 'strabo-absolute-tool');
  assert.equal(resolveExecutable(file, { PATH: '' }), file);
});

test('a name that already contains a path separator is returned unchanged', () => {
  assert.equal(resolveExecutable('bin/tool', { PATH: os.tmpdir() }), 'bin/tool');
  assert.equal(resolveExecutable('bin\\tool', { PATH: os.tmpdir() }), 'bin\\tool');
});

test('a bare name is resolved to the absolute executable on PATH', () => {
  const dir = tempDir();
  const name = process.platform === 'win32' ? 'strabo-tool.exe' : 'strabo-tool';
  fs.writeFileSync(path.join(dir, name), '');
  const env = { PATH: dir, PATHEXT: '.EXE;.CMD' };
  equalPath(resolveExecutable('strabo-tool', env), path.join(dir, name));
});

test('the first PATH entry holding the command wins', () => {
  const first = tempDir();
  const second = tempDir();
  const name = process.platform === 'win32' ? 'strabo-tool.exe' : 'strabo-tool';
  fs.writeFileSync(path.join(first, name), '');
  fs.writeFileSync(path.join(second, name), '');
  const env = { PATH: `${first}${path.delimiter}${second}`, PATHEXT: '.EXE;.CMD' };
  equalPath(resolveExecutable('strabo-tool', env), path.join(first, name));
});

test('a name that is not on PATH is returned unchanged', () => {
  const missing = 'strabo-definitely-not-a-real-tool-xyz';
  assert.equal(resolveExecutable(missing, { PATH: os.tmpdir() }), missing);
});

test('an empty PATH leaves the name untouched', () => {
  assert.equal(resolveExecutable('opencode', { PATH: '' }), 'opencode');
});

test('on Windows an extensionless sibling is skipped in favour of PATHEXT', () => {
  if (process.platform !== 'win32') {
    return;
  }
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'tool'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(dir, 'tool.cmd'), '');
  equalPath(resolveExecutable('tool', { PATH: dir, PATHEXT: '.EXE;.CMD' }), path.join(dir, 'tool.cmd'));
});

test('on Windows a name that already carries a PATHEXT suffix is searched exactly', () => {
  if (process.platform !== 'win32') {
    return;
  }
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'tool.exe'), '');
  equalPath(resolveExecutable('tool.exe', { PATH: dir, PATHEXT: '.EXE;.CMD' }), path.join(dir, 'tool.exe'));
});
