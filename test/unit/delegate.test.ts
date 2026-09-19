import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { createDelegateRouter } from '../../src/api/routes/delegate.ts';
import type { StraboConfig } from '../../src/types.ts';

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

async function launch(base: string, agent: string) {
  const response = await fetch(`${base}/delegate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent, prompt: 'Do the thing.', target: { kind: 'view' }, dryRun: true }),
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as { command: string };
  return body.command;
}

/**
 * Delegation must open an interactive session, not a one-shot run, so the operator can add
 * their own instruction. `opencode run` is non-interactive and must not be used; the TUI
 * is started with `--prompt`, which prefills the editable input (there is no auto-submit
 * flag). The seed names the prompt file because the task is multi-line and may exceed the
 * cmd.exe command-line limit.
 */
test('the opencode launcher opens the interactive TUI, not a one-shot run', async () => {
  const base = await listen(app());
  const command = await launch(base, 'opencode');

  assert.match(command, /opencode --prompt "/, `expected a TUI launch: ${command}`);
  assert.doesNotMatch(command, /opencode run\b/, `must not use the non-interactive run: ${command}`);
  assert.doesNotMatch(command, /--dir\b/, `--dir is not a TUI flag; the launcher cds instead: ${command}`);
  assert.match(command, /strabo-task\.md/, `the seed must name the prompt file: ${command}`);
});

test('the claude launcher opens the interactive REPL with the message before --add-dir', async () => {
  const base = await listen(app());
  const command = await launch(base, 'claude');

  assert.match(command, /claude "/, `expected an interactive launch: ${command}`);
  assert.doesNotMatch(command, /claude -p\b|--print\b/, `print mode is non-interactive: ${command}`);
  const messageIndex = command.indexOf('claude "');
  const flagIndex = command.indexOf('--add-dir');
  assert.ok(flagIndex > messageIndex, `--add-dir must follow the message, not precede it: ${command}`);
});
