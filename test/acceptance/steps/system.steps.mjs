import assert from 'node:assert/strict';

import { Given, Then, When } from '@cucumber/cucumber';

import { ACCEPTANCE_POLYGLOT_ROOT } from '../support/server.mjs';

Given('I open the polyglot fixture repository', async function () {
  const response = await fetch(`${this.baseUrl}/api/strabo/repositories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: ACCEPTANCE_POLYGLOT_ROOT }),
  });
  assert.equal(response.ok, true, 'the polyglot fixture should be accepted inside the scan ceiling');
  await this.page.goto(this.baseUrl);
  await this.page.waitForFunction(() => window.straboTest?.model() != null, undefined, {
    timeout: 20_000,
  });
  const before = await this.page.evaluate(() => window.straboTest.renderedGeneration());
  await this.page.selectOption('#repository', { label: 'system-repo' });
  await this.page.waitForFunction(
    (generation) => window.straboTest.renderedGeneration() > generation,
    before,
    { timeout: 20_000 },
  );
  // The first-visit Repository passport floats over the canvas; close it so node clicks land.
  await this.page.evaluate(() => {
    for (const controller of window.straboTest?.floatingWindows?.() ?? []) {
      if (controller.isOpen?.()) controller.toggle();
    }
  });
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
  await this.page.waitForFunction(
    (label) => {
      const model = window.straboTest?.model();
      return Boolean(
        model?.system &&
          model.nodes.some(
            (node) => node.id.endsWith('#support') && node.label === `${label} support`,
          ),
      );
    },
    name,
    { timeout: 15_000 },
  );
});

Then('the System legend names build units', async function () {
  const text = (await this.page.textContent('#legend')) ?? '';
  assert.match(text, /build unit/);
  assert.match(text, /support files/);
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
  const expected = [];
  for (const unit of report.units) {
    expected.push(unit.id);
    if (unit.periphery > 0) {
      expected.push(unit.id === '.' ? '#support' : `${unit.id}#support`);
    }
  }
  await this.page.waitForFunction(
    (ids) => {
      const model = window.straboTest?.model();
      return Boolean(
        model?.system === true &&
          !model.systemUnit &&
          model.nodes.every((node) => ids.includes(node.id)),
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
