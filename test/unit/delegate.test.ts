import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { createDelegateRouter } from '../../src/api/routes/delegate.ts';
import type { StraboConfig } from '../../src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '..', 'fixtures');
const config: StraboConfig = {
  workspaceRoot: path.join(fixtures, 'block-repo'),
  scanCeiling: fixtures,
};

const servers: Array<ReturnType<typeof express.application.listen>> = [];

after(() => {
  for (const server of servers) {
    server.close();
  }
});

function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      servers.push(server);
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function app(): express.Express {
  const instance = express();
  instance.use(express.json());
  instance.use(createDelegateRouter(config));
  return instance;
}

interface DryRun {
  command: string[];
  sessionId: string | null;
  status: string;
  promptFile: string;
}

async function dryRun(base: string, agent: string): Promise<DryRun> {
  const response = await fetch(`${base}/delegate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent, prompt: 'Do the thing.', target: { kind: 'view' }, dryRun: true }),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as DryRun;
}

/**
 * Delegation builds an in-app agent session, not an external window. The dry run returns the
 * exact argv that would be handed to the registry, so the shape is asserted without spawning
 * a PTY. `opencode run` is non-interactive and must not be used; the TUI is started with
 * `--prompt`, which prefills the editable input (there is no auto-submit flag). The seed
 * names the prompt file because the task is multi-line and may exceed a command line.
 */
test('the opencode argv opens the interactive TUI, not a one-shot run', async () => {
  const run = await dryRun(await listen(app()), 'opencode');

  assert.equal(run.status, 'dry-run');
  assert.equal(run.sessionId, null);
  assert.deepEqual(run.command.slice(0, 2), ['opencode', '--prompt']);
  assert.doesNotMatch(run.command.join(' '), /opencode run\b/, `must not use the non-interactive run: ${run.command}`);
  assert.match(run.command[2] ?? '', /strabo-task\.md/, `the seed must name the prompt file: ${run.command}`);
});

test('the claude argv puts the message before --add-dir', async () => {
  const run = await dryRun(await listen(app()), 'claude');

  assert.equal(run.command[0], 'claude');
  assert.match(run.command[1] ?? '', /strabo-task\.md/);
  const flagIndex = run.command.indexOf('--add-dir');
  assert.equal(flagIndex, 2, `--add-dir must follow the message: ${run.command}`);
  assert.equal(run.command[3], path.dirname(run.promptFile).replace(/\\/g, '/'));
  assert.doesNotMatch(run.command.join(' '), /--print\b|-p\b/, `print mode is non-interactive: ${run.command}`);
});

test('delegate rejects a prompt-less request and an unknown agent', async () => {
  const base = await listen(app());
  const empty = await fetch(`${base}/delegate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'opencode' }),
  });
  assert.equal(empty.status, 400);

  const unknown = await fetch(`${base}/delegate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'bash', prompt: 'x' }),
  });
  assert.equal(unknown.status, 400);
});
