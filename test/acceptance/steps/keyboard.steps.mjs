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
  // The first enabled chip on the rail; a pinned panel without its context is disabled.
  await this.page.evaluate(() =>
    document.querySelector('#float-dock > .dock-chip:not(:disabled)')?.focus(),
  );
  await this.page.waitForFunction(() =>
    Boolean(document.activeElement?.classList?.contains('dock-chip')),
  );
});

/** The rail's keyboard stops, in order: enabled chips on the rail, then "More". */
Then('the rail item at index {int} has focus', async function (index) {
  await this.page.waitForFunction(
    (position) => {
      const items = [...document.querySelectorAll('#float-dock > .dock-chip, #float-dock > .dock-more')].filter(
        (item) => !item.disabled && !item.hidden,
      );
      return document.activeElement === items[position];
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
