import assert from 'node:assert/strict';

import { Then, When } from '@cucumber/cucumber';

When('I right-click the {string} node', async function (id) {
  const point = await this.nodeCenter(id);
  await this.page.mouse.click(point.x, point.y, { button: 'right' });
  await this.page.waitForFunction(() => document.querySelector('.agent-menu:not([hidden])') != null);
});

When('I choose the menu entry {string}', async function (label) {
  const entry = this.page.locator('.agent-menu:not([hidden]) .agent-menu-item', { hasText: label });
  await entry.first().click();
});

When('I plan extracting {string} in the sandbox', async function (include) {
  await this.page.evaluate((value) => window.straboTest.planExtraction(value), include);
  await this.page.waitForSelector('#sandbox-panel [data-role="sandbox-plan-results"]', { timeout: 15_000 });
});

Then('the sandbox labels its answer hypothetical', async function () {
  await this.page.waitForSelector('#sandbox-panel .sandbox-hypothetical', { timeout: 15_000 });
  const text = (await this.page.textContent('#sandbox-panel .sandbox-hypothetical')) ?? '';
  assert.match(text, /Hypothetical/);
});

Then('the sandbox reports a cycle introduced through {string} and {string}', async function (a, b) {
  const text = (await this.page.textContent('#sandbox-panel [data-role="sandbox-cycles-introduced"]')) ?? '';
  assert.ok(text.includes(a) && text.includes(b), `expected a cycle through ${a} and ${b}, got: ${text}`);
});

Then('the {string} node is ringed as a cycle', async function (id) {
  const ringed = await this.page.evaluate(
    (nodeId) => window.straboTest.cy.getElementById(nodeId).hasClass('ov-cycle'),
    id,
  );
  assert.equal(ringed, true);
});

Then('the sandbox lists {string} as an outside import', async function (file) {
  const text = (await this.page.textContent('#sandbox-panel [data-role="sandbox-dependencies"]')) ?? '';
  assert.ok(text.includes(file), `expected ${file} among outside imports, got: ${text}`);
});

Then('the sandbox lists {string} as imported from outside', async function (file) {
  const text = (await this.page.textContent('#sandbox-panel [data-role="sandbox-dependents"]')) ?? '';
  assert.ok(text.includes(file), `expected ${file} among dependents, got: ${text}`);
});
