import assert from 'node:assert/strict';
import path from 'node:path';

import { Then, When } from '@cucumber/cucumber';

When('I request the risk report for the {string} fixture', async function (name) {
  const repository = path.resolve('test/fixtures', name);
  const response = await fetch(
    `${this.baseUrl}/api/strabo/analysis/risk?repository=${encodeURIComponent(repository)}`,
  );
  assert.equal(response.ok, true, `risk endpoint responded ${response.status}`);
  this.riskReport = await response.json();
});

Then('the risk report lists the lodash dependency', function () {
  assert.equal(this.riskReport?.available, true);
  assert.ok(
    (this.riskReport.inventory?.total ?? 0) >= 1,
    'the report should count at least one dependency',
  );
});

Then('the risk report maps lodash to the file that imports it', function () {
  const lodash = this.riskReport?.imports?.find((entry) => entry.package === 'lodash');
  assert.ok(lodash, 'lodash should appear in the import index');
  assert.equal(lodash.declared, true);
  assert.deepEqual(lodash.files, ['src/a.ts']);
});

Then('the risk report reports undeclared imports', function () {
  assert.ok(
    (this.riskReport?.inventory?.undeclared ?? []).includes('left-pad'),
    'left-pad is imported but not declared, so it should be reported as undeclared',
  );
});

Then('the risk report reports that online lookup is disabled', function () {
  assert.equal(this.riskReport?.online, false);
  assert.ok(
    (this.riskReport?.caveats ?? []).some((entry) => /disabled/i.test(entry)),
    'the report should say online lookup is disabled',
  );
});
