import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  clearCoverageCommandCache,
  detectCoverageCommand,
  refreshCoverage,
  runCoverageScript,
  type CoverageExecOptions,
} from '../../src/index.ts';

function repo(manifest: unknown, files: readonly string[] = []): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-refresh-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  for (const file of files) {
    fs.writeFileSync(path.join(root, file), '');
  }
  return root;
}

test('detectCoverageCommand picks the first conventional script and the npm runner', () => {
  clearCoverageCommandCache();
  const root = repo({ scripts: { test: 'node --test', 'test:coverage': 'node --test --coverage' } });
  assert.deepEqual(detectCoverageCommand(root), {
    runner: 'npm',
    script: 'test:coverage',
    command: 'npm run test:coverage',
  });
});

test('detectCoverageCommand prefers the most specific script name', () => {
  clearCoverageCommandCache();
  const root = repo({ scripts: { coverage: 'x', 'test:coverage': 'y' } });
  assert.equal(detectCoverageCommand(root)?.script, 'test:coverage');
});

test('detectCoverageCommand reads the runner from packageManager, then the lockfile', () => {
  clearCoverageCommandCache();
  const declared = repo({
    packageManager: 'pnpm@9.1.0',
    scripts: { 'test:coverage': 'vitest --coverage' },
  });
  assert.equal(detectCoverageCommand(declared)?.command, 'pnpm run test:coverage');

  clearCoverageCommandCache();
  const locked = repo({ scripts: { 'test:coverage': 'x' } }, ['yarn.lock']);
  assert.equal(detectCoverageCommand(locked)?.runner, 'yarn');
});

test('detectCoverageCommand returns null without a manifest or a coverage script', () => {
  clearCoverageCommandCache();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-refresh-'));
  assert.equal(detectCoverageCommand(empty), null);

  clearCoverageCommandCache();
  const noScript = repo({ scripts: { test: 'node --test' } });
  assert.equal(detectCoverageCommand(noScript), null);
});

test('refreshCoverage names the reason without running when no script exists', async () => {
  clearCoverageCommandCache();
  const noScript = repo({ scripts: { lint: 'eslint' } });
  const result = await refreshCoverage(noScript, {
    exec: () => {
      throw new Error('must not run without a script');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-script');
  assert.equal(result.command, '');
  assert.equal(result.script, null);
});

test('runCoverageScript runs `run <script>` in the root and captures the output', async () => {
  const calls: Array<{ file: string; args: readonly string[]; options?: CoverageExecOptions }> = [];
  const root = '/repo';
  const result = await runCoverageScript(
    root,
    { runner: 'npm', script: 'test:coverage', command: 'npm run test:coverage' },
    {
      env: { PATH: '/usr/bin' },
      shell: false,
      resolveExecutable: (file) => `/abs/${file}`,
      exec: async (file, args, options) => {
        calls.push({ file, args, ...(options ? { options } : {}) });
        return { stdout: 'all tests passed', stderr: '' };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.command, 'npm run test:coverage');
  assert.match(result.output, /all tests passed/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, '/abs/npm');
  assert.deepEqual(calls[0]?.args, ['run', 'test:coverage']);
  assert.equal(calls[0]?.options?.cwd, root);
});

test('runCoverageScript invokes the command interpreter when asked to use the shell', async () => {
  let seen: { file: string; args: readonly string[] } | undefined;
  const result = await runCoverageScript(
    '/repo',
    { runner: 'pnpm', script: 'coverage', command: 'pnpm run coverage' },
    {
      shell: true,
      env: { ComSpec: 'C:/Windows/System32/cmd.exe' },
      exec: async (file, args) => {
        seen = { file, args };
        return { stdout: '', stderr: '' };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(seen?.file, 'C:/Windows/System32/cmd.exe');
  assert.deepEqual(seen?.args, ['/d', '/s', '/c', 'pnpm run coverage']);
});

test('runCoverageScript reports a non-zero exit with the output tail', async () => {
  const result = await runCoverageScript(
    '/repo',
    { runner: 'npm', script: 'test:coverage', command: 'npm run test:coverage' },
    {
      resolveExecutable: (file) => file,
      exec: async () => {
        throw Object.assign(new Error('exited 2'), { code: 2, stderr: 'coverage failed\n' });
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'failed');
  assert.equal(result.exitCode, 2);
  assert.match(result.output, /coverage failed/);
});

test('runCoverageScript reports a timeout separately from a failure', async () => {
  const result = await runCoverageScript(
    '/repo',
    { runner: 'npm', script: 'test:coverage', command: 'npm run test:coverage' },
    {
      resolveExecutable: (file) => file,
      exec: async () => {
        throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', code: null });
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timed-out');
  assert.equal(result.exitCode, null);
});
