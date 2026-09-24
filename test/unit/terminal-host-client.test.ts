import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeDaemonToken, type DaemonEndpoint } from '../../src/terminal/daemon.ts';
import { createHostSessionManager } from '../../src/terminal/host-client.ts';
import { startTerminalHost } from '../../src/terminal/host.ts';
import { createSessionManager } from '../../src/terminal/registry.ts';
import type { PtyProcess, PtySpawnOptions, PtySpawner } from '../../src/terminal/session.ts';
import type { StraboConfig } from '../../src/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'sample-repo');
const config: StraboConfig = { workspaceRoot: fixture, scanCeiling: fixture };
const created: string[] = [];

after(() => {
  for (const dir of created) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

class FakePty implements PtyProcess {
  readonly pid: number;
  readonly file: string;
  readonly args: string[];
  readonly options: PtySpawnOptions;
  killed = false;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number }) => void>();

  constructor(file: string, args: string[], options: PtySpawnOptions, pid: number) {
    this.file = file;
    this.args = args;
    this.options = options;
    this.pid = pid;
  }

  onData(callback: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(callback);
    return { dispose: () => this.dataListeners.delete(callback) };
  }

  onExit(callback: (event: { exitCode: number }) => void): { dispose(): void } {
    this.exitListeners.add(callback);
    return { dispose: () => this.exitListeners.delete(callback) };
  }

  write(): void {}

  resize(): void {}

  kill(): void {
    this.killed = true;
    this.exit(0);
  }

  emit(data: string): void {
    for (const callback of [...this.dataListeners]) {
      callback(data);
    }
  }

  exit(code: number): void {
    for (const callback of [...this.exitListeners]) {
      callback({ exitCode: code });
    }
  }
}

function fakeSpawner(processes: FakePty[]): PtySpawner {
  return (file, args, options) => {
    const pty = new FakePty(file, args, options, 1000 + processes.length);
    processes.push(pty);
    return pty;
  };
}

function makeEndpoint(): DaemonEndpoint {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-host-client-'));
  created.push(dir);
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\strabo-hc-${path.basename(dir)}`
      : path.join(dir, 'termd.sock');
  return { socketPath, tokenFile: path.join(dir, 'termd.token') };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition not met before the deadline');
}

test('host client mirrors sessions, serves backlog, and survives a client restart', async () => {
  const endpoint = makeEndpoint();
  const token = 'test-token-1';
  writeDaemonToken(endpoint, token);
  const processes: FakePty[] = [];
  const host = await startTerminalHost({
    socketPath: endpoint.socketPath,
    token,
    config,
    spawn: fakeSpawner(processes),
    idleMs: 60_000,
  });

  const client = createHostSessionManager(config, { endpoint, connectTimeoutMs: 3000 });
  let sessionA: Awaited<ReturnType<typeof client.create>>;
  try {
    sessionA = await client.create({ kind: 'shell', title: 'alpha' });
    assert.equal(sessionA.meta.title, 'alpha');
    assert.deepEqual(client.list().map((meta) => meta.id), [sessionA.meta.id]);
    assert.equal(client.get(sessionA.meta.id), sessionA);

    const ptyA = processes[0];
    assert.ok(ptyA);
    ptyA.emit('hello');

    await waitFor(() => sessionA.backlog(0).data === 'hello');
    assert.deepEqual(sessionA.backlog(0), { fromSeq: 0, seq: 1, data: 'hello' });

    const live: string[] = [];
    sessionA.onData((data) => live.push(data));
    ptyA.emit('world');
    await waitFor(() => live.includes('world'));

    const sessionB = await client.create({ kind: 'shell', title: 'beta' });
    await waitFor(() => client.list().length === 2);
    assert.equal(client.kill(sessionB.meta.id), true);
    await waitFor(() => !client.list().some((meta) => meta.id === sessionB.meta.id));
  } finally {
    client.shutdown();
  }

  // A fresh client on the same socket must still see session A and its backlog, because
  // shutdown disconnects the client and never stops the daemon or its sessions.
  const client2 = createHostSessionManager(config, { endpoint, connectTimeoutMs: 3000 });
  try {
    await client2.create({ kind: 'shell', title: 'gamma' });
    const restored = client2.get(sessionA.meta.id);
    assert.ok(restored, 'session A survived the client restart');
    assert.equal(restored.backlog(0).data, 'helloworld');
    assert.ok(client2.list().some((meta) => meta.id === sessionA.meta.id));
  } finally {
    client2.shutdown();
    await host.close();
  }
});

test('host client falls back to a local manager when the daemon cannot be reached', async () => {
  const endpoint = makeEndpoint();
  const processes: FakePty[] = [];
  const local = createSessionManager(config, { spawn: fakeSpawner(processes) });
  const neverSpawns = (() => ({ unref() {} })) as unknown as typeof import('node:child_process').spawn;
  const client = createHostSessionManager(config, {
    endpoint,
    connectTimeoutMs: 250,
    fallback: () => local,
    spawn: neverSpawns,
  });

  try {
    const session = await client.create({ kind: 'shell', title: 'local' });
    assert.equal(session.meta.title, 'local');
    assert.deepEqual(client.list().map((meta) => meta.id), [session.meta.id]);
    assert.equal(client.get(session.meta.id), session);
  } finally {
    client.shutdown();
  }
});
