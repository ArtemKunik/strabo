import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApiDispatch, createMcpHandler } from '../../src/index.ts';
import { config } from './support/interop.ts';

async function callTool(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; body: unknown }> {
  const handler = createMcpHandler(config);
  const reply = (await handler.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  return { isError: reply.result.isError, body: JSON.parse(reply.result.content[0]?.text ?? 'null') };
}

test('the what-if route resolves the recorded cycle when one side of it is cut, and the MCP tool agrees', async () => {
  const dispatch = createApiDispatch(config);
  const ops = [{ op: 'cut', source: 'src/cycle-b.ts', target: 'src/cycle-a.ts' }];
  const http = await dispatch('GET', `/analysis/what-if?ops=${encodeURIComponent(JSON.stringify(ops))}`);
  const body = http.body as { hypothetical: boolean; cyclesResolved: Array<{ members: string[] }>; rejected: unknown[] };

  assert.equal(http.status, 200);
  assert.equal(body.hypothetical, true);
  assert.deepEqual(body.cyclesResolved.map((cycle) => cycle.members), [['src/cycle-a.ts', 'src/cycle-b.ts']]);
  assert.deepEqual(body.rejected, []);

  const mcp = await callTool('simulate_change', { operations: ops });
  assert.notEqual(mcp.isError, true);
  assert.deepEqual(
    (mcp.body as { cyclesResolved: Array<{ members: string[] }> }).cyclesResolved.map((cycle) => cycle.members),
    body.cyclesResolved.map((cycle) => cycle.members),
  );
});

test('the what-if route refuses ops that are not JSON', async () => {
  const dispatch = createApiDispatch(config);
  const http = await dispatch('GET', '/analysis/what-if?ops=nope');
  assert.equal(http.status, 400);
});

test('the extraction route plans one side of the recorded cycle as a boundary blocker', async () => {
  const dispatch = createApiDispatch(config);
  const http = await dispatch('GET', '/analysis/extraction?include=src/cycle-a.ts');
  const body = http.body as {
    files: string[];
    boundaryCycles: Array<{ inside: string[]; outside: string[] }>;
    dependencies: Array<{ file: string }>;
  };

  assert.equal(http.status, 200);
  assert.deepEqual(body.files, ['src/cycle-a.ts']);
  assert.deepEqual(body.boundaryCycles.map((cycle) => [cycle.inside, cycle.outside]), [
    [['src/cycle-a.ts'], ['src/cycle-b.ts']],
  ]);
  assert.ok(body.dependencies.some((entry) => entry.file === 'src/cycle-b.ts'));

  const mcp = await callTool('plan_extraction', { include: 'src/cycle-a.ts' });
  assert.deepEqual((mcp.body as { files: string[] }).files, body.files);

  const missing = await dispatch('GET', '/analysis/extraction');
  assert.equal(missing.status, 400);
});
