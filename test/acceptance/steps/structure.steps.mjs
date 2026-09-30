import assert from 'node:assert/strict';

import { Given, Then, When } from '@cucumber/cucumber';

import { ACCEPTANCE_STRUCTURE_ROOT } from '../support/server.mjs';

/** Register the structure fixture, select it by name, and close the first-visit passport. */
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
  await context.page.evaluate(() => {
    for (const controller of window.straboTest?.floatingWindows?.() ?? []) {
      if (controller.isOpen?.()) controller.toggle();
    }
  });
}

Given('I open the structure fixture repository', async function () {
  await openFixture(this, ACCEPTANCE_STRUCTURE_ROOT, 'structure-repo');
});

When('I switch to structure detail', async function () {
  const before = await this.page.evaluate(() => window.straboTest.renderedGeneration());
  // Detail lives in the header's View popover.
  await this.page.click('#view-menu-toggle');
  await this.page.selectOption('#detail', 'structure');
  await this.page.click('#view-menu-toggle');
  await this.page.waitForFunction(
    (generation) =>
      window.straboTest?.state.mode === 'structure' &&
      window.straboTest?.model()?.structure === true &&
      window.straboTest.renderedGeneration() > generation,
    before,
    { timeout: 20_000 },
  );
});

Then('the Structure view draws a band for {string}', async function (tier) {
  await this.page.waitForFunction(
    (name) => {
      const model = window.straboTest?.model();
      return Boolean(
        model?.structure && model.nodes.some((node) => node.tier === name && node.kind === 'tier'),
      );
    },
    tier,
    { timeout: 15_000 },
  );
});

When('I turn on the structure grid', async function () {
  const before = await this.page.evaluate(() => window.straboTest.renderedGeneration());
  // The grid toggle lives on the canvas toolbar and only shows in Structure mode.
  await this.page.click('#tb-grid');
  await this.page.waitForFunction(
    (generation) =>
      window.straboTest?.state.structureGrid === true &&
      window.straboTest?.model()?.structureLevel === 'grid' &&
      window.straboTest.renderedGeneration() > generation,
    before,
    { timeout: 20_000 },
  );
});

Then('the Structure view draws a column for {string}', async function (unitName) {
  await this.page.waitForFunction(
    (name) => {
      const model = window.straboTest?.model();
      return Boolean(
        model?.structureLevel === 'grid' &&
          model.structureGrid?.units?.some((unit) => unit.name === name),
      );
    },
    unitName,
    { timeout: 15_000 },
  );
});

Then(
  'the Structure grid draws a cell for {string} in {string}',
  async function (unitName, tier) {
    await this.page.waitForFunction(
      ({ name, role }) => {
        const model = window.straboTest?.model();
        return Boolean(
          model?.structureLevel === 'grid' &&
            model.nodes.some((node) => node.unitName === name && node.tier === role),
        );
      },
      { name: unitName, role: tier },
      { timeout: 15_000 },
    );
  },
);

Then(
  'the cross-unit flow from {string} in {string} to {string} in {string} is drawn',
  async function (sourceUnit, sourceTier, targetUnit, targetTier) {
    // A scenario names units by display name; a cell id is `<unit id>|<tier>`, so the step
    // resolves each name to its id from the grid's own column list.
    await this.page.waitForFunction(
      ({ fromName, fromTier, toName, toTier }) => {
        const model = window.straboTest?.model();
        if (model?.structureLevel !== 'grid') {
          return false;
        }
        const idOf = (name) =>
          model.structureGrid?.units?.find((unit) => unit.name === name)?.id ?? null;
        const source = idOf(fromName);
        const target = idOf(toName);
        return Boolean(
          source &&
            target &&
            model.edges.some(
              (edge) =>
                edge.source === `${source}|${fromTier}` &&
                edge.target === `${target}|${toTier}` &&
                edge.crossUnitEdge === true,
            ),
        );
      },
      { fromName: sourceUnit, fromTier: sourceTier, toName: targetUnit, toTier: targetTier },
      { timeout: 15_000 },
    );
  },
);

Then('the Structure view draws a support shelf', async function () {
  await this.page.waitForFunction(
    () => Boolean(window.straboTest?.model()?.nodes.some((node) => node.kind === 'shelf')),
    undefined,
    { timeout: 15_000 },
  );
});

Then('the {string} tier is on the support shelf, not a band', async function (tier) {
  await this.page.waitForFunction(
    (name) => {
      const model = window.straboTest?.model();
      return Boolean(model?.structure && model.nodes.some((node) => node.tier === name && node.kind === 'shelf'));
    },
    tier,
    { timeout: 15_000 },
  );
});

Then('the Structure legend names role tiers, not layers', async function () {
  const text = (await this.page.textContent('#legend')) ?? '';
  assert.match(text, /card = tier/);
  assert.match(text, /shelf = support tiers/);
  assert.doesNotMatch(text, /lane = layer/);
});

Then('the flow from {string} to {string} is drawn as a skip-layer edge', async function (source, target) {
  await this.page.waitForFunction(
    ({ from, to }) => {
      const model = window.straboTest?.model();
      return Boolean(
        model?.edges.some(
          (edge) => edge.source === from && edge.target === to && edge.tierKind === 'skip-layer',
        ),
      );
    },
    { from: source, to: target },
    { timeout: 15_000 },
  );
});

