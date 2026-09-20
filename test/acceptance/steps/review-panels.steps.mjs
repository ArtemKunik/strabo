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

/**
 * Builds the group through cytoscape's own selection API rather than a pixel-perfect
 * shift-drag: it exercises the same select/unselect events the UI listens for, without a
 * test depending on where a fixture happens to lay nodes out relative to the floating
 * toolbar. Ids can contain `/`, so this looks nodes up by id rather than as a CSS
 * selector, where an unescaped `/` would be invalid.
 */
When('I select the {string} and {string} nodes as a group', async function (a, b) {
  await this.page.evaluate(
    ({ a, b }) => {
      const cy = window.straboTest.cy;
      cy.collection([cy.getElementById(a), cy.getElementById(b)]).select();
    },
    { a, b },
  );
  await this.page.waitForFunction(() => window.straboTest.groupSelection().length === 2);
});

When('I open the group delegate menu', async function () {
  await this.page.click('#tb-delegate-group');
  await this.page.waitForFunction(() => document.querySelector('.agent-menu:not([hidden])') != null);
});

When('I right-click the review panel', async function () {
  await this.page.click('#review-panel', { button: 'right' });
  await this.page.waitForFunction(() => document.querySelector('.agent-menu:not([hidden])') != null);
});

Then('the group toolbar reports {int} selected', async function (count) {
  const text = (await this.page.textContent('#group-count')) ?? '';
  assert.equal(text, `${count} selected`);
  const hidden = await this.page.evaluate(() => document.getElementById('tb-delegate-group').hidden);
  assert.equal(hidden, false, 'the delegate-group button should be visible once a group exists');
});

Then('the group toolbar reports no selection', async function () {
  const hidden = await this.page.evaluate(() => document.getElementById('group-count').hidden);
  assert.equal(hidden, true);
  const groupSelection = await this.page.evaluate(() => window.straboTest.groupSelection());
  assert.deepEqual(groupSelection, []);
});

Then('the delegate menu title is {string}', async function (title) {
  const text = await this.page.textContent('.agent-menu:not([hidden]) .agent-menu-title');
  assert.equal(text, title);
});

Then('the legend explains size, colour, and shape', async function () {
  const text = (await this.page.textContent('#legend')) ?? '';
  assert.match(text, /size = dependents/);
  assert.match(text, /colour = directory/);
  assert.match(text, /diamond = test/);
});

/**
 * The map draws on the 2D canvas renderer by default and only switches to WebGL on an
 * explicit opt-in (`?renderer=webgl`). Either is a pass here; reporting the one that is
 * not actually drawing is not, because the status bar is how an engineer explains a slow
 * map.
 */
