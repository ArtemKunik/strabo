import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createApiDispatch,
  createMcpHandler,
  runCheckCommand,
  runExportCommand,
} from '../../src/index.ts';
import { config } from './support/interop.ts';

test('the same cycles are reported by the HTTP route, the MCP tool, and the CLI', async () => {
  const dispatch = createApiDispatch(config);
  const http = (await dispatch('GET', '/analysis/cycles')).body as Array<{
    id: string;
    members: string[];
  }>;

  const handler = createMcpHandler(config);
  const call = (await handler.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'get_cycles', arguments: {} },
  })) as { result: { content: Array<{ text: string }> } };
  const mcp = JSON.parse(call.result.content[0]?.text ?? '[]') as Array<{ id: string }>;

  const chunks: string[] = [];
  const code = await runCheckCommand(
    [config.workspaceRoot, '--fail-on-cycles', '--format=json'],
    { write: (text) => chunks.push(text) },
  );
  const parsed = JSON.parse(chunks.join('')) as {
    findings: Array<{ rule: string }>;
    passed: boolean;
  };

  assert.ok(http.length > 0);
  assert.deepEqual(mcp.map((group) => group.id), http.map((group) => group.id));
  assert.equal(parsed.passed, false);
  assert.equal(parsed.findings.filter((finding) => finding.rule === 'cycles').length, http.length);
  assert.equal(code, 1);
});

test('the CLI export command writes a portable graph to its sink', async () => {
  const chunks: string[] = [];
  const code = await runExportCommand(
    [config.workspaceRoot, '--format=dot', '--include-declare'],
    { write: (text) => chunks.push(text) },
  );
  const dot = chunks.join('');
  assert.equal(code, 0);
  assert.match(dot, /digraph strabo/);
  assert.match(dot, /"src\/cycle-a\.ts" -> "src\/cycle-b\.ts"/);
});
