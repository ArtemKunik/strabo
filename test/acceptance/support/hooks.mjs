import fs from 'node:fs';
import path from 'node:path';

import { After, AfterAll, Before, BeforeAll, setDefaultTimeout } from '@cucumber/cucumber';
import { chromium } from 'playwright';

import { startServer, stopServer } from './server.mjs';
import { ensureChangeRepo, ensureTimelineRepo } from './git-fixture.mjs';

setDefaultTimeout(60_000);

let browser = null;

BeforeAll(async () => {
  ensureTimelineRepo();
  ensureChangeRepo();
  await startServer();
  browser = await chromium.launch();
});

AfterAll(async () => {
  await browser?.close();
  await stopServer();
});

Before(async function () {
  this.context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  this.page = await this.context.newPage();
  // Opt the page into the automation hook; the app is inert without it.
  await this.page.addInitScript(() => {
    window.STRABO_TEST = true;
  });
});

After(async function (scenario) {
  if (this.page) {
    const directory = path.resolve('test/acceptance/reports/screenshots');
    fs.mkdirSync(directory, { recursive: true });
    const name = scenario.pickle.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const file = path.join(directory, `${name}.png`);
    const buffer = await this.page.screenshot();
    fs.writeFileSync(file, buffer);

    // The concept requires screenshot evidence; fail loudly rather than silently.
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      throw new Error(`Screenshot evidence missing for scenario "${scenario.pickle.name}".`);
    }
    this.attach(buffer, 'image/png');
  }
  await this.page?.close();
  await this.context?.close();
});
