import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTools } from '../../src/index.ts';
import type { McpTool, McpToolResult } from '../../src/mcp/tools.ts';

function text(result: McpToolResult): string {
  return result.content[0]?.text ?? '';
}

function tool(tools: McpTool[], name: string): McpTool {
  const found = tools.find((candidate) => candidate.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
}

test('get_dead_code pages the dead files, not every file with a smell', async () => {
  const smelly = Array.from({ length: 60 }, (_, index) => ({
    file: `src/smelly${String(index).padStart(2, '0')}.ts`,
    smells: [{ rule: 'god-file', detail: 'large' }],
  }));
  const dead = Array.from({ length: 3 }, (_, index) => ({
    file: `src/z-dead${index}.ts`,
    smells: [
      { rule: 'dead', detail: 'nothing imports it' },
      { rule: 'god-file', detail: 'large' },
    ],
  }));
  const dispatch = async () => ({ status: 200, body: { repository: 'demo', files: [...smelly, ...dead] } });
  const deadCode = tool(createTools(dispatch), 'get_dead_code');

  const all = JSON.parse(text(await deadCode.call({ limit: 2 }))) as {
    files: Array<{ file: string; smells: Array<{ rule: string }> }>;
    truncation: Array<{ total: number; nextOffset: number }>;
  };
  assert.deepEqual(all.files.map((entry) => entry.file), ['src/z-dead0.ts', 'src/z-dead1.ts']);
  assert.deepEqual(all.files[0]?.smells.map((smell) => smell.rule), ['dead']);
  assert.equal(all.truncation[0]?.total, 3);
  assert.equal(all.truncation[0]?.nextOffset, 2);

  const rest = JSON.parse(text(await deadCode.call({ limit: 2, offset: 2 }))) as { files: Array<{ file: string }> };
  assert.deepEqual(rest.files.map((entry) => entry.file), ['src/z-dead2.ts']);
});

test('get_dead_code reports an unavailable analysis as an error', async () => {
  const dispatch = async () => ({ status: 503, body: { error: 'scanning' } });
  const result = await tool(createTools(dispatch), 'get_dead_code').call({});
  assert.equal(result.isError, true);
});
