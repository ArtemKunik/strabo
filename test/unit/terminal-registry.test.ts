import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { StraboScopeError } from '../../src/boundary/repository-root.ts';
import { TERMINAL_LIMITS } from '../../src/terminal/protocol.ts';
import { createSessionManager } from '../../src/terminal/registry.ts';
import type { PtyProcess, PtySpawnOptions, PtySpawner } from '../../src/terminal/session.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'sample-repo');
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

function harness(root: string = fixture) {
  const processes: FakePty[] = [];
  const spawner: PtySpawner = (file, args, options) => {
    const pty = new FakePty(file, args, options, 1000 + processes.length);
    processes.push(pty);
    return pty;
  };
  const manager = createSessionManager({ workspaceRoot: root, scanCeiling: root }, { spawn: spawner });
  return { manager, processes };
}

test('registry creates, lists, gets, renames, and kills sessions', async () => {
  const { manager } = harness();
  const session = await manager.create({ kind: 'shell' });
  assert.equal(session.meta.status, 'running');
  assert.equal(session.meta.cwd, fixture);
  assert.equal(session.meta.repo, fixture);
  assert.equal(session.meta.title, path.basename(fixture));
  assert.equal(session.meta.exitCode, null);

  assert.deepEqual(manager.list().map((meta) => meta.id), [session.meta.id]);
  assert.equal(manager.get(session.meta.id), session);

  assert.equal(manager.rename(session.meta.id, 'renamed'), true);
  assert.equal(session.meta.title, 'renamed');
  assert.equal(manager.rename('missing', 'x'), false);

  assert.equal(manager.kill(session.meta.id), true);
  assert.equal(manager.get(session.meta.id), undefined);
  assert.deepEqual(manager.list(), []);
  assert.equal(manager.kill(session.meta.id), false);
});

test('registry resolves a server-derived preset to its argv and label', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-terminal-preset-'));
  created.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'tsc -p .' } }));
  const { manager, processes } = harness(root);
  const session = await manager.create({ kind: 'task', preset: 'pkg:build' });
  const pty = processes[0];
  assert.ok(pty);
  assert.equal(pty.file, 'npm');
  assert.deepEqual(pty.args, ['run', 'build']);
  assert.equal(session.meta.title, 'build');
  assert.equal(session.meta.kind, 'task');
});

test('an unknown preset falls back to a shell rather than executing anything', async () => {
  const { manager, processes } = harness();
  const session = await manager.create({ kind: 'task', preset: 'pkg:gone' });
  const pty = processes[0];
  assert.ok(pty);
  assert.notEqual(pty.file, 'pkg:gone');
  assert.equal(session.meta.kind, 'task');
});

test('registry injects identity and repo into the child environment', async () => {
  const { manager, processes } = harness();
  const session = await manager.create({ env: { EXTRA: '1' } });
  const pty = processes[0];
  assert.ok(pty);
  assert.equal(pty.options.env.STRABO_SESSION_ID, session.meta.id);
  assert.equal(pty.options.env.STRABO_REPO, fixture);
  assert.equal(pty.options.env.EXTRA, '1');
  assert.equal(pty.options.cwd, fixture);
});

test('registry spawns agent argv directly and titles from argv[0]', async () => {
  const { manager, processes } = harness();
  const session = await manager.create({ kind: 'agent', argv: ['my-agent', '--flag'] });
  const pty = processes[0];
  assert.ok(pty);
  assert.equal(pty.file, 'my-agent');
  assert.deepEqual(pty.args, ['--flag']);
  assert.equal(session.meta.title, 'my-agent');
  assert.equal(session.meta.kind, 'agent');
});

test('registry enforces the max session cap', async () => {
  const { manager } = harness();
  for (let index = 0; index < TERMINAL_LIMITS.maxSessions; index += 1) {
    await manager.create({});
  }
  assert.equal(manager.list().length, TERMINAL_LIMITS.maxSessions);
  await assert.rejects(() => manager.create({}), /limit/i);

  const first = manager.list()[0];
  assert.ok(first);
  manager.kill(first.id);
  await manager.create({});
  assert.equal(manager.list().length, TERMINAL_LIMITS.maxSessions);
});

test('registry backlog slices only output newer than fromSeq', async () => {
  const { manager, processes } = harness();
  const session = await manager.create({});
  const pty = processes[0];
  assert.ok(pty);
  pty.emit('a');
  pty.emit('b');
  pty.emit('c');
  assert.equal(session.meta.seq, 3);

  assert.deepEqual(session.backlog(0), { fromSeq: 0, seq: 3, data: 'abc' });
  assert.deepEqual(session.backlog(1), { fromSeq: 1, seq: 3, data: 'bc' });
  assert.deepEqual(session.backlog(2), { fromSeq: 2, seq: 3, data: 'c' });
  assert.deepEqual(session.backlog(3), { fromSeq: 3, seq: 3, data: '' });
  assert.deepEqual(session.backlog(9), { fromSeq: 3, seq: 3, data: '' });
});

test('registry parses OSC titles from output and emits them', async () => {
  const { manager, processes } = harness();
  const session = await manager.create({});
  const pty = processes[0];
  assert.ok(pty);
  const titles: string[] = [];
  session.onTitle((title) => titles.push(title));
  pty.emit('before\x1b]0;hel');
  pty.emit('lo\x07after');
  pty.emit('x\x1b]2;world\x1b\\y');
  assert.deepEqual(titles, ['hello', 'world']);
});

test('registry truncates titles to the protocol cap', async () => {
  const { manager } = harness();
  const session = await manager.create({ title: 'z'.repeat(500) });
  assert.equal(session.meta.title.length, TERMINAL_LIMITS.maxTitleChars);
  manager.rename(session.meta.id, 'q'.repeat(500));
  assert.equal(session.meta.title.length, TERMINAL_LIMITS.maxTitleChars);
});

test('registry resolves cwd relative to the repo and rejects escape', async () => {
  const { manager } = harness();
  const relative = await manager.create({ cwd: 'src' });
  assert.equal(relative.meta.cwd, path.join(fixture, 'src'));

  const absolute = await manager.create({ cwd: path.join(fixture, 'src') });
  assert.equal(absolute.meta.cwd, path.join(fixture, 'src'));

  await assert.rejects(() => manager.create({ cwd: path.resolve(fixture, '..') }), StraboScopeError);
});

test('registry rejects a repo outside the scan ceiling', async () => {
  const { manager } = harness();
  await assert.rejects(
    () => manager.create({ repo: path.resolve(fixture, '..') }),
    StraboScopeError,
  );
});

test('a session exit marks the meta and fires exit listeners', async () => {
  const { manager, processes } = harness();
  const session = await manager.create({});
  const pty = processes[0];
  assert.ok(pty);
  const codes: number[] = [];
  session.onExit((code) => codes.push(code));
  pty.exit(7);
  assert.equal(session.meta.status, 'exited');
  assert.equal(session.meta.exitCode, 7);
  assert.deepEqual(codes, [7]);
  assert.equal(manager.get(session.meta.id), session);
});

test('shutdown kills every session and clears the registry', async () => {
  const { manager, processes } = harness();
  await manager.create({});
  await manager.create({});
  manager.shutdown();
  assert.deepEqual(manager.list(), []);
  assert.ok(processes.every((pty) => pty.killed));
});
