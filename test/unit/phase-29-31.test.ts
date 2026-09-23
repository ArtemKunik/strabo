import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import express from 'express';

import { buildRepositoryReport, createStraboRouter } from '../../src/index.ts';
import type { DriftReport } from '../../src/index.ts';
import { renderReportMarkdown } from '../../src/index.ts';
import { parseDeclaredRuleIds, parseFailOnRules } from '../../src/check/check.ts';
import { createSettingsStore } from '../../src/state/settings-store.ts';

const created: string[] = [];
const servers: Array<ReturnType<typeof express.application.listen>> = [];

after(() => {
  for (const server of servers) {
    server.close();
  }
  for (const directory of created) {
    // A Windows file handle can outlive the test; cleanup is best-effort, never a failure.
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // leave the temp directory for the OS to reclaim
    }
  }
});

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(directory);
  return directory;
}

function write(root: string, relative: string, content: string): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      servers.push(server);
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

const drift: DriftReport = {
  available: true,
  repository: 'demo',
  base: null,
  points: [
    { revision: 'abc1234', short: 'abc1234', date: null, subject: null, measures: [] },
    { revision: 'def5678', short: 'def5678', date: null, subject: null, measures: [] },
  ],
  series: [
    {
      key: 'cycles',
      label: 'Cycles',
      points: [
        { revision: 'abc1234', value: 1 },
        { revision: 'def5678', value: 0 },
      ],
    },
  ],
};

test('the repository report renders a drift section from the series', () => {
  const document = buildRepositoryReport({
    repository: 'demo',
    graph: { nodes: [{ id: 'src/a.ts', kind: 'module', directory: 'src' }], edges: [], diagnostics: [], excluded: [] },
    drift,
  });
  const markdown = renderReportMarkdown(document);

  assert.match(markdown, /## Architecture drift/);
  assert.match(markdown, /Cycles: 1 → 0/);
});

test('a declared-rule id passes through --fail-on while the built-in alias is resolved', () => {
  assert.deepEqual(parseFailOnRules(['cycle,domain-no-infra']), ['cycles']);
  assert.deepEqual(parseDeclaredRuleIds(['cycle,domain-no-infra']), ['domain-no-infra']);
});

test('GET /analysis/rules reports the declared rules and their observed violations', async () => {
  const root = tempDir('strabo-phase-rules-');
  write(root, 'domain/a.ts', "import { b } from '../infra/b';\nexport const a = b;\n");
  write(root, 'infra/b.ts', 'export const b = 1;\n');
  write(
    root,
    'strabo.rules.yml',
    ['rules:', '  - id: domain-no-infra', '    from: domain/**', '    to: infra/**', '    allow: never', ''].join('\n'),
  );

  const app = express();
  app.use(express.json());
  app.use(
    '/api/strabo',
    createStraboRouter(
      { workspaceRoot: root, scanCeiling: root },
      undefined,
      createSettingsStore({ file: path.join(root, 'settings.json') }),
    ),
  );
  const base = await listen(app);

  const response = await fetch(`${base}/api/strabo/analysis/rules`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    available: boolean;
    rules: Array<{ id: string }>;
    violations: Array<{ rule: string; edge: { source: string; target: string } }>;
  };
  assert.equal(body.available, true);
  assert.equal(body.rules.length, 1);
  assert.equal(body.violations.length, 1);
  assert.equal(body.violations[0]?.rule, 'domain-no-infra');
  assert.equal(body.violations[0]?.edge.source, 'domain/a.ts');
  assert.equal(body.violations[0]?.edge.target, 'infra/b.ts');
});

test('the new analysis routes answer over HTTP', async () => {
  const root = tempDir('strabo-phase-routes-');
  write(root, 'src/a.ts', 'export function alpha() { return 1; }\n');
  write(root, 'src/b.ts', "import { alpha } from './a';\nexport const value = alpha();\n");

  const app = express();
  app.use(express.json());
  app.use(
    '/api/strabo',
    createStraboRouter(
      { workspaceRoot: root, scanCeiling: root },
      undefined,
      createSettingsStore({ file: path.join(root, 'settings.json') }),
    ),
  );
  const base = await listen(app);

  const edges = (await (await fetch(`${base}/api/strabo/analysis/string-edges`)).json()) as {
    totals: { env: number; routes: number; flags: number };
  };
  assert.equal(typeof edges.totals.env, 'number');

  const clones = (await (await fetch(`${base}/api/strabo/analysis/clones`)).json()) as {
    available: boolean;
    functionsHashed: number;
  };
  assert.equal(typeof clones.functionsHashed, 'number');
  assert.equal(typeof clones.available, 'boolean');

  const scope = await fetch(`${base}/api/strabo/analysis/scope-fence?expect=src/**`);
  assert.equal(scope.status, 200);

  const driftResponse = await fetch(`${base}/api/strabo/analysis/drift?limit=5`);
  assert.equal(driftResponse.status, 200);
  const driftBody = (await driftResponse.json()) as { available: boolean; reason?: string };
  assert.equal(driftBody.available, false);
  assert.equal(driftBody.reason, 'not-a-git-repository');
});
