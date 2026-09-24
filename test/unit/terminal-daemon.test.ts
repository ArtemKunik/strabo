import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  daemonEndpoint,
  hostEntryPath,
  readDaemonToken,
  writeDaemonToken,
  type DaemonEndpoint,
} from '../../src/terminal/daemon.ts';

const created: string[] = [];

after(() => {
  for (const dir of created) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempEndpoint(): DaemonEndpoint {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-termd-test-'));
  created.push(dir);
  return {
    socketPath: path.join(dir, 'termd.sock'),
    tokenFile: path.join(dir, 'termd.token'),
  };
}

test('daemonEndpoint is deterministic and differs per workspace root', () => {
  const first = daemonEndpoint('D:/work/repo');
  const second = daemonEndpoint('D:/work/repo');
  const other = daemonEndpoint('D:/work/other');
  assert.deepEqual(first, second);
  assert.notEqual(first.socketPath, other.socketPath);
  assert.notEqual(first.tokenFile, other.tokenFile);

  assert.match(path.basename(first.tokenFile), /^termd-[0-9a-f]{12}\.token$/);
  if (process.platform === 'win32') {
    assert.match(first.socketPath, /^\\\\\.\\pipe\\strabo-termd-[0-9a-f]{12}$/);
  } else {
    assert.match(first.socketPath, /termd-[0-9a-f]{12}\.sock$/);
    assert.equal(path.dirname(first.socketPath), path.dirname(first.tokenFile));
  }
});

test('daemonEndpoint normalises case on Windows', () => {
  if (process.platform !== 'win32') {
    return;
  }
  assert.deepEqual(daemonEndpoint('D:/Work/Repo'), daemonEndpoint('d:/work/repo'));
});

test('hostEntryPath swaps only the extension of this module', () => {
  const source = fileURLToPath(new URL('../../src/terminal/daemon.ts', import.meta.url));
  const entry = hostEntryPath();
  assert.equal(path.dirname(entry), path.dirname(source));
  assert.equal(path.basename(entry), `host${path.extname(source)}`);
  assert.equal(path.extname(entry), path.extname(source));
});

test('writeDaemonToken creates the directory and readDaemonToken round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-termd-token-'));
  created.push(dir);
  const endpoint: DaemonEndpoint = {
    socketPath: path.join(dir, 'nested', 'termd.sock'),
    tokenFile: path.join(dir, 'nested', 'termd.token'),
  };

  assert.equal(readDaemonToken(endpoint), null);
  writeDaemonToken(endpoint, 'secret-token');
  assert.equal(readDaemonToken(endpoint), 'secret-token');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(endpoint.tokenFile).mode & 0o777, 0o600);
  }
});

test('readDaemonToken ignores an unreadable or blank file', () => {
  const endpoint = tempEndpoint();
  assert.equal(readDaemonToken(endpoint), null);
  fs.writeFileSync(endpoint.tokenFile, '   \n');
  assert.equal(readDaemonToken(endpoint), null);
});
