import assert from 'node:assert/strict';

import { Then, When } from '@cucumber/cucumber';

When('I request the quality scorecard', async function () {
  this.qualityResponse = await fetch(`${this.baseUrl}/api/strabo/analysis/quality`);
});

Then('the scorecard has a repository name', async function () {
  assert.equal(this.qualityResponse.ok, true, 'quality endpoint should respond');
  const body = (await this.qualityResponse.json()) as { repository: string };
  assert.ok(body.repository, 'repository name should be present');
});

Then('the scorecard lists modules', async function () {
  const body = (await this.qualityResponse.json()) as { modules: unknown[] };
  assert.ok(body.modules.length > 0, 'modules should be present');
});

Then('each module has complexity, shape, centrality, evolution, and protection measures', async function () {
  const body = (await this.qualityResponse.json()) as { modules: Array<{ complexity: unknown; shape: unknown; centrality: unknown; evolution: unknown; protection: unknown }> };
  for (const mod of body.modules) {
    assert.ok(mod.complexity, 'complexity should be present');
    assert.ok(mod.shape, 'shape should be present');
    assert.ok(mod.centrality, 'centrality should be present');
    assert.ok(mod.evolution, 'evolution should be present');
    assert.ok(mod.protection, 'protection should be present');
  }
});

Then('each measure group has percentiles for every measure', async function () {
  const body = (await this.qualityResponse.json()) as { percentiles: { complexity: Record<string, { percentile: number }>; shape: Record<string, { percentile: number }>; centrality: Record<string, { percentile: number }>; evolution: Record<string, { percentile: number }>; protection: Record<string, { percentile: number }> } }>;
  for (const group of ['complexity', 'shape', 'centrality', 'evolution', 'protection'] as const) {
    const entries = Object.entries(body.percentiles[group]);
    assert.ok(entries.length > 0, `${group} should have percentiles`);
    for (const [, p] of entries) {
      assert.ok(p.percentile >= 0 && p.percentile <= 100, `${group} percentile should be 0-100`);
    }
  }
});

Then('every percentile is between 0 and 100', async function () {
  const body = (await this.qualityResponse.json()) as { percentiles: Record<string, Record<string, { percentile: number }>> };
  for (const group of Object.values(body.percentiles)) {
    for (const p of Object.values(group)) {
      assert.ok(p.percentile >= 0 && p.percentile <= 100, 'percentile should be 0-100');
    }
  }
});
