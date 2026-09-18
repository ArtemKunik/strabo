import assert from 'node:assert/strict';

import { Then, When } from '@cucumber/cucumber';

When('I hover the {string} node', async function (id) {
  const point = await this.nodeCenter(id);
  await this.page.mouse.move(point.x, point.y);
  await this.page.waitForFunction(
    (nodeId) => (document.getElementById('hover')?.textContent ?? '').includes(nodeId),
    id,
    { timeout: 15_000 },
  );
});

When('I clear the selection', async function () {
  await this.page.click('#tb-clear');
  await this.page.waitForFunction(() => document.getElementById('inspector')?.hidden === true);
});

When('I toggle boundaries', async function () {
  const before = await this.page.evaluate(() => ({
    mode: window.straboTest.state.mode,
    generation: window.straboTest.renderedGeneration(),
  }));
  await this.page.click('#tb-boundaries');
  await this.page.waitForFunction(
    (previous) =>
      window.straboTest.state.mode !== previous.mode &&
      window.straboTest.renderedGeneration() > previous.generation,
    before,
    { timeout: 20_000 },
  );
});

When('I click the tests strip entry for {string}', async function (name) {
  await this.page.locator(`#strip .strip-chip[data-filter="${name}/"]`).first().click();
  await this.page.waitForFunction(
    (value) => (document.getElementById('filter')?.value ?? '').includes(value),
    name,
  );
});

Then('the legend explains size, colour, and shape', async function () {
  const text = (await this.page.textContent('#legend')) ?? '';
  assert.match(text, /size = dependents/);
  assert.match(text, /colour = directory/);
  assert.match(text, /diamond = test/);
});

Then('the blast radius is reported for {string}', async function (id) {
  const text = (await this.page.textContent('#hover')) ?? '';
  assert.ok(text.includes(id), `hover "${text}" should mention "${id}"`);
  assert.match(text, /blast radius \d+/);
});

Then('the inspector is hidden', async function () {
  const hidden = await this.page.evaluate(() => document.getElementById('inspector').hidden);
  assert.equal(hidden, true);
});

Then('the detail level is {string}', async function (level) {
  const mode = await this.page.evaluate(() => window.straboTest.state.mode);
  assert.equal(mode, level);
});

Then('the filter contains {string}', async function (value) {
  const filter = await this.page.inputValue('#filter');
  assert.ok(filter.includes(value), `filter "${filter}" should contain "${value}"`);
});

Then('the inspector shows the passport metrics for {string}', async function (id) {
  const text = (await this.page.textContent('#inspector')) ?? '';
  assert.ok(text.includes(id) || text.includes(id.split('/').pop()), 'inspector should describe the node');
  assert.match(text, /Direct importers/);
  assert.match(text, /Blast radius/);
  assert.match(text, /Direct imports/);
});

Then('the inspector reports members as not recorded', async function () {
  await this.openInspectorTab('members');
  const text = (await this.page.textContent('#inspector [data-role="members"]')) ?? '';
  assert.match(text, /Members/);
  assert.match(text, /not recorded|not implemented/i);
});

Then('the inspector lists members including {string}', async function (name) {
  await this.openInspectorTab('members');
  await this.page.waitForFunction(
    (member) => {
      const section = document.querySelector('#inspector [data-role="members"]');
      return Boolean(section) && section.textContent.includes(member) && /Members \(\d+\)/.test(section.textContent);
    },
    name,
    { timeout: 15_000 },
  );
});

Then('the member map lists fields with declared types', async function () {
  await this.openInspectorTab('members');
  await this.page.waitForFunction(
    () => document.querySelectorAll('#inspector .member-field').length > 0,
    undefined,
    { timeout: 15_000 },
  );
  const text = (await this.page.textContent('#inspector .member-fields')) ?? '';
  assert.match(text, /value: Int/);
  assert.match(text, /label: String/);
  assert.match(text, /lastError: String/);
});

Then('the member map lists methods as behaviour', async function () {
  await this.openInspectorTab('members');
  const text = (await this.page.textContent('#inspector .member-methods')) ?? '';
  assert.match(text, /fun add/);
  assert.match(text, /fun reset/);
  assert.match(text, /fun fail/);
});

Then('the data flow panels report sources, resources, transforms, and sinks', async function () {
  await this.openInspectorTab('members');
  await this.page.waitForFunction(
    () => document.querySelectorAll('#inspector .flow-panel').length === 4,
    undefined,
    { timeout: 15_000 },
  );
  const panel = async (flow) =>
    (await this.page.textContent(`#inspector .flow-panel[data-flow="${flow}"]`)) ?? '';
  assert.match(await panel('sources'), /label/);
  assert.match(await panel('resources'), /value/);
  assert.match(await panel('sinks'), /lastError/);
  const transforms = await panel('transforms');
  assert.match(transforms, /Counter\.add/);
  assert.match(transforms, /Counter\.reset/);
});

Then('the data flow reports wiring is not recorded', async function () {
  await this.openInspectorTab('members');
  await this.page.waitForSelector('#inspector [data-role="flow-unavailable"]', { timeout: 15_000 });
  const text = (await this.page.textContent('#inspector [data-role="flow-unavailable"]')) ?? '';
  assert.match(text, /not recorded/);
});

When('I open the member map', async function () {
  await this.page.click('#inspector #open-member-map');
  await this.page.waitForFunction(
    () => {
      const view = document.getElementById('member-view');
      return Boolean(view) && !view.hidden &&
        (view.querySelector('[data-role="member-step"]')?.textContent ?? '').includes('Step 1 of 5');
    },
    undefined,
    { timeout: 20_000 },
  );
});

Then('the member map view shows fields, clusters, and the data flow', async function () {
  const view = '#member-view';
  const fields = (await this.page.textContent(`${view} [data-role="fields"]`)) ?? '';
  assert.match(fields, /value: Int/);
  assert.match(fields, /lastError: String/);
  const tags = (await this.page.textContent(`${view} [data-role="clusters"]`)) ?? '';
  assert.match(tags, /cluster 1/);

  const flow = (await this.page.textContent(`${view} [data-role="data-flow"]`)) ?? '';
  assert.match(flow, /SOURCE \/ INPUTS/);
  assert.match(flow, /RESOURCES \/ HUBS/);
  assert.match(flow, /DATA FLOW/);
  assert.match(flow, /SINKS \/ OUTPUTS/);
  assert.match(flow, /EXTERNAL CONSUMPTION/);
});

Then('the member map view shows architecture health and the dependency constellation', async function () {
  await this.page.waitForSelector('#member-view [data-role="health"] .radar', { timeout: 15_000 });
  const health = (await this.page.textContent('#member-view [data-role="health"]')) ?? '';
  assert.match(health, /Architecture health/);
  assert.match(health, /Low coupling/);
  assert.match(health, /Cohesion \d+%/);
  assert.match(health, /Coverage/);

  const metrics = (await this.page.textContent('#member-view [data-role="health-metrics"]')) ?? '';
  assert.match(metrics, /blast radius/);

  await this.page.waitForSelector('#member-view [data-role="constellation"] .constellation', {
    timeout: 15_000,
  });
  const dots = await this.page.locator('#member-view .constellation-dot').count();
  assert.ok(dots > 0, 'constellation should plot at least one member');
});

When('I step through the flow walkthrough', async function () {
  await this.page.click('#member-next');
  await this.page.click('#member-next');
});

Then('the flow walkthrough reports the wiring step', async function () {
  const text = (await this.page.textContent('#member-view [data-role="member-step"]')) ?? '';
  assert.match(text, /Step 3 of 5 \(wiring\)/);
});
