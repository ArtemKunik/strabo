import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import express from 'express';

import {
  buildRepositoryReport,
  computeMeasuredCoverage,
  createStraboRouter,
  renderReportMarkdown,
  scanRepository,
  suggestionFor,
  type Graph,
  type HotspotReport,
  type OwnershipContext,
  type RepositoryReportInputs,
  type RepositoryReportDocument,
  type RiskReport,
  type SmellsReport,
} from '../../src/index.ts';
import { createSettingsStore } from '../../src/state/settings-store.ts';

const created: string[] = [];
const servers: Array<ReturnType<typeof express.application.listen>> = [];

after(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const directory of created) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // Windows may hold a transient handle on a just-scanned directory; leaving a temp
      // directory behind is not a test failure.
    }
  }
});

function graph(): Graph {
  return {
    nodes: [
      { id: 'test.ts', kind: 'test', directory: '.' },
      { id: 'a.ts', kind: 'module', directory: '.' },
      { id: 'b.ts', kind: 'module', directory: '.' },
      { id: 'c.ts', kind: 'module', directory: '.' },
      { id: 'orphan.ts', kind: 'module', directory: '.' },
    ],
    edges: [
      { source: 'test.ts', target: 'a.ts', kind: 'import', evidence: { line: 1, specifier: './a', resolution: 'exact' } },
      { source: 'a.ts', target: 'b.ts', kind: 'import', evidence: { line: 1, specifier: './b', resolution: 'exact' } },
      { source: 'b.ts', target: 'a.ts', kind: 'import', evidence: { line: 1, specifier: './a', resolution: 'exact' } },
      // c.ts is not reachable from a test, and it depends on orphan.ts.
      { source: 'c.ts', target: 'orphan.ts', kind: 'import', evidence: { line: 1, specifier: './orphan', resolution: 'exact' } },
    ],
    diagnostics: [
      { file: 'c.ts', line: 9, message: 'unterminated string', severity: 'error', kind: 'parse-failure' },
    ],
    excluded: [{ path: 'dist/app.js', reason: 'build' }],
  };
}

function smells(): SmellsReport {
  return {
    repository: 'demo',
    files: [
      {
        file: 'b.ts',
        smells: [{ rule: 'god-module', detail: 'wide interface', inputs: { members: 12 } }],
      },
      // `cyclic` must not double-count the cycle group.
      {
        file: 'a.ts',
        smells: [{ rule: 'cyclic', detail: 'in a cycle', inputs: {} }],
      },
    ],
    summary: { 'god-module': 1, cyclic: 1 } as SmellsReport['summary'],
  };
}

function hotspots(): HotspotReport {
  return {
    available: true,
    filesScanned: 5,
    filesSkipped: 0,
    functionsExamined: 7,
    hotspots: [
      {
        file: 'a.ts',
        owner: 'A',
        name: 'run',
        line: 4,
        decisionPoints: 12,
        lines: 60,
        signals: [
          { kind: 'high-complexity', line: 4, detail: 'decision points 12' },
          { kind: 'long-function', line: 4, detail: '60 lines' },
        ],
      },
    ],
  };
}

function ownership(): OwnershipContext[] {
  return [
    { file: 'a.ts', distinctAuthors: 1, commits: 4, transitiveDependents: 3 },
    { file: 'b.ts', distinctAuthors: 2, commits: 4, transitiveDependents: 2 },
  ];
}

function risk(): RiskReport {
  return {
    available: true,
    online: true,
    inventory: { total: 1, byEcosystem: { npm: 1 }, undeclared: [] },
    advisories: [
      {
        id: 'GHSA-1234',
        aliases: [],
        summary: 'Prototype pollution',
        severity: 'high',
        fixed: ['2.0.0'],
        url: 'https://osv.dev/GHSA-1234',
        dependency: { ecosystem: 'npm', name: 'lodash', version: '1.0.0' },
        importedBy: ['a.ts'],
        impactedFiles: [],
      },
    ],
    licenses: [],
    imports: [],
    summary: { low: 0, moderate: 0, high: 1, critical: 0, unknown: 0, deniedLicenses: 0 },
    caveats: [],
  };
}

