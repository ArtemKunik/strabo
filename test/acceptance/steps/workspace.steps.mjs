import assert from 'node:assert/strict';

import { Then, When } from '@cucumber/cucumber';

When('I open the workspace panel', async function () {
  await this.page.evaluate(() => window.straboTest.workspace());
  await this.page.waitForFunction(
    () => {
      const panel = document.getElementById('workspace-panel');
      return panel != null && !panel.hidden && /Workspace —/.test(panel.textContent ?? '');
    },
    undefined,
    { timeout: 15_000 },
  );
});

Then('the workspace panel lists the repository {string}', async function (name) {
  await this.page.waitForFunction(
    (expected) => {
      const panel = document.getElementById('workspace-panel');
      const names = Array.from(panel?.querySelectorAll('.workspace-name') ?? []);
      return names.some((node) => (node.textContent ?? '').trim() === expected);
    },
    name,
    { timeout: 15_000 },
  );
});

Then('the workspace panel reports no cross-repo flows', async function () {
  const text = (await this.page.textContent('#workspace-panel')) ?? '';
  assert.match(text, /No cross-repo flows recorded\./);
});

Then('the workspace panel reports no contracts recorded', async function () {
  const text = (await this.page.textContent('#workspace-panel')) ?? '';
  assert.match(text, /No contracts recorded\./);
});

Then('the workspace panel reports no service flows', async function () {
  const text = (await this.page.textContent('#workspace-panel')) ?? '';
  assert.match(text, /No service flows recorded\./);
});

Then('the workspace panel reports no service endpoints', async function () {
  const text = (await this.page.textContent('#workspace-panel')) ?? '';
  assert.match(text, /No service endpoints recorded\./);
});
