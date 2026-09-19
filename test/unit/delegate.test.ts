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
 * opencode's `-f/--file` and Claude's `--add-dir` are both variadic: they greedily
 * consume every bare token that follows, not just the one meant for them. A launcher
 * that writes the flag before the message hands the CLI a message-shaped "file" and an
 * empty prompt — confirmed against the installed CLIs, this is exactly the
 * "File not found: <the whole message>" failure the app shipped with. The message must
 * be the last bare token before the flag, not after it.
 */
test('the opencode launcher puts the message before the variadic -f flag', async () => {
  const base = await listen(app());
  const command = await launch(base, 'opencode');

  const messageIndex = command.indexOf('"The task is described');
  const flagIndex = command.indexOf('-f ');
  assert.ok(messageIndex > 0, `command should carry the prompt: ${command}`);
  assert.ok(flagIndex > messageIndex, `-f must follow the message, not precede it: ${command}`);
});

test('the claude launcher puts the message before the variadic --add-dir flag', async () => {
  const base = await listen(app());
  const command = await launch(base, 'claude');

  const messageIndex = command.indexOf('"The task is described');
  const flagIndex = command.indexOf('--add-dir');
  assert.ok(messageIndex > 0, `command should carry the prompt: ${command}`);
  assert.ok(flagIndex > messageIndex, `--add-dir must follow the message, not precede it: ${command}`);
});