Then('the status bar names the renderer the map is drawing with', async function () {
  await this.page.evaluate(() => {
    if (document.getElementById('diagnostics')?.hidden) {
      document.getElementById('diagnostics-toggle')?.click();
    }
  });
  const text = (await this.page.textContent('#diagnostics')) ?? '';
  const claimed = /renderer: (webgl2|canvas)/.exec(text);
  assert.ok(claimed, `diagnostics "${text}" should name a renderer`);

  const drawing = await this.page.evaluate(() =>
    (window.straboTest?.cy.renderer().webgl ? 'webgl2' : 'canvas'),
  );
  assert.equal(claimed[1], drawing, 'the diagnostics panel should name the renderer in use');
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

Then('the inspector lists functions including {string}', async function (name) {
  await this.openInspectorTab('functions');
  await this.page.waitForFunction(
    (fn) => {
      const section = document.querySelector('#inspector [data-role="functions"]');
      return Boolean(section) && section.textContent.includes(fn) && /Functions \(\d+\)/.test(section.textContent);
    },
    name,
    { timeout: 15_000 },
  );
});

Then('the inspector reports body metrics for a listed function', async function () {
  const text = (await this.page.textContent('#inspector [data-role="functions"]')) ?? '';
  assert.match(text, /complexity \d+/);
  assert.match(text, /nesting \d+/);
});

Then('the inspector offers the narrator and reports it is not configured', async function () {
  await this.openInspectorTab('functions');
  await this.page.waitForSelector('#inspector .narrator-note', { timeout: 15_000 });
  const note = (await this.page.textContent('#inspector .narrator-note')) ?? '';
  assert.match(note, /not configured/i);

  await this.page.click('#inspector #narrate-functions');
  await this.page.waitForFunction(
    () => {
      const reply = document.querySelector('#inspector [data-role="narrative"]');
      return reply != null && /not-configured|unavailable/i.test(reply.textContent ?? '');
    },
    undefined,
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

When('I reload the page', async function () {
  await this.page.reload();
  await this.page.waitForFunction(() => window.straboTest?.model?.() != null, undefined, {
    timeout: 20_000,
  });
});

Then('the member map is open for {string}', async function (id) {
  await this.page.waitForFunction(
    (target) => {
      const view = document.getElementById('member-view');
      const crumb = view?.querySelector('.member-crumb')?.textContent ?? '';
      return Boolean(view) && !view.hidden && crumb.includes(target);
    },
    id,
    { timeout: 20_000 },
  );
});

/**
 * The view layer is supposed to reuse the card nodes: mark one, advance a step, and the mark
 * must survive. A full `replaceChildren()` rebuild would drop the marker with the old node.
 */
Then('stepping the walkthrough keeps the member card nodes', async function () {
  const marked = await this.page.evaluate(() => {
    const card = document.querySelector('#member-view .member-card');
    if (!card) {
      return false;
    }
    card.dataset.probe = 'kept';
    return true;
  });
  assert.equal(marked, true, 'the member map should render at least one card');

  await this.page.click('#member-next');
  await this.page.waitForFunction(
    () => document.getElementById('member-view')?.dataset.step === 'members',
    undefined,
    { timeout: 5_000 },
  );

  const kept = await this.page.evaluate(
    () => document.querySelector('#member-view .member-card')?.dataset.probe === 'kept',
  );
  assert.equal(kept, true, 'the card DOM should be reused across a walkthrough step');
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

Then('the member map view draws the recorded wiring as a diagram', async function () {
  await this.page.waitForSelector('#member-view [data-role="flow-diagram"]', { timeout: 15_000 });
  const reads = await this.page.locator('#member-view [data-role="flow-diagram"] .flow-edge.read').count();
  const writes = await this.page.locator('#member-view [data-role="flow-diagram"] .flow-edge.write').count();
  assert.ok(reads > 0, 'diagram should draw at least one recorded read');
  assert.ok(writes > 0, 'diagram should draw at least one recorded write');
  const nodes = await this.page.locator('#member-view [data-role="flow-diagram"] .flow-node').count();
  assert.ok(nodes > 0, 'diagram should place member nodes');
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

When('I step to the data flow step', async function () {
  await this.page.click('#member-next');
  await this.page.waitForFunction(
    () => document.getElementById('member-view')?.dataset.step === 'data-flow',
    undefined,
    { timeout: 5_000 },
  );
});

/**
 * Play is the only control that adds `is-playing`; the pulse and the divider dot are CSS, so
 * this asserts the resolved animations rather than a class alone.
 */
Then('playing the walkthrough animates the data flow panels', async function () {
  await this.page.click('#member-play');
  await this.page.waitForFunction(
    () => {
      const view = document.getElementById('member-view');
      const panel = view?.querySelector('.flow-panel[data-flow="sources"]');
      const marker = view?.querySelector('.flow-marker');
      return (
        view?.classList.contains('is-playing') === true &&
        panel != null &&
        getComputedStyle(panel).animationName === 'dataflow-pulse' &&
        marker != null &&
        getComputedStyle(marker).animationName === 'read-write-flow'
      );
    },
    undefined,
    { timeout: 5_000 },
  );
  await this.page.click('#member-play');
  await this.page.waitForFunction(
    () => document.getElementById('member-view')?.classList.contains('is-playing') === false,
    undefined,
    { timeout: 5_000 },
  );
});

const memberNames = (page, selector) =>
  page.$$eval(selector, (cards) => cards.map((card) => card.dataset.member));

When('I hover the {string} field card', async function (name) {
  await this.page.hover(`#member-view .field-card[data-member="${name}"]`);
  await this.page.waitForSelector(`#member-view .field-card[data-member="${name}"].trace-source`);
});

When('I hover the {string} method card', async function (name) {
  await this.page.hover(`#member-view .method-card[data-member="${name}"]`);
  await this.page.waitForSelector(`#member-view .method-card[data-member="${name}"].trace-source`);
});

Then('the methods wired to {string} are traced', async function (_field) {
  const hit = await memberNames(this.page, '#member-view .method-card.trace-hit');
  assert.deepEqual(hit.sort(), ['add', 'reset'], `wired methods should be traced, got ${hit}`);
  const dim = await memberNames(this.page, '#member-view .method-card.trace-unrelated');
  assert.ok(dim.includes('fail'), `unwired methods should recede, got ${dim}`);
});

Then('the field wired to {string} is traced', async function (_method) {
  const hit = await memberNames(this.page, '#member-view .field-card.trace-hit');
  assert.deepEqual(hit, ['lastError'], `the written field should be traced, got ${hit}`);
  const dim = await memberNames(this.page, '#member-view .field-card.trace-unrelated');
  assert.ok(dim.includes('value') && dim.includes('label'), `untouched fields should recede, got ${dim}`);
});

When('I step to the members step', async function () {
  await this.page.click('#member-next');
  await this.page.waitForFunction(
    () => document.getElementById('member-view')?.dataset.step === 'members',
    undefined,
    { timeout: 5_000 },
  );
});

When('I play the walkthrough', async function () {
  await this.page.click('#member-play');
  await this.page.waitForFunction(
    () => document.getElementById('member-view')?.classList.contains('is-playing') === true,
    undefined,
    { timeout: 5_000 },
  );
});

Then('the member cards reveal in cluster order', async function () {
  await this.page.waitForFunction(
    () => {
      const card = document.querySelector('#member-view .member-card');
      return card != null && getComputedStyle(card).animationName === 'cluster-reveal';
    },
    undefined,
    { timeout: 5_000 },
  );
  const staggers = await this.page.$$eval('#member-view .member-card', (cards) =>
    cards.map((card) => card.style.getPropertyValue('--cluster-stagger')),
  );
  assert.ok(
    new Set(staggers).size > 1,
    `cluster order should stagger the reveal, got ${staggers}`,
  );
  await this.page.click('#member-play');
  await this.page.waitForFunction(
    () => document.getElementById('member-view')?.classList.contains('is-playing') === false,
    undefined,
    { timeout: 5_000 },
  );
});