function inputs(overrides: Partial<RepositoryReportInputs> = {}): RepositoryReportInputs {
  return {
    repository: 'demo',
    root: '/repo',
    graph: graph(),
    extensionCounts: { '.ts': 5 },
    revision: { head: 'abc1234', fingerprint: 'abc1234:deadbeef', scannedAt: '2026-01-01T00:00:00.000Z', stale: false },
    smells: smells(),
    hotspots: hotspots(),
    ownership: ownership(),
    risk: risk(),
    generatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

test('buildRepositoryReport projects every analysis into one ranked pain-point list', () => {
  const document = buildRepositoryReport(inputs());

  const kinds = document.painPoints.map((point) => point.kind);
  assert.ok(kinds.includes('cycle'), 'the cycle is a pain point');
  assert.ok(kinds.includes('untested-reach'), 'the unreached dependency is a pain point');
  assert.ok(kinds.includes('god-module'));
  assert.ok(kinds.includes('hotspot'));
  assert.ok(kinds.includes('bus-factor'));
  assert.ok(kinds.includes('advisory'));
  assert.ok(kinds.includes('parse-failure'));

  // `cyclic` is not repeated per file; the cycle group is the one cycle point.
  assert.equal(document.painPoints.filter((point) => point.kind === 'cycle').length, 1);

  // Sorted by fixed severity first.
  assert.equal(document.painPoints[0]?.severity, 'critical');
  assert.deepEqual(document.painPoints[0]?.location, ['a.ts', 'b.ts']);
  assert.equal(document.overview.size.files, 5);
  assert.equal(document.evidence.excluded, 1);
  assert.deepEqual(document.evidence.unavailable, []);
});

test('every pain point yields exactly one deterministic suggestion that cites it', () => {
  const document = buildRepositoryReport(inputs());
  assert.equal(document.suggestions.length, document.painPoints.length);
  for (const point of document.painPoints) {
    const suggestion = document.suggestions.find((entry) => entry.painPointId === point.id);
    assert.ok(suggestion, `a suggestion for ${point.id}`);
    assert.equal(suggestion?.id, `suggestion:${point.id}`);
    assert.ok((suggestion?.text.length ?? 0) > 0);
  }
});

test('the report is reproducible: two builds deep-equal and render the same Markdown', () => {
  const first = buildRepositoryReport(inputs());
  const second = buildRepositoryReport(inputs());
  assert.deepEqual(first, second);
  assert.equal(renderReportMarkdown(first), renderReportMarkdown(second));

  // The JSON document round-trips: rendering the parsed envelope is identical.
  const roundTripped = JSON.parse(JSON.stringify(first)) as RepositoryReportDocument;
  assert.equal(renderReportMarkdown(roundTripped), renderReportMarkdown(first));
});

test('renderReportMarkdown names the cycle and the suggestions', () => {
  const markdown = renderReportMarkdown(buildRepositoryReport(inputs()));
  assert.match(markdown, /^# Strabo repository report · demo/m);
  assert.match(markdown, /## Pain points \(/);
  assert.match(markdown, /### critical \(/);
  assert.match(markdown, /`cycle` .*`a\.ts`, `b\.ts`/);
  assert.match(markdown, /## Suggestions \(/);
  assert.match(markdown, /Break the cycle/);
});

test('a section the caller did not compute is named, never shown as empty', () => {
  const document = buildRepositoryReport(
    inputs({ smells: undefined, hotspots: undefined, ownership: undefined, risk: undefined }),
  );
  assert.deepEqual(document.evidence.unavailable.sort(), [
    'dependency risk was not computed',
    'function hotspots were not computed',
    'ownership history was not computed',
    'quality smells were not computed',
  ]);
  const markdown = renderReportMarkdown(document);
  assert.match(markdown, /Not computed: .*quality smells/);
});

test('pain points truncate to the limit and the evidence says so', () => {
  const document = buildRepositoryReport(inputs({ limits: { painPoints: 2 } }));
  assert.equal(document.painPoints.length, 2);
  assert.equal(document.suggestions.length, 2);
  assert.equal(document.evidence.truncated, true);
});

test('a stale graph is its own low-severity pain point', () => {
  const document = buildRepositoryReport(
    inputs({
      revision: { head: 'abc1234', fingerprint: 'abc1234:deadbeef', scannedAt: '2026-01-01T00:00:00.000Z', stale: true },
    }),
  );
  const stale = document.painPoints.find((point) => point.kind === 'stale-graph');
  assert.equal(stale?.severity, 'low');
  assert.match(renderReportMarkdown(document), /stale: older than the working tree/);
});

test('suggestionFor maps a cycle to an evidence-bound action', () => {
  const suggestion = suggestionFor({
    id: 'cycle:a+b',
    kind: 'cycle',
    severity: 'critical',
    location: ['a.ts', 'b.ts'],
    summary: '2 files form a dependency cycle',
    inputs: { size: 2 },
  });
  assert.match(suggestion.text, /`a\.ts`, `b\.ts`/);
});

test('GET /analysis/report serves JSON, Markdown, and HTML from one document', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-report-'));
  created.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a.ts';\nexport const b = a;\n");

  const host = express();
  host.use(express.json());
  host.use(
    '/api/strabo',
    createStraboRouter(
      { workspaceRoot: root, scanCeiling: root },
      undefined,
      createSettingsStore({ file: path.join(root, 'settings.json') }),
    ),
  );
  const base = await new Promise<string>((resolve) => {
    const server = host.listen(0, '127.0.0.1', () => {
      servers.push(server);
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

  const json = (await (await fetch(`${base}/api/strabo/analysis/report`)).json()) as {
    schema: string;
    repository: string;
    overview: { size: { files: number } };
  };
  assert.equal(json.schema, 'strabo-report-1');
  assert.equal(json.repository, path.basename(root));
  assert.equal(json.overview.size.files, 2);

  const markdown = await (await fetch(`${base}/api/strabo/analysis/report?format=md`)).text();
  assert.match(markdown, /^# Strabo repository report/m);
  assert.match(markdown, /## Overview/);

  const html = await (await fetch(`${base}/api/strabo/analysis/report?format=html`)).text();
  assert.match(html, /<!doctype html>/);
  assert.match(html, /Strabo repository report/);
});

test('with a measured report, the untested pain points use measured coverage (U2)', async () => {
  const fixture = path.resolve(import.meta.dirname, '..', 'fixtures', 'coverage-repo');
  const { graph } = await scanRepository(fixture);
  const coverage = await computeMeasuredCoverage(fixture, graph, {
    modifiedAt: () => '2024-06-01T00:00:00.000Z',
    lastCommitAt: async () => '2024-01-01T00:00:00.000Z',
  });
  const document = buildRepositoryReport({ repository: 'coverage', graph, coverage });

  // zero.ts is reached by a test, so reachability would not flag it; the report says 0%.
  const point = document.painPoints.find((entry) => entry.id === 'untested:src/zero.ts');
  assert.ok(point, 'the 0%-measured dependency is a pain point');
  assert.match(point.summary, /measured 0% line coverage/);
  assert.equal(point.inputs.measuredCoverage, 0);
  assert.match(suggestionFor(point).text, /measures 0% of its lines/);
  assert.equal(document.overview.untested.basis, 'measured');

  // Without a report the same graph has no untested dependency: both files are reached.
  const reachOnly = buildRepositoryReport({ repository: 'coverage', graph });
  assert.equal(reachOnly.painPoints.some((entry) => entry.kind === 'untested-reach'), false);
});