Then('the flow from {string} to {string} is drawn as an upward edge', async function (source, target) {
  await this.page.waitForFunction(
    ({ from, to }) => {
      const model = window.straboTest?.model();
      return Boolean(
        model?.edges.some(
          (edge) => edge.source === from && edge.target === to && edge.tierKind === 'upward',
        ),
      );
    },
    { from: source, to: target },
    { timeout: 15_000 },
  );
});

When(
  'I drill into the cell for {string} in {string}',
  async function (unitName, tier) {
    const before = await this.page.evaluate(() => window.straboTest.renderedGeneration());
    await this.page.evaluate(
      ({ name, role }) => {
        const model = window.straboTest?.model();
        const cell = model?.nodes?.find((node) => node.unitName === name && node.tier === role);
        if (cell) {
          window.straboTest.drill(cell.id);
        }
      },
      { name: unitName, role: tier },
    );
    await this.page.waitForFunction(
      (generation) =>
        window.straboTest?.model()?.structureLevel === 'cell' &&
        window.straboTest.renderedGeneration() > generation,
      before,
      { timeout: 20_000 },
    );
  },
);

Then(
  'the view shows the files of {string} in {string}',
  async function (unitName, tier) {
    await this.page.waitForFunction(
      ({ name, role }) => {
        const model = window.straboTest?.model();
        return Boolean(
          model?.structureLevel === 'cell' &&
            model.structureUnitName === name &&
            model.structureTier === role &&
            model.nodes.some((n) => !n.collapsed),
        );
      },
      { name: unitName, role: tier },
      { timeout: 15_000 },
    );
  },
);

When('I exit the cell with Escape', async function () {
  const before = await this.page.evaluate(() => window.straboTest.renderedGeneration());
  await this.page.keyboard.press('Escape');
  await this.page.waitForFunction(
    (generation) =>
      window.straboTest?.model()?.structureLevel !== 'cell' &&
      window.straboTest.renderedGeneration() > generation,
    before,
    { timeout: 20_000 },
  );
});

Then('the Structure view returns to the grid', async function () {
  await this.page.waitForFunction(
    () => window.straboTest?.model()?.structureLevel === 'grid',
    undefined,
    { timeout: 15_000 },
  );
});

When('I open the recorded call from the {string} band', async function (tier) {
  await this.page.evaluate((bandTier) => {
    const model = window.straboTest?.model();
    const band = model?.nodes?.find(
      (node) => (node.tier === bandTier || node.id === bandTier) && node.kind === 'tier',
    );
    if (band) {
      window.straboTest.select(band.id);
    }
  }, tier);
  await this.page.waitForSelector('[data-role="open-spine"]', { timeout: 15_000 });
  await this.page.click('[data-role="open-spine"]');
  await this.page.waitForSelector('[data-role="spine-view"]', { timeout: 15_000 });
});

When('I select the {string} band', async function (tier) {
  await this.page.evaluate((bandTier) => {
    const model = window.straboTest?.model();
    const band = model?.nodes?.find(
      (node) => (node.tier === bandTier || node.id === bandTier) && node.kind === 'tier',
    );
    if (band) {
      window.straboTest.select(band.id);
    }
  }, tier);
  await this.page.waitForFunction(
    (bandTier) => {
      const inspector = document.getElementById('inspector');
      return Boolean(inspector) && !inspector.hidden && (inspector.textContent ?? '').includes(bandTier);
    },
    tier,
    { timeout: 15_000 },
  );
});

Then('the Module Passport for the {string} band offers no member map', async function (tier) {
  await this.page.waitForSelector('#inspector .inspector-actions', { timeout: 15_000 });
  const memberButtons = await this.page.evaluate(
    () => document.querySelectorAll('#inspector #open-member-map').length,
  );
  assert.equal(memberButtons, 0, `the ${tier} band passport should not offer a member map`);
});

Then('the spine follows the call to its declared endpoint', async function () {
  await this.page.waitForFunction(
    () => {
      const endpointEl = document.querySelector('[data-role="spine-endpoint"]');
      if (!endpointEl) return false;
      const text = endpointEl.textContent ?? '';
      return text.includes('/orders') || text.includes('openapi');
    },
    undefined,
    { timeout: 15_000 },
  );
});

Then('the spine reaches the table {string}', async function (tableName) {
  await this.page.waitForFunction(
    (expected) => {
      const tableEl = document.querySelector('[data-role="spine-table"]');
      if (!tableEl) return false;
      const text = tableEl.textContent ?? '';
      return text.includes(expected);
    },
    tableName,
    { timeout: 15_000 },
  );
});

Then(
  'the Structure view draws an intended ghost edge from {string} to {string}',
  async function (source, target) {
    await this.page.waitForFunction(
      ({ from, to }) => {
        const model = window.straboTest?.model();
        return Boolean(
          model?.edges.some(
            (edge) =>
              edge.source === from &&
              edge.target === to &&
              edge.ghost === true &&
              edge.intended === true,
          ),
        );
      },
      { from: source, to: target },
      { timeout: 15_000 },
    );
  },
);

Then(
  'the flow from {string} to {string} is marked as a violation',
  async function (source, target) {
    await this.page.waitForFunction(
      ({ from, to }) => {
        const model = window.straboTest?.model();
        return Boolean(
          model?.edges.some(
            (edge) =>
              edge.source === from &&
              edge.target === to &&
              edge.violation === true,
          ),
        );
      },
      { from: source, to: target },
      { timeout: 15_000 },
    );
  },
);
