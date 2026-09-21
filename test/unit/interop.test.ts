import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createApiDispatch,
  createMcpHandler,
  createTools,
  computeFreshness,
  defaultBaselinePath,
  exportGraph,
  exportSite,
  readBaseline,
  renderViewModelSvg,
  runCheck,
  runCheckCommand,
  runExportCommand,
  buildBaseline,
  writeBaseline,
} from '../../src/index.ts';
import type { Graph, StraboConfig, ViewModel } from '../../src/index.ts';
import type { ApiDispatch } from '../../src/api/dispatch.ts';
import { MCP_DEFAULT_PAGE, MCP_MAX_RESULT_CHARS } from '../../src/mcp/tools.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '..', 'fixtures');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-interop-'));

before(() => {
  process.env.STRABO_STATE_DIR = stateDir;
  process.env.STRABO_CACHE_DIR = stateDir;
});

after(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const config: StraboConfig = {
  workspaceRoot: path.join(fixtures, 'sample-repo'),
  scanCeiling: fixtures,
};

function tinyGraph(): Graph {
  return {
    nodes: [
      { id: 'src/b.ts', kind: 'module', directory: 'src' },
      { id: 'src/a.ts', kind: 'module', directory: 'src' },
    ],
    edges: [
      {
        source: 'src/a.ts',
        target: 'src/b.ts',
        kind: 'import',
        evidence: { line: 1, specifier: './b', resolution: 'exact' },
      },
      {
        source: 'src/b.ts',
        target: 'src/a.ts',
        kind: 're-export',
        role: 'declare',
        evidence: { line: 1, specifier: './a', resolution: 'exact' },
      },
    ],
    diagnostics: [],
    excluded: [],
  };
}

test('exportGraph json is deterministic and drops declare edges by default', () => {
  const body = exportGraph(tinyGraph(), {
    format: 'json',
    fingerprint: 'abc1234:deadbeef',
    revision: 'abc1234',
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
  const parsed = JSON.parse(body) as {
    version: string;
    nodes: Array<{ id: string }>;
    edges: unknown[];
    revision: string;
    fingerprint: string;
  };
  assert.equal(parsed.version, 'strabo-export-1');
  assert.deepEqual(parsed.nodes.map((node) => node.id), ['src/a.ts', 'src/b.ts']);
  assert.equal(parsed.edges.length, 1);
  assert.equal(parsed.revision, 'abc1234');
  assert.equal(parsed.fingerprint, 'abc1234:deadbeef');
});

test('exportGraph includeDeclare draws declare edges and marks them dashed', () => {
  const graph = tinyGraph();
  const dot = exportGraph(graph, { format: 'dot', includeDeclare: true });
  assert.match(dot, /"src\/a\.ts" -> "src\/b\.ts"/);
  assert.match(dot, /"src\/b\.ts" -> "src\/a\.ts" \[style=dashed\]/);

  const mermaid = exportGraph(graph, { format: 'mermaid', includeDeclare: true });
  assert.match(mermaid, /graph TD/);
  assert.match(mermaid, /"src\/b\.ts" -\.-> "src\/a\.ts"/);

  const without = exportGraph(graph, { format: 'mermaid' });
  assert.doesNotMatch(without, /-\.->/);
});

test('renderViewModelSvg embeds labels, a legend, and a fingerprint caption', () => {
  const model: ViewModel = {
    repository: { name: 'demo', root: '/demo', head: null, dirty: false, gitUrl: null },
    nodes: [
      {
        id: 'src/a.ts',
        kind: 'module',
        directory: 'src',
        label: 'a.ts',
        workspacePath: 'demo/src/a.ts',
        fanIn: 0,
        fanOut: 1,
        transitiveDependencies: 1,
        transitiveDependents: 0,
      },
      {
        id: 'src/b.ts',
        kind: 'module',
        directory: 'src',
        label: 'b.ts',
        workspacePath: 'demo/src/b.ts',
        fanIn: 1,
        fanOut: 0,
        transitiveDependencies: 0,
        transitiveDependents: 1,
      },
    ],
    edges: [
      {
        source: 'src/a.ts',
        target: 'src/b.ts',
        kind: 'import',
        evidence: { line: 1, specifier: './b', resolution: 'exact' },
        semanticSource: 'src/a.ts',
        semanticTarget: 'src/b.ts',
      },
    ],
    positions: [
      { id: 'src/a.ts', x: 0, y: 0 },
      { id: 'src/b.ts', x: 100, y: 0 },
    ],
    hubs: [],
    diagnostics: [],
    excluded: [],
    cache: {
      status: 'memory',
      fingerprint: 'abc1234:deadbeef',
      artifactVersion: 'v',
      generatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  const svg = renderViewModelSvg(model, { title: 'demo', generatedAt: '2026-01-01T00:00:00.000Z' });
  assert.match(svg, /^<svg/);
  assert.match(svg, /a\.ts/);
  assert.match(svg, /indexed at abc1234/);
  assert.match(svg, /module/);
});

test('baseline round-trips through disk', () => {
  const file = path.join(stateDir, 'baseline.json');
  writeBaseline(file, {
    version: 1,
    repository: 'sample-repo',
    revision: null,
    fingerprint: null,
    generatedAt: '2026-01-01T00:00:00.000Z',
    findings: ['cycles:src/cycle-a.ts'],
    healthScore: 80,
  });
  const read = readBaseline(file);
  assert.equal(read?.healthScore, 80);
  assert.deepEqual(read?.findings, ['cycles:src/cycle-a.ts']);
  assert.equal(readBaseline(path.join(stateDir, 'missing.json')), null);
});

test('computeFreshness reports stale and no revision outside git', async () => {
  const freshness = await computeFreshness(stateDir, 'abc1234:deadbeef', '2026-01-01T00:00:00.000Z');
  assert.equal(freshness.indexed.revision, 'abc1234');
  assert.equal(freshness.current.fingerprint, null);
  assert.equal(freshness.behind, null);
  assert.equal(freshness.stale, true);
});

test('runCheck finds the fixture cycle and passes once it is baselined', async () => {
  const baselineFile = path.join(stateDir, 'sample-baseline.json');
  const baseline = await buildBaseline({ workspaceRoot: config.workspaceRoot, scanCeiling: fixtures });
  assert.ok(baseline.findings.some((key) => key.startsWith('cycles:')));

  const failing = await runCheck({
    workspaceRoot: config.workspaceRoot,
    scanCeiling: fixtures,
    rules: ['cycles'],
  });
  assert.equal(failing.passed, false);
  assert.equal(failing.findings.length, 1);
  assert.equal(failing.findings[0]?.rule, 'cycles');

  const passing = await runCheck({
    workspaceRoot: config.workspaceRoot,
    scanCeiling: fixtures,
    rules: ['cycles'],
    baseline,
  });
  assert.equal(passing.passed, true);
  assert.equal(passing.baselined.length, 1);
  assert.ok(baselineFile.length > 0);
  assert.equal(defaultBaselinePath(config.workspaceRoot).endsWith('.json'), true);
});

test('runCheck warns rather than failing when no rules are enabled', async () => {
  const result = await runCheck({ workspaceRoot: config.workspaceRoot, scanCeiling: fixtures });
  assert.equal(result.passed, true);
  assert.ok(result.warnings.some((warning) => warning.rule === 'check'));
});

test('the in-process dispatch reuses the router handlers', async () => {
  const dispatch = createApiDispatch(config);

  const cycles = await dispatch('GET', '/analysis/cycles');
  assert.equal(cycles.status, 200);
  assert.ok(Array.isArray(cycles.body));

  const pathResult = await dispatch(
    'GET',
    '/analysis/dependency-path?from=src%2Fcycle-a.ts&to=src%2Fcycle-b.ts',
  );
  assert.equal(pathResult.status, 200);
  const body = pathResult.body as { found: boolean; path: string[] };
  assert.equal(body.found, true);
  assert.deepEqual(body.path, ['src/cycle-a.ts', 'src/cycle-b.ts']);

  const status = await dispatch('GET', '/status');
  assert.equal(status.status, 200);
  assert.ok('stale' in (status.body as object));

  const missing = await dispatch('GET', '/nope');
  assert.equal(missing.status, 404);
});

test('the export route serves json, dot, and svg', async () => {
  const dispatch = createApiDispatch(config);
  const json = await dispatch('GET', '/export?format=json');
  assert.equal(json.status, 200);
  assert.ok(typeof json.body === 'string');

  const svg = await dispatch('GET', '/export?format=svg&view=system');
  assert.equal(svg.status, 200);
  assert.match(svg.body as string, /<svg/);

  const bad = await dispatch('GET', '/export?format=exe');
  assert.equal(bad.status, 400);
});

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

async function toolText(
  handler: { handle: (message: unknown) => Promise<unknown | null> },
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const response = (await handler.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })) as { result?: { content: Array<{ text: string }> } };
  return response.result?.content[0]?.text ?? '';
}

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



test('exportSite writes an index and one page per repository', async () => {
  const outDir = path.join(stateDir, 'site');
  const pages = await exportSite({
    workspaceRoot: config.workspaceRoot,
    scanCeiling: fixtures,
    outDir,
    repositories: [config.workspaceRoot],
    generatedAt: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.name, 'sample-repo');
  assert.ok(fs.existsSync(path.join(outDir, 'index.html')));
  assert.ok(fs.existsSync(path.join(outDir, 'sample-repo', 'index.html')));
  assert.ok(fs.existsSync(path.join(outDir, 'sample-repo', 'map.svg')));
  assert.ok(fs.existsSync(path.join(outDir, 'sample-repo', 'map.mmd')));
  assert.ok(fs.existsSync(path.join(outDir, 'sample-repo', 'map.json')));
});
