import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { positionals, requestedMcpTools } from '../../src/config.ts';
import { createApiDispatch, createLeanTools, createMcpHandler, createTools, LEAN_DEFAULT_PAGE, parseToolExposure } from '../../src/index.ts';
import type { McpTool } from '../../src/index.ts';
import { TOOL_ALIASES } from '../../src/mcp/tools.ts';
import { config } from './support/interop.ts';

const full = createTools(createApiDispatch(config));
const lean = createLeanTools(full);

function toolText(result: { content: Array<{ text: string }> }): string {
  return result.content[0]?.text ?? '';
}

function gateway(tools: McpTool[] = lean): McpTool {
  const tool = tools.find((candidate) => candidate.name === 'strabo_more');
  assert.ok(tool);
  return tool;
}

function listedSize(tools: McpTool[]): number {
  return JSON.stringify(
    tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  ).length;
}

test('lean mode lists the everyday tools and the gateway', () => {
  assert.deepEqual(
    lean.map((tool) => tool.name),
    ['strabo_passport', 'strabo_file', 'strabo_impact', 'strabo_review', 'strabo_path', 'strabo_more'],
  );
});

test('the lean list costs a small fraction of the full one', () => {
  const size = listedSize(lean);
  assert.ok(size < listedSize(full) / 5, `lean list is ${size} characters`);
});

test('a lean schema keeps what a call is validated against', () => {
  const byName = new Map(lean.map((tool) => [tool.name, tool]));
  const file = byName.get('strabo_file')?.inputSchema as { required: string[]; additionalProperties: boolean };
  assert.deepEqual(file.required, ['file']);
  assert.equal(file.additionalProperties, false);

  const review = byName.get('strabo_review')?.inputSchema as {
    properties: Record<string, { type: string; enum?: string[]; items?: unknown; description?: string }>;
  };
  assert.deepEqual(review.properties.detail?.enum, ['summary', 'full']);
  assert.deepEqual(review.properties.paths?.items, { type: 'string' });
  assert.equal(review.properties.paths?.description, undefined);
});

test('narrowing leaves the full tools untouched', () => {
  const review = full.find((tool) => tool.name === 'strabo_review');
  const properties = (review?.inputSchema as { properties: Record<string, { description?: string }> }).properties;
  assert.ok(properties.paths?.description);
});

test('every tool that is not listed is named by the gateway and reachable through it', async () => {
  const listedTargets = new Set(
    TOOL_ALIASES.filter(({ name }) => lean.some((tool) => tool.name === name)).map(({ target }) => target),
  );
  const aliases = new Set(TOOL_ALIASES.map(({ name }) => name));
  const expected = full
    .filter((tool) => !aliases.has(tool.name) && !listedTargets.has(tool.name))
    .map((tool) => tool.name);
  assert.ok(expected.includes('simulate_change'));
  assert.ok(expected.includes('get_coverage'));
  assert.ok(!expected.includes('get_overview'));

  const description = gateway().description;
  for (const name of expected) assert.ok(description.includes(name), `${name} is not named`);

  const catalog = JSON.parse(toolText(await gateway().call({}))) as Array<{ name: string; summary: string }>;
  assert.deepEqual(catalog.map((entry) => entry.name), expected);
  assert.ok(catalog.every((entry) => entry.summary.length > 0));
});

test('describe returns the full description and schema of any tool', async () => {
  for (const name of ['simulate_change', 'strabo_review']) {
    const original = full.find((tool) => tool.name === name);
    const described = JSON.parse(toolText(await gateway().call({ describe: name }))) as {
      description: string;
      inputSchema: unknown;
    };
    assert.equal(described.description, original?.description);
    assert.deepEqual(described.inputSchema, original?.inputSchema);
  }
});

test('the gateway returns what the tool returns, and passes its arguments on', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const stub: McpTool = {
    name: 'get_cycles',
    description: 'Cycles.',
    inputSchema: { type: 'object' },
    call: async (args) => {
      seen.push(args);
      return { content: [{ type: 'text', text: 'from the tool' }] };
    },
  };
  const tools = createLeanTools([...full.filter((tool) => tool.name !== 'get_cycles'), stub]);

  const result = await gateway(tools).call({ tool: 'get_cycles', arguments: { limit: 3 } });
  assert.equal(toolText(result), 'from the tool');
  await gateway(tools).call({ tool: 'get_cycles' });
  assert.deepEqual(seen, [{ limit: 3 }, { limit: LEAN_DEFAULT_PAGE }]);
});

test('the gateway names its way out of an unknown tool, and cannot call itself', async () => {
  for (const args of [{ tool: 'nope' }, { describe: 'nope' }, { tool: 'strabo_more' }, { tool: 7 }]) {
    const result = await gateway().call(args);
    assert.equal(result.isError, true);
    assert.match(toolText(result), /Unknown tool/);
  }
});

test('a lean handler lists six tools and runs a real one through the gateway', async () => {
  const handler = createMcpHandler(config, lean);
  const list = (await handler.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as {
    result: { tools: Array<{ name: string }> };
  };
  assert.equal(list.result.tools.length, 6);

  const call = (await handler.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'strabo_more', arguments: { tool: 'get_cycles', arguments: {} } },
  })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  const direct = await full.find((tool) => tool.name === 'get_cycles')?.call({ limit: LEAN_DEFAULT_PAGE });
  assert.equal(call.result.isError, undefined);
  assert.deepEqual(JSON.parse(call.result.content[0]?.text ?? ''), JSON.parse(direct ? toolText(direct) : ''));
});

