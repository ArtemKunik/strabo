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
  type MeasuredCoverageSummary,
  type RepositoryCoverageSection,
  type RepositoryStructureSection,
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

function coverageSummary(): MeasuredCoverageSummary {
  return {
    available: true,
    basis: 'measured',
    format: 'lcov',
    reportPath: 'coverage/lcov.info',
    reportModified: '2026-01-01T00:00:00.000Z',
    reportAgeMs: 60000,
    skipped: [],
    outOfGraph: [],
    files: [
      {
        rawPath: 'a.ts',
        file: 'a.ts',
        inGraph: true,
        linesFound: 20,
        linesHit: 17,
        lineCoverage: 85,
        functions: [],
        functionsFound: 2,
        functionsHit: 2,
        lastCommit: '2026-01-01T00:00:00.000Z',
        stale: false,
      },
    ],
    stale: [],
    summary: {
      filesMeasured: 1,
      linesFound: 20,
      linesHit: 17,
      lineCoverage: 85,
    },
  };
}

function structureReport(): RepositoryStructureSection {
  return {
    tierFlow: {
      tiers: ['frontend', 'api', 'domain'],
      edges: [
        {
          source: 'frontend',
          target: 'api',
          kind: 'down',
          weight: 5,
          crossUnit: 0,
          units: ['root'],
        },
      ],
      intraByTier: [{ tier: 'frontend', weight: 2 }],
      total: 7,
      intraRatio: 0.286,
    },
    shelf: [{ tier: 'tests', files: 1, lines: 10, mixed: 0 }],
    summary: {
      classified: 4,
      unclassified: 1,
      mixed: 0,
    },
    directions: [],
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
    data: dataReport(),
    contracts: contractsReport(),
    structure: structureReport(),
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

function dataReport(): RepositoryReportInputs['data'] {
  const dataset = (id: string, label: string) => ({
    id,
    repository: 'demo',
    label,
    kind: 'table' as const,
    columns: [],
  });
  return {
    datasets: [dataset('db:demo/orders', 'orders')],
    edges: [],
    model: { datasets: [], entities: [], relationships: [], findings: [], gaps: [] } as never,
    contracts: [],
    shapeTwins: [],
    events: [],
    eventContracts: [],
    products: [
      {
        id: 'datacontract:demo:revenue',
        name: 'revenue',
        format: 'datacontract',
        repository: 'demo',
        source: 'datacontract.yaml',
        owner: 'data-team',
        outputPorts: [{ dataset: 'db:demo/orders', fields: [], contract: null }],
        inputPorts: [],
        contracts: [],
        classification: [],
      } as never,
    ],
    candidates: [],
    conformance: [
      {
        contract: 'datacontract:demo:revenue',
        dataset: 'db:demo/orders',
        repository: 'demo',
        kind: 'missing',
        field: 'region',
        detail: 'declared but not recorded',
        contractEvidence: { file: 'datacontract.yaml' },
      } as never,
    ],
    lineage: [],
    classifications: [],
    catalogs: [],
    dbt: [],
    summary: {
      datasets: 1,
      tables: 1,
      topics: 0,
      contracts: 0,
      products: 1,
      candidates: 0,
      conformance: 1,
      lineage: 0,
      modeled: true,
    },
    unavailable: [],
  };
}

function contractsReport(): RepositoryReportInputs['contracts'] {
  return {
    definitions: [
      {
        id: 'Users#User',
        bareId: 'User',
        qualifiedId: 'api.yaml#/components/schemas/User',
        format: 'openapi',
        origin: 'declared',
        repository: 'demo',
        source: 'api.yaml',
        fields: [{ name: 'id', type: 'string', required: true }],
        fingerprint: 'aaa',
      },
    ],
    governedEdges: [
      {
        source: 'a.ts',
        target: 'b.ts',
        contract: 'Users#User',
        contractFormat: 'openapi',
        kind: 'data',
        repository: 'demo',
        dataset: 'db:demo/orders',
        sourceUnit: '.',
        targetUnit: '.',
        conformance: 'conforming',
        badge: '📜 User (openapi)',
        evidence: { repository: 'demo', file: 'a.ts', detail: 'shares governed dataset db:demo/users' },
      },
    ],
    uncontractedBoundaries: [
      {
        source: 'b.ts',
        target: 'c.ts',
        kind: 'data',
        dataset: 'db:demo/logs',
        sourceUnit: '.',
        targetUnit: '.',
        reason: 'shares dataset db:demo/logs across units with no governing contract',
        badge: '⚠️ uncontracted',
        evidence: { repository: 'demo', file: 'b.ts', detail: 'shares db:demo/logs' },
      },
    ],
    conformanceDeviations: [],
    orphanedContracts: [],
    unverifiedEdges: [],
    summary: {
      contracts: 1,
      declared: 1,
      dto: 0,
      governed: 1,
      uncontracted: 1,
      drifting: 0,
      orphaned: 0,
      unverified: 0,
    },
    unavailable: [],
  };
}

test('the data layer is a report section, and absent means named not empty', () => {
  const document = buildRepositoryReport(inputs({ data: dataReport() }));
  const section = document.data;
  assert.ok(section);
  assert.equal(section.datasets, 1);
  assert.equal(section.gaps.unconformant, 1);
  assert.equal(section.products[0]?.name, 'revenue');

  const markdown = renderReportMarkdown(document);
  assert.match(markdown, /## Data layer/);
  assert.match(markdown, /`revenue` — datacontract, 0 in, 1 out, owned by data-team/);
  assert.match(markdown, /conformance finding\(s\)/);

  const absent = buildRepositoryReport(inputs({ data: undefined }));
  assert.equal(absent.data, null);
  assert.ok(absent.evidence.unavailable.includes('the data layer was not computed'));
  assert.match(renderReportMarkdown(absent), /## Data layer\n- not included in this report/);
});

test('governed contract boundaries are a report section, and absent means named not empty', () => {
  const document = buildRepositoryReport(inputs({ contracts: contractsReport() }));
  const section = document.contracts;
  assert.ok(section);
  assert.equal(section.definitions[0]?.id, 'Users#User');
  assert.equal(section.definitions[0]?.origin, 'declared');
  assert.equal(section.gaps.governed, 1);
  assert.equal(section.gaps.uncontracted, 1);

  const markdown = renderReportMarkdown(document);
  assert.match(markdown, /## Contracts & Boundaries/);
  assert.match(markdown, /`Users#User` — openapi \(declared\)/);
  assert.match(markdown, /`a\.ts` → `b\.ts` — 📜 User \(openapi\) · conforming/);
  assert.match(markdown, /`b\.ts` → `c\.ts` — ⚠️ uncontracted/);

  const absent = buildRepositoryReport(inputs({ contracts: undefined }));
  assert.equal(absent.contracts, null);
  assert.ok(absent.evidence.unavailable.includes('contract boundaries were not computed'));
  assert.match(renderReportMarkdown(absent), /## Contracts & Boundaries\n- not included in this report/);
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

test('the coverage and structure sections are part of the report, and absent means named not empty', () => {
  const document = buildRepositoryReport(inputs({ coverage: coverageSummary() }));
  const cov = document.coverage;
  assert.ok(cov);
  assert.equal(cov.available, true);
  assert.equal(cov.basis, 'measured');
  assert.equal(cov.lineCoverage, 85);

  const struct = document.structure;
  assert.ok(struct);
  assert.equal(struct.summary.classified, 4);
  assert.equal(struct.tierFlow.tiers.length, 3);
  assert.equal(struct.tierFlow.edges.length, 1);
  // A precomputed section names no data-flow reading rather than showing an empty one.
  assert.equal(struct.dataFlow, null);

  const markdown = renderReportMarkdown(document);
  assert.match(markdown, /## Code coverage/);
  assert.match(markdown, /Line coverage: 85%/);
  assert.match(markdown, /## Logical structure/);
  assert.match(markdown, /`frontend` → `api`/);

  const absent = buildRepositoryReport(inputs({ structure: undefined }));
  assert.equal(absent.coverage, null);
  assert.equal(absent.structure, null);
  assert.ok(absent.evidence.unavailable.includes('logical structure was not computed'));

  const absentMd = renderReportMarkdown(absent);
  assert.match(absentMd, /## Code coverage\n- not included in this report/);
  assert.match(absentMd, /## Logical structure\n- not included in this report/);
});

test('the report carries the data-flow reading of the logical structure (Phase 37)', () => {
  const tierReport = {
    files: [
      { file: 'src/data/repo.ts', tier: 'data', mixed: false, evidence: [], lines: 1, tables: [] },
      { file: 'src/api/handler.ts', tier: 'api', mixed: false, evidence: [], lines: 1, tables: [] },
    ],
    tierFlow: { tiers: ['api', 'data'], edges: [], intraByTier: [], total: 0, intraRatio: 0 },
    shelf: [],
    summary: { total: 2, unclassified: 0, mixed: 0 },
    directions: [],
  } as never;
  const data = {
    ...(dataReport() as Record<string, unknown>),
    datasets: [{ id: 'db:demo/orders', kind: 'table', label: 'orders', repository: 'demo', strength: 'strong' }],
    edges: [
      { kind: 'writes', source: 'src/data/repo.ts', target: 'db:demo/orders', strength: 'strong', evidence: { repository: 'demo', file: 'src/data/repo.ts', line: 1 } },
      { kind: 'reads', source: 'src/api/handler.ts', target: 'db:demo/orders', strength: 'strong', evidence: { repository: 'demo', file: 'src/api/handler.ts', line: 2 } },
    ],
  } as never;

  const document = buildRepositoryReport(inputs({ structure: tierReport, data }));
  const dataFlow = document.structure?.dataFlow;
  assert.ok(dataFlow);
  assert.equal(dataFlow.writes, 1);
  assert.equal(dataFlow.reads, 1);
  assert.equal(dataFlow.hubs, 1);
  assert.equal(dataFlow.crossTier, 1);
  assert.deepEqual(dataFlow.pairs.map((pair) => `${pair.source}->${pair.target}`), ['data->api']);

  const markdown = renderReportMarkdown(document);
  assert.match(markdown, /Data flow: 1 write\(s\) · 1 read\(s\)/);
  assert.match(markdown, /`data` → `api`/);
});

test('coverage section when unavailable reports checked locations and commands', () => {
  const document = buildRepositoryReport(
    inputs({
      coverage: {
        available: false,
        basis: 'reachable',
        format: null,
        reportPath: null,
        reportModified: null,
        reportAgeMs: null,
        reason: 'no-report-found',
        detail: 'no coverage report was found inside the scan ceiling',
        skipped: [],
        outOfGraph: [],
        files: [],
        stale: [],
        summary: { filesMeasured: 0, linesFound: 0, linesHit: 0, lineCoverage: null },
      },
    }),
  );
  assert.ok(document.coverage);
  assert.equal(document.coverage.available, false);
  assert.ok(document.coverage.checkedLocations && document.coverage.checkedLocations.length > 0);
  const markdown = renderReportMarkdown(document);
  assert.match(markdown, /unavailable: no-report-found/);
  assert.match(markdown, /checked: `coverage\/lcov\.info`/);
});
