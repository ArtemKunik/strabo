import assert from 'node:assert/strict';

import { Given, Then, When } from '@cucumber/cucumber';

import { ACCEPTANCE_POLYGLOT_ROOT, ACCEPTANCE_SOLO_ROOT } from '../support/server.mjs';

/** Register a fixture root, select it by name, and close the first-visit passport. */
async function openFixture(context, root, label) {
  const response = await fetch(`${context.baseUrl}/api/strabo/repositories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root }),
  });
  assert.equal(response.ok, true, 'the fixture should be accepted inside the scan ceiling');
  await context.page.goto(context.baseUrl);
  await context.page.waitForFunction(() => window.straboTest?.model() != null, undefined, {
    timeout: 20_000,
  });
  const before = await context.page.evaluate(() => window.straboTest.renderedGeneration());
  await context.page.selectOption('#repository', { label });
  await context.page.waitForFunction(
    (generation) => window.straboTest.renderedGeneration() > generation,
    before,
    { timeout: 20_000 },
  );
  // The first-visit Repository passport floats over the canvas; close it so node clicks land.
  await context.page.evaluate(() => {
    for (const controller of window.straboTest?.floatingWindows?.() ?? []) {
      if (controller.isOpen?.()) controller.toggle();
    }
  });
}

Given('I open the polyglot fixture repository', async function () {
  await openFixture(this, ACCEPTANCE_POLYGLOT_ROOT, 'system-repo');
});

Given('I open the single-unit fixture repository', async function () {
  await openFixture(this, ACCEPTANCE_SOLO_ROOT, 'solo-repo');
});

When('I switch to system detail', async function () {
  const before = await this.page.evaluate(() => window.straboTest.renderedGeneration());
  await this.page.selectOption('#detail', 'system');
  await this.page.waitForFunction(
    (generation) =>
      window.straboTest?.state.mode === 'system' &&
      window.straboTest?.model()?.system === true &&
      window.straboTest.renderedGeneration() > generation,
    before,
    { timeout: 20_000 },
  );
});

Then('the System view draws the unit {string}', async function (name) {
  await this.page.waitForFunction(
    (label) => {
      const model = window.straboTest?.model();
      return Boolean(
        model?.system &&
          model.nodes.some((node) => node.label === label && !node.id.endsWith('#support')),
      );
    },
    name,
    { timeout: 15_000 },
  );
});

Then('the System view draws a support shelf for {string}', async function (name) {
  // L21: the shelf is a footer strip on the unit card, not a peer node.
  await this.page.waitForFunction(
    (id) => {
      const model = window.straboTest?.model();
      const unit = model?.nodes.find((node) => node.id === id);
      if (!model?.system || !unit || !(unit.periphery > 0)) {
        return false;
      }
      const card = document.querySelector(`.unit-card[data-unit="${id}"]`);
      return Boolean(card && card.querySelector('.unit-shelf')?.textContent.includes('support'));
    },
    name,
    { timeout: 15_000 },
  );
});

Then('the System legend names build units', async function () {
  const text = (await this.page.textContent('#legend')) ?? '';
  assert.match(text, /build unit/);
  assert.match(text, /unit footer/);
});

Then('the single unit opens at its layers', async function () {
  await this.page.waitForFunction(
    () => {
      const model = window.straboTest?.model();
      return Boolean(model?.system && model.systemUnit != null && !model.systemUnit.includes('#'));
    },
    undefined,
    { timeout: 20_000 },
  );
  const note = (await this.page.textContent('#system-note')) ?? '';
  assert.match(note, /1 build unit/);
});

Then('the unit hover for {string} shows unit facts', async function (id) {
  await this.page.waitForFunction(
    (unitId) => window.straboTest?.model()?.nodes.some((node) => node.id === unitId),
    id,
    { timeout: 15_000 },
  );
  await this.page.evaluate((unitId) => {
    window.straboTest?.cy.getElementById(unitId).trigger('mouseover');
  }, id);
  await this.page.waitForFunction(
    () => (document.getElementById('hover')?.textContent ?? '').includes('depends on'),
    undefined,
    { timeout: 15_000 },
  );
  const text = (await this.page.textContent('#hover')) ?? '';
  assert.match(text, /package/);
  assert.match(text, /depends on/);
  assert.doesNotMatch(text, /blast radius/);
});

When('I select the root unit node', async function () {
  await this.clickNode('.', {
    settled: () => {
      const inspector = document.getElementById('inspector');
      return !inspector.hidden && inspector.textContent.includes('Grouped by:');
    },
  });
});

Then('the inspector reports why the unit is grouped', async function () {
  const text = (await this.page.textContent('#inspector')) ?? '';
  assert.match(text, /Grouped by:/);
  assert.match(text, /Files/);
});

Then('the System view draws units only', async function () {
  const report = await this.page.evaluate(async () => {
    const repository = window.straboTest?.state?.repository;
    const query = repository ? `?repository=${encodeURIComponent(repository)}` : '';
    const response = await fetch(`/api/strabo/analysis/system${query}`);
    return response.json();
  });
  // L21: the shelf is folded into its unit card, so L0 draws exactly the units.
  const expected = report.units.map((unit) => unit.id);
  await this.page.waitForFunction(
    (ids) => {
      const model = window.straboTest?.model();
      return Boolean(
        model?.system === true &&
          !model.systemUnit &&
          model.nodes.length === ids.length &&
          model.nodes.every((node) => ids.includes(node.id) && node.kind === 'unit'),
      );
    },
    expected,
    { timeout: 15_000 },
  );
});

When('I open the unit {string}', async function (name) {
  const id = await this.page.evaluate((label) => {
    const model = window.straboTest?.model();
    return (
      model?.nodes.find(
        (node) =>
          !node.id.endsWith('#support') && (node.label === label || node.id === label),
      )?.id ?? null
    );
  }, name);
  assert.ok(id, `the unit "${name}" should be on the map`);
  await this.clickNode(id, {
    double: true,
    settled: (unitId) => window.straboTest?.model()?.systemUnit === unitId,
  });
});

Then('the breadcrumb reads {string}', async function (expected) {
  await this.page.waitForFunction(
    (text) => {
      const crumbs = [...document.querySelectorAll('#breadcrumb .crumb')];
      return crumbs.map((crumb) => crumb.textContent).join(' › ') === text;
    },
    expected,
    { timeout: 15_000 },
  );
});

Then('the map draws the file {string}', async function (id) {
  await this.page.waitForFunction(
    (file) => window.straboTest?.model()?.nodes.some((node) => node.id === file),
    id,
    { timeout: 15_000 },
  );
});

Then('no import edge crosses the unit frame', async function () {
  const result = await this.page.evaluate(() => {
    const model = window.straboTest?.model();
    if (!model) {
      return null;
    }
    const collapsed = new Set(
      model.nodes.filter((node) => node.collapsed).map((node) => node.id),
    );
    return {
      scopes: model.edges.map((edge) => edge.scope),
      crossing: model.edges.filter(
        (edge) => collapsed.has(edge.source) || collapsed.has(edge.target),
      ).length,
    };
  });
  assert.ok(result, 'the graph model should be loaded');
  assert.ok(
    result.scopes.every((scope) => scope === 'unit'),
    `unexpected crossing edge scope: ${result.scopes.join(', ')}`,
  );
  assert.equal(result.crossing, 0);
});

When('I select the file {string}', async function (id) {
  await this.clickNode(id, {
    settled: (file) => window.straboTest?.state.unitFile === file,
  });
});

Then("only the selected file's in-unit edges are drawn", async function () {
  await this.page.waitForFunction(
    () => {
      const selected = window.straboTest?.state.unitFile;
      if (!selected) {
        return false;
      }
      return window.straboTest.cy
        .edges()
        .filter((edge) => edge.visible())
        .every(
          (edge) => edge.data('source') === selected || edge.data('target') === selected,
        );
    },
    undefined,
    { timeout: 15_000 },
  );
});

When('I press Escape', async function () {
  await this.page.keyboard.press('Escape');
  await this.page.waitForFunction(() => window.straboTest?.state.systemUnit == null, undefined, {
    timeout: 15_000,
  });
});

When('I show outside links', async function () {
  const before = await this.page.evaluate(() => window.straboTest.renderedGeneration());
  // The inspector action is the primary affordance; the toolbar button is behind the panel.
  await this.page.click('#show-outside-links');
  await this.page.waitForFunction(
    (generation) =>
      (window.straboTest?.model()?.outsideLinks?.length ?? 0) > 0 &&
      window.straboTest.renderedGeneration() > generation,
    before,
    { timeout: 20_000 },
  );
});

Then('an outside link badge reads {string}', async function (expected) {
  await this.page.waitForFunction(
    (text) => {
      const badge = document.querySelector('#inspector .outside-badge');
      return Boolean(badge && badge.textContent.includes(text));
    },
    expected,
    { timeout: 15_000 },
  );
});