test('a handler given no list serves every tool, so a library caller chooses for itself', async () => {
  const handler = createMcpHandler(config);
  const list = (await handler.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as {
    result: { tools: unknown[] };
  };
  assert.equal(list.result.tools.length, full.length);
});

test('parseToolExposure defaults to lean and refuses anything unknown', () => {
  assert.equal(parseToolExposure(undefined), 'lean');
  assert.equal(parseToolExposure(''), 'lean');
  assert.equal(parseToolExposure('lean'), 'lean');
  assert.equal(parseToolExposure(' FULL '), 'full');
  assert.equal(parseToolExposure('core'), null);
});

test('the flag wins over the environment, and its value is never taken for the repository', () => {
  assert.equal(requestedMcpTools({ STRABO_MCP_TOOLS: 'lean' }, ['--tools=full']), 'full');
  assert.equal(requestedMcpTools({ STRABO_MCP_TOOLS: 'full' }, []), 'full');
  assert.deepEqual(positionals(['--tools', 'full', '/repo']), ['/repo']);
});

test('strabo mcp refuses an unknown tool list before serving anything', () => {
  const cli = new URL('../../src/cli.ts', import.meta.url);
  const result = spawnSync(process.execPath, [cli.pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'mcp', '--tools=core'], {
    input: '',
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown tool list "core"/);
  assert.equal(result.stdout, '');
});

function pagedStub(name: string, total: number): McpTool {
  return {
    name,
    description: `${name}.`,
    inputSchema: { type: 'object' },
    call: async (args) => {
      const limit = args.limit as number;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ items: Array.from({ length: total }, (_, index) => index).slice(0, limit), total }, null, 2),
        }],
      };
    },
  };
}

test('lean results are compact JSON on the smaller page, listed or through the gateway', async () => {
  const stubs = ['get_overview', 'get_cycles'].map((name) => pagedStub(name, 40));
  const tools = createLeanTools([...full.filter((tool) => !['get_overview', 'get_cycles'].includes(tool.name)), ...stubs]);
  const listed = await lean.find((tool) => tool.name === 'strabo_passport')?.call({});
  assert.ok(listed && !toolText(listed).includes('\n'));

  const viaGateway = toolText(await gateway(tools).call({ tool: 'get_cycles' }));
  assert.ok(!viaGateway.includes('\n'));
  assert.equal((JSON.parse(viaGateway) as { items: number[] }).items.length, LEAN_DEFAULT_PAGE);

  const asked = toolText(await gateway(tools).call({ tool: 'get_cycles', arguments: { limit: 35 } }));
  assert.equal((JSON.parse(asked) as { items: number[] }).items.length, 35);
});

test('a lean list that gets cut still says so, and the last page has no next offset', async () => {
  const real = createTools(async () => ({
    status: 200,
    body: { files: Array.from({ length: 25 }, (_, index) => ({ file: `f${index}`, smells: [{ rule: 'dead', detail: 'x' }] })) },
  }));
  const tools = createLeanTools([...full.filter((tool) => tool.name !== 'get_dead_code'), real.find((tool) => tool.name === 'get_dead_code') as McpTool]);

  const first = JSON.parse(toolText(await gateway(tools).call({ tool: 'get_dead_code' }))) as {
    files: unknown[];
    truncation: Array<{ total: number; nextOffset?: number }>;
  };
  assert.equal(first.files.length, LEAN_DEFAULT_PAGE);
  assert.equal(first.truncation[0]?.total, 25);
  assert.equal(first.truncation[0]?.nextOffset, LEAN_DEFAULT_PAGE);

  const last = JSON.parse(
    toolText(await gateway(tools).call({ tool: 'get_dead_code', arguments: { offset: LEAN_DEFAULT_PAGE } })),
  ) as { files: unknown[]; truncation: Array<{ nextOffset?: number }> };
  assert.equal(last.files.length, 5);
  assert.equal(last.truncation[0]?.nextOffset, undefined);
});

test('a lean error stays an error, and text that is not JSON passes through', async () => {
  const stub: McpTool = {
    name: 'get_cycles',
    description: 'Cycles.',
    inputSchema: { type: 'object' },
    call: async () => ({ content: [{ type: 'text', text: 'not json' }], isError: true }),
  };
  const tools = createLeanTools([...full.filter((tool) => tool.name !== 'get_cycles'), stub]);
  const result = await gateway(tools).call({ tool: 'get_cycles' });
  assert.equal(result.isError, true);
  assert.equal(toolText(result), 'not json');
});

test('the catalog says what each tool takes, without the arguments every tool shares', async () => {
  const catalog = JSON.parse(toolText(await gateway().call({}))) as Array<{
    name: string;
    summary: string;
    required?: string[];
    optional?: string[];
  }>;
  assert.ok(catalog.every((entry) => entry.summary.length <= 160));
  for (const entry of catalog) {
    const tool = full.find((candidate) => candidate.name === entry.name);
    assert.deepEqual(entry.required ?? [], tool?.inputSchema.required ?? []);
    for (const shared of ['repository', 'limit', 'offset']) {
      assert.ok(!(entry.optional ?? []).includes(shared));
    }
  }
  assert.ok(catalog.some((entry) => (entry.required ?? []).length > 0));
});
