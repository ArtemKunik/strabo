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
  assert.match(text, /band = tier/);
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
