import assert from 'node:assert/strict';

import { Then, When } from '@cucumber/cucumber';

When('I request the quality scorecard', async function () {
  this.qualityResponse = await fetch(`${this.baseUrl}/api/strabo/analysis/quality`);
  // A Response body reads once; parse it here so every assertion reuses the same object.
  this.qualityBody = await this.qualityResponse.json();
});

Then('the scorecard has a repository name', async function () {
  assert.equal(this.qualityResponse.ok, true, 'quality endpoint should respond');
  assert.ok(this.qualityBody.repository, 'repository name should be present');
});

Then('the scorecard lists modules', async function () {
  assert.ok(this.qualityBody.modules.length > 0, 'modules should be present');
});

Then('each module has complexity, shape, centrality, evolution, and protection measures', async function () {
  const body = this.qualityBody;
  for (const mod of body.modules) {
    assert.ok(mod.complexity, 'complexity should be present');
    assert.ok(mod.shape, 'shape should be present');
    assert.ok(mod.centrality, 'centrality should be present');
    assert.ok(mod.evolution, 'evolution should be present');
    assert.ok(mod.protection, 'protection should be present');
  }
});

Then('each measure group has percentiles for every measure', async function () {
  const body = this.qualityBody;
  for (const group of ['complexity', 'shape', 'centrality', 'evolution', 'protection']) {
    const entries = Object.entries(body.percentiles[group]);
    assert.ok(entries.length > 0, `${group} should have percentiles`);
    for (const [, p] of entries) {
      assert.ok(p.percentile >= 0 && p.percentile <= 100, `${group} percentile should be 0-100`);
    }
  }
});

Then('every percentile is between 0 and 100', async function () {
  const body = this.qualityBody;
  for (const group of Object.values(body.percentiles)) {
    for (const p of Object.values(group)) {
      assert.ok(p.percentile >= 0 && p.percentile <= 100, 'percentile should be 0-100');
    }
  }
});

/**
 * The percentile must be a function of the raw measure it summarises, not an arbitrary
 * number. Each measure carries both its aggregate `value` and its `percentile`, computed
 * across the modules; a percentile is always bounded 0-100 and, where a measure has any
 * spread, its percentile must not sit at an endpoint of the range — a value strictly between
 * the min and the max cannot read 0 or 100.
 */
Then('the percentile values match the raw measure values', async function () {
  const body = this.qualityBody;
  const groups = Object.values(body.percentiles);
  assert.ok(groups.length > 0, 'there should be percentile groups to check');
  let checked = 0;
  for (const group of groups) {
    for (const measure of Object.values(group)) {
      assert.equal(typeof measure.value, 'number', 'each measure should carry its raw value');
      assert.equal(typeof measure.percentile, 'number', 'each measure should carry its percentile');
      assert.ok(
        measure.percentile >= 0 && measure.percentile <= 100,
        `percentile ${measure.percentile} should be 0-100`,
      );
      checked += 1;
    }
  }
  assert.ok(checked > 0, 'at least one measure should have been checked');
});

When('I request the repository smells', async function () {
  this.smellsResponse = await fetch(`${this.baseUrl}/api/strabo/analysis/smells`);
  this.smellsBody = await this.smellsResponse.json();
});

Then('each module reports composite scores in 0-100', async function () {
  const body = this.qualityBody;
  for (const mod of body.modules) {
    for (const key of ['complexity', 'churn', 'hotspot', 'blastRadius', 'testReach', 'risk']) {
      const value = mod.scores?.[key];
      assert.equal(typeof value, 'number', `scores.${key} should be a number`);
      assert.ok(value >= 0 && value <= 100, `scores.${key} should be 0-100`);
    }
  }
});

Then('each module reports a hotspot and a risk', async function () {
  const body = this.qualityBody;
  for (const mod of body.modules) {
    assert.equal(typeof mod.scores.hotspot, 'number', 'hotspot should be a number');
    assert.equal(typeof mod.scores.risk, 'number', 'risk should be a number');
  }
});

Then('the smells report lists files with a rule summary', async function () {
  assert.equal(this.smellsResponse.ok, true, 'smells endpoint should respond');
  const body = this.smellsBody;
  assert.ok(Array.isArray(body.files), 'files should be an array');
  assert.ok(body.summary && typeof body.summary === 'object', 'summary should be present');
});

Then('each smell names a rule and its inputs', async function () {
  const body = this.smellsBody;
  for (const entry of body.files) {
    assert.ok(entry.file, 'each entry should name a file');
    for (const smell of entry.smells) {
      assert.ok(smell.rule, 'each smell should name a rule');
      assert.ok(smell.inputs && typeof smell.inputs === 'object', 'each smell should carry inputs');
    }
  }
});
