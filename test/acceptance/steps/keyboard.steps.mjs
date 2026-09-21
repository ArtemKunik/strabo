import { Then, When } from '@cucumber/cucumber';

When('I press the key {string}', async function (key) {
  await this.page.keyboard.press(key);
});

When('I focus the first dock chip', async function () {
  await this.page.waitForFunction(
    () => document.querySelectorAll('#float-dock .dock-chip').length > 0,
    undefined,
    { timeout: 15_000 },
  );
  await this.page.evaluate(() => document.querySelector('#float-dock .dock-chip')?.focus());
  await this.page.waitForFunction(() =>
    Boolean(document.activeElement?.classList?.contains('dock-chip')),
  );
});

Then('the dock chip at index {int} has focus', async function (index) {
  await this.page.waitForFunction(
    (position) => {
      const chips = [...document.querySelectorAll('#float-dock .dock-chip')];
      return document.activeElement === chips[position];
    },
    index,
    { timeout: 5_000 },
  );
});

When('I focus the legend window', async function () {
  await this.page.waitForFunction(
    () => {
      const win = document.querySelector('.float-window[data-panel="legend"]');
      return win != null && !win.hidden;
    },
    undefined,
    { timeout: 15_000 },
  );
  await this.page.evaluate(() =>
    document.querySelector('.float-window[data-panel="legend"]')?.focus(),
  );
  await this.page.waitForFunction(
    () => document.activeElement?.dataset?.panel === 'legend',
    undefined,
    { timeout: 5_000 },
  );
});

Then('the legend window is closed', async function () {
  await this.page.waitForFunction(
    () => document.querySelector('.float-window[data-panel="legend"]')?.hidden === true,
    undefined,
    { timeout: 5_000 },
  );
});

Then('the legend dock chip has focus', async function () {
  await this.page.waitForFunction(
    () => {
      const chip = document.querySelector('#float-dock .dock-chip[data-panel="legend"]');
      return chip != null && document.activeElement === chip;
    },
    undefined,
    { timeout: 5_000 },
  );
});

When('I open the canvas overflow menu', async function () {
  await this.page.click('#tb-overflow');
  await this.page.waitForFunction(
    () => document.getElementById('tb-overflow-menu')?.hidden === false,
    undefined,
    { timeout: 5_000 },
  );
});

Then('the menu item at index {int} has focus', async function (index) {
  await this.page.waitForFunction(
    (position) => {
      const items = [...document.querySelectorAll('#tb-overflow-menu [role="menuitem"]')];
      return document.activeElement === items[position];
    },
    index,
    { timeout: 5_000 },
  );
});

Then('the overflow menu is closed and its trigger has focus', async function () {
  await this.page.waitForFunction(
    () => {
      const menu = document.getElementById('tb-overflow-menu');
      const trigger = document.getElementById('tb-overflow');
      return menu?.hidden === true && document.activeElement === trigger;
    },
    undefined,
    { timeout: 5_000 },
  );
});
