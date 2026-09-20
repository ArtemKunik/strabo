import assert from 'node:assert/strict';

import { Then, When } from '@cucumber/cucumber';

async function panelRect(page, key) {
  return page.evaluate((panelKey) => {
    const element = document.querySelector(`.float-window[data-panel="${panelKey}"]`);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }, key);
}

/** Drag from a locator's centre by a pixel offset, as a real pointer session Playwright drives end to end. */
async function dragBy(page, locator, dx, dy) {
  const box = await locator.boundingBox();
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 5 });
  await page.mouse.up();
}

When('I drag the {string} panel by {int}, {int}', async function (key, dx, dy) {
  this.floatBaseline ??= {};
  this.floatBaseline[key] ??= await panelRect(this.page, key);
  const header = this.page.locator(`.float-window[data-panel="${key}"] .float-header`);
  await dragBy(this.page, header, dx, dy);
});

When('I resize the {string} panel by {int}, {int}', async function (key, dx, dy) {
  this.floatBaseline ??= {};
  this.floatBaseline[key] ??= await panelRect(this.page, key);
  const handle = this.page.locator(`.float-window[data-panel="${key}"] .float-resize`);
  await dragBy(this.page, handle, dx, dy);
});

Then('the {string} panel position moved by {int}, {int}', async function (key, dx, dy) {
  const before = this.floatBaseline[key];
  const after = await panelRect(this.page, key);
  assert.ok(before && after, `panel "${key}" should be present before and after`);
  assert.ok(
    Math.abs(after.left - before.left - dx) <= 2,
    `left moved by ${after.left - before.left}, expected ~${dx}`,
  );
  assert.ok(
    Math.abs(after.top - before.top - dy) <= 2,
    `top moved by ${after.top - before.top}, expected ~${dy}`,
  );
});

Then('the {string} panel size grew by {int}, {int}', async function (key, dx, dy) {
  const before = this.floatBaseline[key];
  const after = await panelRect(this.page, key);
  assert.ok(before && after, `panel "${key}" should be present before and after`);
  assert.ok(
    Math.abs(after.width - before.width - dx) <= 2,
    `width grew by ${after.width - before.width}, expected ~${dx}`,
  );
  assert.ok(
    Math.abs(after.height - before.height - dy) <= 2,
    `height grew by ${after.height - before.height}, expected ~${dy}`,
  );
});
