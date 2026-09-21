import assert from 'node:assert/strict';

import { Then, When } from '@cucumber/cucumber';

When('I request the quality scorecard', async function () {
  this.qualityResponse = await fetch(`${this.baseUrl}/api/strabo/analysis/quality`);
});

Then('the scorecard has a repository name', async function () {
  assert.equal(this.qualityResponse.ok, true, 'quality endpoint should respond');
  const body = await this.qualityResponse.json();
  assert.ok(body.repository, 'repository name should be present');
});

Then('the scorecard lists modules', async function () {
  const body = await this.qualityResponse.json();
  assert.ok(body.modules.length > 0, 'modules should be present');
});

Then('each module has complexity, shape, centrality, evolution, and protection measures', async function () {
  const body = await this.qualityResponse.json();
  for (const mod of body.modules) {
    assert.ok(mod.complexity, 'complexity should be present');
    assert.ok(mod.shape, 'shape should be present');
    assert.ok(mod.centrality, 'centrality should be present');
    assert.ok(mod.evolution, 'evolution should be present');
    assert.ok(mod.protection, 'protection should be present');
  }
});

Then('each measure group has percentiles for every measure', async function () {
  const body = await this.qualityResponse.json();
  for (const group of ['complexity', 'shape', 'centrality', 'evolution', 'protection']) {
    const entries = Object.entries(body.percentiles[group]);
    assert.ok(entries.length > 0, `${group} should have percentiles`);
    for (const [, p] of entries) {
      assert.ok(p.percentile >= 0 && p.percentile <= 100, `${group} percentile should be 0-100`);
    }
  }
});

Then('every percentile is between 0 and 100', async function () {
  const body = await this.qualityResponse.json();
  for (const group of Object.values(body.percentiles)) {
    for (const p of Object.values(group)) {
      assert.ok(p.percentile >= 0 && p.percentile <= 100, 'percentile should be 0-100');
    }
  }
});

When('I request the repository smells', async function () {
  this.smellsResponse = await fetch(`${this.baseUrl}/api/strabo/analysis/smells`);
});

Then('each module reports composite scores in 0-100', async function () {
  const body = await this.qualityResponse.json();
  for (const mod of body.modules) {
    for (const key of ['complexity', 'churn', 'hotspot', 'blastRadius', 'testReach', 'risk']) {
      const value = mod.scores?.[key];
      assert.equal(typeof value, 'number', `scores.${key} should be a number`);
      assert.ok(value >= 0 && value <= 100, `scores.${key} should be 0-100`);
    }
  }
});

Then('each module reports a hotspot and a risk', async function () {
  const body = await this.qualityResponse.json();
  for (const mod of body.modules) {
    assert.equal(typeof mod.scores.hotspot, 'number', 'hotspot should be a number');
    assert.equal(typeof mod.scores.risk, 'number', 'risk should be a number');
  }
});

Then('the smells report lists files with a rule summary', async function () {
  assert.equal(this.smellsResponse.ok, true, 'smells endpoint should respond');
  const body = await this.smellsResponse.json();
  assert.ok(Array.isArray(body.files), 'files should be an array');
  assert.ok(body.summary && typeof body.summary === 'object', 'summary should be present');
});

Then('each smell names a rule and its inputs', async function () {
  const body = await this.smellsResponse.json();
  for (const entry of body.files) {
    assert.ok(entry.file, 'each entry should name a file');
    for (const smell of entry.smells) {
      assert.ok(smell.rule, 'each smell should name a rule');
      assert.ok(smell.inputs && typeof smell.inputs === 'object', 'each smell should carry inputs');
    }
  }
});
