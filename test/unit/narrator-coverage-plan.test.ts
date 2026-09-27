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
  buildCoveragePlanRequest,
  COVERAGE_PLAN_EVIDENCE_LIMIT,
  COVERAGE_PLAN_GAP_LIMIT,
} from '../../src/narrator/coverage-plan.ts';
import type { CoverageGap, CoverageGapReport, MeasuredCoverageSummary } from '../../src/index.ts';

function gap(overrides: Partial<CoverageGap> = {}): CoverageGap {
  return {
    file: 'src/zero.ts',
    basis: 'measured',
    value: 0,
    linesHit: 0,
    linesFound: 2,
    reached: true,
    stale: false,
    dependents: 3,
    transitiveDependents: 9,
    cycleSize: 0,
    signals: 2,
    tests: ['src/zero.test.ts'],
    score: 55,
    ...overrides,
  };
}

function report(overrides: Partial<CoverageGapReport> = {}): CoverageGapReport {
  return { threshold: 50, basis: 'measured', total: 1, notInReport: 2, gaps: [gap()], ...overrides };
}

function measured(overrides: Partial<MeasuredCoverageSummary> = {}): MeasuredCoverageSummary {
  return {
    available: true,
    basis: 'measured',
    format: 'lcov',
    reportPath: 'coverage/lcov.info',
    reportModified: '2024-06-01T00:00:00.000Z',
    reportAgeMs: 3_600_000,
    skipped: [],
    outOfGraph: [],
    files: [],
    stale: [],
    summary: { filesMeasured: 1, linesFound: 2, linesHit: 0, lineCoverage: 0 },
    ...overrides,
  };
}

test('the coverage-plan instruction asks for a prioritised, evidence-only test plan', () => {
  const { instruction } = buildCoveragePlanRequest({ repository: 'coverage-repo', report: report() });
  assert.match(instruction, /prioritised test plan/);
  assert.match(instruction, /not recorded/);
  assert.match(instruction, /never as 0%/);
});

test('the coverage-plan evidence carries the gaps and the measured provenance', () => {
  const { evidence } = buildCoveragePlanRequest({
    repository: 'coverage-repo',
    report: report(),
    measured: measured(),
  });
  assert.match(evidence, /repository: coverage-repo/);
  assert.match(evidence, /coverage basis: measured \(lcov report coverage\/lcov\.info, 1h old\)/);
  assert.match(evidence, /under-covered threshold: 50%/);
  assert.match(evidence, /weak used files: 1/);
  assert.match(evidence, /used files the report does not name: 2/);
  assert.match(
    evidence,
    /- src\/zero\.ts: measured 0% of 2 line\(s\); 3 direct importer\(s\), 9 transitive dependent\(s\); 2 recorded function signal\(s\); 1 test\(s\) already reach it/,
  );
});

test('a reachability fallback and an empty gap list are stated, not invented', () => {
  const { evidence } = buildCoveragePlanRequest({
    repository: 'coverage-repo',
    report: report({ basis: 'reachable', total: 0, notInReport: 0, gaps: [] }),
    measured: measured({ available: false, basis: 'reachable', format: null, reportPath: null, reportModified: null, reportAgeMs: null }),
  });
  assert.match(evidence, /reachability fallback: no coverage report was found/);
  assert.match(evidence, /none recorded: no used file is under the threshold or unreached/);
  assert.doesNotMatch(evidence, /undefined|null/);
});

test('a gap list wider than the limit is truncated within the evidence budget', () => {
  const many = Array.from({ length: 400 }, (_, index) =>
    gap({ file: `src/file${String(index).padStart(3, '0')}.ts` }),
  );
  const { evidence } = buildCoveragePlanRequest({
    repository: 'coverage-repo',
    report: report({ total: many.length, gaps: many }),
  });
  assert.match(evidence, /further weak file\(s\) not listed/);
  assert.ok(
    evidence.split('\n').filter((line) => line.startsWith('- src/')).length <= COVERAGE_PLAN_GAP_LIMIT,
  );
  assert.ok(evidence.length <= COVERAGE_PLAN_EVIDENCE_LIMIT + 64, `evidence was ${evidence.length} chars`);
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

test('POST /narrator/coverage-plan is inert without a configured narrator', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-coverage-plan-'));
  created.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), "import { util } from './util';\nexport const x = util;\n");
  fs.writeFileSync(path.join(root, 'src', 'util.ts'), 'export const util = 1;\n');

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

  const response = await fetch(`${base}/api/strabo/narrator/coverage-plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);
  const reply = (await response.json()) as { available: boolean; reason?: string };
  assert.equal(reply.available, false);
  assert.equal(reply.reason, 'not-configured');
});
