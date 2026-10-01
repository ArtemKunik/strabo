import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTierDataFlow, hubLabelOf, type TierReport } from '../../src/index.ts';
import type { DataReport } from '../../src/types.ts';

/** A tier report carrying only the file-to-tier facts the flow reading reads. */
function tierReport(files: Array<{ file: string; tier: string }>): TierReport {
  return {
    files: files.map((entry) => ({
      file: entry.file,
      tier: entry.tier,
      mixed: false,
      evidence: [],
      lines: 1,
      tables: [],
    })),
  } as unknown as TierReport;
}

/** A data report with every section defaulted, so each test states only what it exercises. */
function dataReport(partial: Partial<DataReport>): DataReport {
  return {
    datasets: [],
    edges: [],
    model: { entities: [], findings: [] },
    contracts: [],
    shapeTwins: [],
    events: [],
    eventContracts: [],
    products: [],
    candidates: [],
    conformance: [],
    lineage: [],
    classifications: [],
    catalogs: [],
    dbt: [],
    summary: {
      datasets: 0,
      tables: 0,
      topics: 0,
      contracts: 0,
      products: 0,
      candidates: 0,
      conformance: 0,
      lineage: 0,
      modeled: true,
    },
    unavailable: [],
    ...partial,
  } as DataReport;
}

test('hubLabelOf reads the bare name from a qualified dataset id', () => {
  assert.equal(hubLabelOf('db:app/users'), 'users');
  assert.equal(hubLabelOf('topic:orders'), 'orders');
  assert.equal(hubLabelOf('path:out/result.parquet'), 'result.parquet');
  assert.equal(hubLabelOf('users'), 'users');
});

test('a write runs tier to hub and a read runs hub to tier, joined as a cross-tier pair', () => {
  const report = tierReport([
    { file: 'api/handler.ts', tier: 'api' },
    { file: 'data/repo.ts', tier: 'data' },
  ]);
  const data = dataReport({
    datasets: [{ id: 'db:app/users', kind: 'table', label: 'users', repository: 'app', strength: 'strong' }],
    edges: [
      { kind: 'writes', source: 'data/repo.ts', target: 'db:app/users', strength: 'strong', evidence: { repository: 'app', file: 'data/repo.ts', line: 3 } },
      { kind: 'reads', source: 'api/handler.ts', target: 'db:app/users', strength: 'strong', evidence: { repository: 'app', file: 'api/handler.ts', line: 7 } },
    ],
  });

  const flow = buildTierDataFlow(report, data, { repository: 'app' });
  assert.equal(flow.hubs.length, 1);
  assert.deepEqual(flow.hubs[0]?.tiers, ['api', 'data']);

  const write = flow.edges.find((edge) => edge.direction === 'writes');
  assert.equal(write?.source, 'data');
  assert.equal(write?.target, 'db:app/users');
  const read = flow.edges.find((edge) => edge.direction === 'reads');
  assert.equal(read?.source, 'db:app/users');
  assert.equal(read?.target, 'api');

  assert.deepEqual(flow.pairs.map((pair) => `${pair.source}->${pair.target}`), ['data->api']);
  assert.equal(flow.summary.crossTier, 1);
  assert.equal(flow.summary.reads, 1);
  assert.equal(flow.summary.writes, 1);
});

test('a topic write is named a produce and its read a consume', () => {
  const report = tierReport([
    { file: 'data/producer.ts', tier: 'data' },
    { file: 'integration/consumer.ts', tier: 'integration' },
  ]);
  const data = dataReport({
    datasets: [{ id: 'topic:events', kind: 'topic', label: 'events', repository: 'app', strength: 'strong' }],
    edges: [
      { kind: 'writes', source: 'data/producer.ts', target: 'topic:events', strength: 'strong', evidence: { repository: 'app', file: 'data/producer.ts', line: 1 } },
      { kind: 'reads', source: 'integration/consumer.ts', target: 'topic:events', strength: 'strong', evidence: { repository: 'app', file: 'integration/consumer.ts', line: 2 } },
    ],
  });

  const flow = buildTierDataFlow(report, data);
  assert.deepEqual(flow.edges.map((edge) => edge.direction).sort(), ['consumes', 'produces']);
  assert.deepEqual(flow.pairs.map((pair) => `${pair.source}->${pair.target}`), ['data->integration']);
});

