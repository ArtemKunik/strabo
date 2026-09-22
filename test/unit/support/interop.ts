import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Graph, StraboConfig } from '../../../src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixtures = path.resolve(here, '..', '..', 'fixtures');
export const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-interop-'));

before(() => {
  process.env.STRABO_STATE_DIR = stateDir;
  process.env.STRABO_CACHE_DIR = stateDir;
});

after(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

export const config: StraboConfig = {
  workspaceRoot: path.join(fixtures, 'sample-repo'),
  scanCeiling: fixtures,
};

export function tinyGraph(): Graph {
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

export async function toolText(
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
