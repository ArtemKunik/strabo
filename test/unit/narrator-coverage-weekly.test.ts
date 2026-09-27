import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import express from 'express';

import { createStraboRouter } from '../../src/api/router.ts';
import { createSettingsStore } from '../../src/state/settings-store.ts';
import {
  buildCoverageWeeklyRequest,
  COVERAGE_WEEKLY_EVIDENCE_LIMIT,
} from '../../src/narrator/coverage-weekly.ts';
import type { CoverageTrendMeasure, CoverageTrendReport } from '../../src/index.ts';

function measures(untested: number, used: number, share: number, tests: number): CoverageTrendMeasure[] {
  return [
    { key: 'untested', label: 'Untested used files', value: untested },
    { key: 'used', label: 'Used files', value: used },
    { key: 'reach-share', label: 'Reached share (%)', value: share },
    { key: 'tests', label: 'Test files', value: tests },
  ];
}

function report(overrides: Partial<CoverageTrendReport> = {}): CoverageTrendReport {
  return {
    available: true,
    repository: 'coverage-repo',
    days: 7,
    points: [
      { revision: 'c3', short: 'c3c3c3c', date: '2026-09-27T00:00:00.000Z', subject: 'add tests', measures: measures(1, 3, 66.7, 1) },
      { revision: 'c1', short: 'c1c1c1c', date: '2026-09-20T00:00:00.000Z', subject: 'first import', measures: measures(1, 1, 0, 0) },
    ],
    deltas: [
      { key: 'untested', label: 'Untested used files', from: 1, to: 1, change: 0 },
      { key: 'used', label: 'Used files', from: 1, to: 3, change: 2 },
      { key: 'reach-share', label: 'Reached share (%)', from: 0, to: 66.7, change: 66.7 },
      { key: 'tests', label: 'Test files', from: 0, to: 1, change: 1 },
    ],
    ...overrides,
  };
}

test('the weekly instruction asks for a short, evidence-only trend summary', () => {
  const { instruction } = buildCoverageWeeklyRequest({ repository: 'coverage-repo', report: report() });
  assert.match(instruction, /weekly coverage summary/);
  assert.match(instruction, /static test reach at each commit/);
  assert.match(instruction, /not recorded/);
});

test('the weekly evidence carries the span and the movement per measure', () => {
  const { evidence } = buildCoverageWeeklyRequest({ repository: 'coverage-repo', report: report() });
  assert.match(evidence, /repository: coverage-repo/);
  assert.match(evidence, /window: last 7 day\(s\)/);
  assert.match(evidence, /revisions measured: 2/);
  assert.match(evidence, /span: c1c1c1c 2026-09-20T00:00:00\.000Z "first import" → c3c3c3c 2026-09-27T00:00:00\.000Z "add tests"/);
  assert.match(evidence, /- Used files: 1 → 3 \(\+2\)/);
  assert.match(evidence, /- Reached share \(%\): 0 → 66\.7 \(\+66\.7\)/);
  assert.match(evidence, /- Untested used files: 1 → 1 \(0\)/);
});

test('a window with no commits is stated rather than invented', () => {
  const empty = report({
    points: [],
    deltas: [
      { key: 'untested', label: 'Untested used files', from: null, to: null, change: null },
      { key: 'used', label: 'Used files', from: null, to: null, change: null },
      { key: 'reach-share', label: 'Reached share (%)', from: null, to: null, change: null },
      { key: 'tests', label: 'Test files', from: null, to: null, change: null },
    ],
  });
  const { evidence } = buildCoverageWeeklyRequest({ repository: 'coverage-repo', report: empty });
  assert.match(evidence, /span: none: no commit falls in the window/);
  assert.match(evidence, /- Used files: not recorded → not recorded \(not recorded\)/);
});

test('an unavailable trend names its reason', () => {
  const { evidence } = buildCoverageWeeklyRequest({
    repository: 'coverage-repo',
    report: report({ available: false, reason: 'not-a-git-repository', points: [], deltas: [] }),
  });
  assert.match(evidence, /coverage trend: not recorded \(not-a-git-repository\)/);
});

test('the weekly evidence stays within its budget and never leaks undefined', () => {
  const points = Array.from({ length: 100 }, (_, index) => ({
    revision: `r${index}`,
    short: `r${String(index).padStart(6, '0')}`,
    date: '2026-09-27T00:00:00.000Z',
    subject: 'x'.repeat(200),
    measures: measures(index, 100, 50, 3),
  }));
  const { evidence } = buildCoverageWeeklyRequest({ repository: 'coverage-repo', report: report({ points }) });
  assert.ok(evidence.length <= COVERAGE_WEEKLY_EVIDENCE_LIMIT + 64, `evidence was ${evidence.length} chars`);
  assert.doesNotMatch(evidence, /undefined|null/);
});

const created: string[] = [];
const servers: Array<ReturnType<typeof express.application.listen>> = [];

after(() => {
  for (const server of servers) {
    server.close();
  }
  for (const directory of created) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // The OS will reclaim the temp directory.
    }
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

test('POST /narrator/coverage-weekly is inert without a configured narrator', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-coverage-weekly-'));
  created.push(root);

  const host = express();
  host.use(express.json());
  host.use(
    '/api/strabo',
    createStraboRouter(
      { workspaceRoot: root, scanCeiling: root },
      undefined,
      createSettingsStore({ file: path.join(root, 'settings.json') }),
      { env: {} },
    ),
  );
  const base = await listen(host);

  const response = await fetch(`${base}/api/strabo/narrator/coverage-weekly`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);
  const reply = (await response.json()) as { available: boolean; reason?: string };
  assert.equal(reply.available, false);
  assert.equal(reply.reason, 'not-configured');
});
