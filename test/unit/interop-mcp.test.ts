import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApiDispatch, createMcpHandler, createTools } from '../../src/index.ts';
import type { ApiDispatch } from '../../src/api/dispatch.ts';
import { MCP_DEFAULT_PAGE, MCP_MAX_RESULT_CHARS } from '../../src/mcp/tools.ts';
import { config, toolText } from './support/interop.ts';

test('the MCP handler answers initialize, tools/list, and tools/call', async () => {
  const handler = createMcpHandler(config);

  const init = (await handler.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' })) as {
    result: { protocolVersion: string; serverInfo: { name: string } };
  };
  assert.equal(init.result.serverInfo.name, 'strabo');

  const list = (await handler.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
    result: { tools: Array<{ name: string; inputSchema: unknown }> };
  };
  assert.ok(list.result.tools.length >= 10);
  assert.ok(list.result.tools.some((tool) => tool.name === 'get_dependency_path'));

  const call = (await handler.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'get_cycles', arguments: {} },
  })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  assert.equal(call.result.isError, undefined);
  const cycles = JSON.parse(call.result.content[0]?.text ?? '[]') as unknown[];
  assert.ok(Array.isArray(cycles));

  const unknown = (await handler.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'nope', arguments: {} },
  })) as { error: { code: number } };
  assert.equal(unknown.error.code, -32602);
});

test('each alias shares its target tool implementation and stays listed', async () => {
  const tools = createTools(createApiDispatch(config));
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const mapping: ReadonlyArray<[string, string]> = [
    ['strabo_passport', 'get_overview'],
    ['strabo_file', 'get_context'],
    ['strabo_impact', 'get_impact'],
    ['strabo_review', 'get_change_risk'],
    ['strabo_path', 'get_dependency_path'],
  ];

  const handler = createMcpHandler(config);
  const list = (await handler.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as {
    result: { tools: Array<{ name: string; description: string }> };
  };
  const names = list.result.tools.map((tool) => tool.name);

  for (const [alias, target] of mapping) {
    assert.ok(names.includes(target), `${target} is still listed`);
    assert.ok(names.includes(alias), `${alias} is listed`);
    assert.equal(byName.get(alias)?.call, byName.get(target)?.call);
    assert.match(byName.get(alias)?.description ?? '', /^Alias of /);
  }

  const aliasPath = await toolText(handler, 'strabo_path', {
    from: 'src/cycle-a.ts',
    to: 'src/cycle-b.ts',
  });
  const targetPath = await toolText(handler, 'get_dependency_path', {
    from: 'src/cycle-a.ts',
    to: 'src/cycle-b.ts',
  });
  assert.equal(aliasPath, targetPath);
  assert.deepEqual(JSON.parse(aliasPath).path, ['src/cycle-a.ts', 'src/cycle-b.ts']);
});

test('an oversized list is paged and the result names its truncation', async () => {
  const body = {
    repository: 'demo',
    files: Array.from({ length: 130 }, (_, index) => ({ file: `src/f${index}.ts` })),
  };
  const tools = createTools(async () => ({ status: 200, body }));
  const cycles = tools.find((tool) => tool.name === 'get_cycles');
  assert.ok(cycles);

  const bounded = JSON.parse((await cycles.call({})).content[0]?.text ?? '{}') as {
    truncated: boolean;
    listsTruncated: number;
    files: unknown[];
    truncation: Array<{ path: string; shown: number; total: number; omitted: number; nextOffset: number }>;
  };
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.listsTruncated, 1);
  assert.equal(bounded.files.length, MCP_DEFAULT_PAGE);
  assert.equal(bounded.truncation[0]?.path, 'files');
  assert.equal(bounded.truncation[0]?.shown, MCP_DEFAULT_PAGE);
  assert.equal(bounded.truncation[0]?.total, 130);
  assert.equal(bounded.truncation[0]?.omitted, 130 - MCP_DEFAULT_PAGE);
  assert.equal(bounded.truncation[0]?.nextOffset, MCP_DEFAULT_PAGE);

  const paged = JSON.parse((await cycles.call({ limit: 10, offset: 5 })).content[0]?.text ?? '{}') as {
    files: unknown[];
    truncation: Array<{ shown: number; omitted: number; nextOffset: number }>;
  };
  assert.equal(paged.files.length, 10);
  assert.equal(paged.truncation[0]?.shown, 10);
  assert.equal(paged.truncation[0]?.omitted, 120);
  assert.equal(paged.truncation[0]?.nextOffset, 15);
});

