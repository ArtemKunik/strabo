import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { buildTierReport } from '../../src/analysis/tiers.ts';
import { buildTierDataFlow, scanRepository } from '../../src/index.ts';
import { analyzeRepository } from '../../src/workspace/analyze.ts';

const root = path.resolve('test/fixtures/structure-data-flow-repo');
const repository = 'structure-data-flow-repo';

test('the data-flow fixture reads one hub written in domain and read in data', async () => {
  const { graph } = await scanRepository(root);
  const report = buildTierReport(root, repository, graph);
  const data = await analyzeRepository(repository, root, {});
  const flow = buildTierDataFlow(report, data, { repository });

  assert.equal(flow.hubs.length, 1);
  const hub = flow.hubs[0];
  assert.equal(hub?.label, 'orders');
  assert.equal(hub?.kind, 'table');
  const hubId = hub?.id;
  assert.ok(hubId);

  const writes = flow.edges.find((edge) => edge.direction === 'writes');
  const reads = flow.edges.find((edge) => edge.direction === 'reads');
  assert.equal(writes?.source, 'domain');
  assert.equal(writes?.target, hubId);
  assert.equal(reads?.source, hubId);
  assert.equal(reads?.target, 'data');

  assert.deepEqual(flow.pairs.map((pair) => `${pair.source}->${pair.target}`), ['domain->data']);
  assert.equal(flow.summary.uncontracted, 1);
});
