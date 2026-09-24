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

Then('the {string} panel is at least {int} pixels wide', async function (key, minimum) {
  const rect = await panelRect(this.page, key);
  assert.ok(rect, `panel "${key}" should be present`);
  assert.ok(rect.width >= minimum, `panel "${key}" is ${rect.width}px wide, expected at least ${minimum}px`);
});

/** Find a dock chip by its visible label; labels are user-facing, keys are not. */
async function dockChip(page, label) {
  return page.evaluate((text) => {
    const chips = [...document.querySelectorAll('#float-dock .dock-chip')];
    const chip = chips.find((candidate) => candidate.textContent.trim() === text);
    if (!chip) return null;
    const rect = chip.getBoundingClientRect();
    return {
      disabled: Boolean(chip.disabled),
      title: chip.title ?? '',
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    };
  }, label);
}

Then('the {string} dock chip is disabled', async function (label) {
  await this.page.waitForFunction(
    (text) => {
      const chips = [...document.querySelectorAll('#float-dock .dock-chip')];
      const chip = chips.find((candidate) => candidate.textContent.trim() === text);
      return chip != null && chip.disabled === true;
    },
    label,
    { timeout: 10_000 },
  );
  const chip = await dockChip(this.page, label);
  assert.ok(chip, `dock chip "${label}" should be present`);
  assert.equal(chip.disabled, true, `dock chip "${label}" should be disabled without its context`);
  assert.ok(chip.title.length > 0, `dock chip "${label}" should explain why it cannot open`);
});

Then('the {string} dock chip is enabled', async function (label) {
  await this.page.waitForFunction(
    (text) => {
      const chips = [...document.querySelectorAll('#float-dock .dock-chip')];
      const chip = chips.find((candidate) => candidate.textContent.trim() === text);
      return chip != null && chip.disabled === false;
    },
    label,
    { timeout: 10_000 },
  );
  const chip = await dockChip(this.page, label);
  assert.ok(chip, `dock chip "${label}" should be present`);
  assert.equal(chip.disabled, false, `dock chip "${label}" should be enabled`);
});

Then('the overlay panel reports test reach counts', async function () {
  const text = (await this.page.textContent('#overlay-panel')) ?? '';
  assert.match(text, /test files/, `overlay panel "${text}" should name the test file count`);
  assert.match(text, /reached/, `overlay panel "${text}" should name the reached count`);
});

function rectsOverlap(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** Viewport rects for the given selectors, or null for any that is missing. */
async function rectsOf(page, selectors) {
  return page.evaluate((list) => {
    const out = {};
    for (const [name, selector] of Object.entries(list)) {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      out[name] = rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null;
    }
    return out;
  }, selectors);
}

Then('the panel rail sits on the right edge of the graph', async function () {
  const rects = await rectsOf(this.page, { rail: '#float-dock', graph: '#graph-screen' });
  assert.ok(rects.rail, 'the panel rail should be present');
  assert.ok(rects.graph, 'the graph screen should be present');
  assert.ok(Math.abs(rects.rail.right - rects.graph.right) <= 1, 'the rail should end at the graph edge');
  assert.ok(rects.rail.bottom - rects.rail.top > (rects.graph.bottom - rects.graph.top) / 2, 'the rail should run down the edge');
});

Then('the zoom controls do not overlap the panel rail', async function () {
  const rects = await rectsOf(this.page, { rail: '#float-dock', zoom: '.zoom-controls' });
  assert.ok(rects.rail, 'the panel rail should be present');
  assert.ok(rects.zoom, 'the zoom controls should be present');
  assert.equal(rectsOverlap(rects.rail, rects.zoom), false, 'the zoom controls should sit clear of the rail');
});

/** Where the canvas toolbar currently lives: docked in the footer or floating on the canvas. */
async function toolbarState(page) {
  return page.evaluate(() => {
    const toolbar = document.querySelector('.graph-toolbar');
    return {
      docked: Boolean(toolbar?.classList.contains('is-docked')),
      parent: toolbar?.parentElement?.id ?? null,
    };
  });
}

When('I drag the canvas toolbar onto the bottom bar', async function () {
  const grip = this.page.locator('.graph-toolbar .tb-grip');
  const box = await grip.boundingBox();
  assert.ok(box, 'the toolbar grip should be present');
  const bar = await this.page.locator('#bottom-bar').boundingBox();
  assert.ok(bar, 'the bottom bar should be present');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await this.page.mouse.move(startX, startY);
  await this.page.mouse.down();
  await this.page.mouse.move(startX, bar.y + bar.height / 2, { steps: 8 });
  await this.page.mouse.up();
});

When('I drag the canvas toolbar grip up off the bottom bar', async function () {
  const grip = this.page.locator('.graph-toolbar .tb-grip');
  const box = await grip.boundingBox();
  assert.ok(box, 'the toolbar grip should be present');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await this.page.mouse.move(startX, startY);
  await this.page.mouse.down();
  await this.page.mouse.move(startX + 40, startY - 220, { steps: 8 });
  await this.page.mouse.up();
});

Then('the canvas toolbar is docked in the bottom bar', async function () {
  const state = await toolbarState(this.page);
  assert.equal(state.docked, true, 'the toolbar should be docked');
  assert.equal(state.parent, 'bottom-bar', 'the toolbar should live in the bottom bar');
});

Then('the canvas toolbar floats on the canvas again', async function () {
  const state = await toolbarState(this.page);
  assert.equal(state.docked, false, 'the toolbar should not be docked');
  assert.equal(state.parent, 'graph-screen', 'the toolbar should return to the graph screen');
});
