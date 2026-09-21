import assert from 'node:assert/strict';

import { Then, When } from '@cucumber/cucumber';

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