test('dataset lineage becomes a hub-to-hub derive edge with no tier', () => {
  const report = tierReport([{ file: 'data/etl.ts', tier: 'data' }]);
  const data = dataReport({
    datasets: [
      { id: 'db:app/raw', kind: 'table', label: 'raw', repository: 'app', strength: 'strong' },
      { id: 'db:app/clean', kind: 'table', label: 'clean', repository: 'app', strength: 'strong' },
    ],
    lineage: [
      { source: 'db:app/raw', target: 'db:app/clean', strength: 'strong', evidence: { repository: 'app', file: 'etl.sql', line: 4 }, detail: 'insert … select' },
    ],
  });

  const flow = buildTierDataFlow(report, data);
  const derive = flow.edges.find((edge) => edge.direction === 'derives');
  assert.equal(derive?.tier, null);
  assert.equal(derive?.source, 'db:app/raw');
  assert.equal(derive?.target, 'db:app/clean');
  assert.equal(derive?.evidence[0]?.file, 'etl.sql');
});

test('a recorded governs edge and a conformance finding mark the hub governed and drifting', () => {
  const report = tierReport([{ file: 'api/h.ts', tier: 'api' }]);
  const data = dataReport({
    datasets: [{ id: 'db:app/users', kind: 'table', label: 'users', repository: 'app', strength: 'strong' }],
    edges: [
      { kind: 'reads', source: 'api/h.ts', target: 'db:app/users', strength: 'strong', evidence: { repository: 'app', file: 'api/h.ts', line: 1 } },
      { kind: 'governs', source: 'contract:User', target: 'db:app/users', strength: 'declared', evidence: null },
    ],
    conformance: [
      { contract: 'User', dataset: 'db:app/users', repository: 'app', kind: 'missing', field: 'email', detail: 'missing', contractEvidence: { file: 'user.proto' } },
    ],
  });

  const flow = buildTierDataFlow(report, data);
  assert.equal(flow.hubs[0]?.governed, true);
  assert.equal(flow.hubs[0]?.conformance, 'drifting');
  assert.equal(flow.summary.governed, 1);
  assert.equal(flow.summary.uncontracted, 0);
});

test('a hub written and read with no contract is counted uncontracted', () => {
  const report = tierReport([
    { file: 'api/h.ts', tier: 'api' },
    { file: 'data/r.ts', tier: 'data' },
  ]);
  const data = dataReport({
    datasets: [{ id: 'db:app/t', kind: 'table', label: 't', repository: 'app', strength: 'strong' }],
    edges: [
      { kind: 'writes', source: 'data/r.ts', target: 'db:app/t', strength: 'strong', evidence: { repository: 'app', file: 'data/r.ts', line: 1 } },
      { kind: 'reads', source: 'api/h.ts', target: 'db:app/t', strength: 'strong', evidence: { repository: 'app', file: 'api/h.ts', line: 1 } },
    ],
  });

  const flow = buildTierDataFlow(report, data);
  assert.equal(flow.summary.uncontracted, 1);
});

test('a data use from a file with no tier is a diagnostic, never a band edge', () => {
  const report = tierReport([{ file: 'api/h.ts', tier: 'api' }]);
  const data = dataReport({
    datasets: [{ id: 'db:app/t', kind: 'table', label: 't', repository: 'app', strength: 'strong' }],
    edges: [
      { kind: 'reads', source: 'misc/util.ts', target: 'db:app/t', strength: 'weak', evidence: { repository: 'app', file: 'misc/util.ts', line: 5 } },
    ],
  });

  const flow = buildTierDataFlow(report, data);
  assert.equal(flow.hubs.length, 0);
  assert.equal(flow.edges.length, 0);
  assert.equal(flow.summary.unclassified, 1);
  assert.equal(flow.diagnostics[0]?.kind, 'unclassified-file');
  assert.match(flow.diagnostics[0]?.detail ?? '', /misc\/util\.ts/);
});