test('a result over the character cap is replaced by a truncation marker', async () => {
  const body = { repository: 'demo', blob: 'x'.repeat(MCP_MAX_RESULT_CHARS + 1) };
  const tools = createTools(async () => ({ status: 200, body }));
  const overview = tools.find((tool) => tool.name === 'get_overview');
  assert.ok(overview);

  const parsed = JSON.parse((await overview.call({})).content[0]?.text ?? '{}') as {
    truncated: boolean;
    reason: string;
    detail: string;
  };
  assert.equal(parsed.truncated, true);
  assert.match(parsed.reason, /cap/);
  assert.match(parsed.detail, /limit/);
});

test('the file-level tools carry the recorded import line and specifier on every edge', async () => {
  const handler = createMcpHandler(config);

  const pathBody = JSON.parse(
    await toolText(handler, 'strabo_path', { from: 'src/cycle-a.ts', to: 'src/cycle-b.ts' }),
  ) as {
    found: boolean;
    edges: Array<{ source: string; target: string; evidence: { line: number; specifier: string } }>;
  };
  assert.equal(pathBody.found, true);
  assert.equal(pathBody.edges.length, 1);
  assert.equal(pathBody.edges[0]?.source, 'src/cycle-a.ts');
  assert.equal(pathBody.edges[0]?.target, 'src/cycle-b.ts');
  assert.equal(typeof pathBody.edges[0]?.evidence.line, 'number');
  assert.match(pathBody.edges[0]?.evidence.specifier ?? '', /cycle-b/);

  const fileBody = JSON.parse(await toolText(handler, 'strabo_file', { file: 'src/index.ts' })) as {
    imports: Array<{ evidence: { line: number; specifier: string } }>;
  };
  assert.ok(fileBody.imports.length >= 3);
  for (const edge of fileBody.imports) {
    assert.equal(typeof edge.evidence.line, 'number');
    assert.equal(typeof edge.evidence.specifier, 'string');
  }

  const importerBody = JSON.parse(await toolText(handler, 'strabo_file', { file: 'src/util.ts' })) as {
    importers: Array<{ evidence: { line: number; specifier: string } }>;
  };
  assert.ok(importerBody.importers.length >= 1);
  for (const edge of importerBody.importers) {
    assert.equal(typeof edge.evidence.line, 'number');
    assert.equal(typeof edge.evidence.specifier, 'string');
  }
});

test('the impact tool names the recorded edge that reached each affected file', async () => {
  const graph = JSON.stringify({
    edges: [
      {
        source: 'src/a.ts',
        target: 'src/b.ts',
        kind: 'import',
        evidence: { line: 3, specifier: './b', resolution: 'exact' },
      },
      {
        source: 'src/c.ts',
        target: 'src/a.ts',
        kind: 'import',
        evidence: { line: 7, specifier: './a', resolution: 'exact' },
      },
    ],
  });
  const dispatch: ApiDispatch = async (_method, path) => {
    if (path.startsWith('/export')) {
      return { status: 200, body: graph };
    }
    if (path.startsWith('/analysis/impact')) {
      return {
        status: 200,
        body: {
          changed: [{ path: 'src/b.ts', status: 'M' }],
          affected: [
            { id: 'src/b.ts', distance: 0 },
            { id: 'src/a.ts', distance: 1 },
            { id: 'src/c.ts', distance: 2 },
          ],
          outsideGraph: [],
        },
      };
    }
    return { status: 404, body: { error: 'not found' } };
  };

  const tools = createTools(dispatch);
  const impact = tools.find((tool) => tool.name === 'strabo_impact');
  assert.ok(impact);

  const parsed = JSON.parse((await impact.call({})).content[0]?.text ?? '{}') as {
    edges: Array<{ source: string; target: string; evidence: { line: number; specifier: string } }>;
  };
  assert.deepEqual(
    parsed.edges.map((edge) => [edge.source, edge.target, edge.evidence.line]),
    [
      ['src/a.ts', 'src/b.ts', 3],
      ['src/c.ts', 'src/a.ts', 7],
    ],
  );
  for (const edge of parsed.edges) {
    assert.equal(typeof edge.evidence.specifier, 'string');
  }
});
