import assert from 'node:assert/strict';

import { Given, Then, When } from '@cucumber/cucumber';

import { ACCEPTANCE_ROOT } from '../support/server.mjs';

const CACHE_STATUS = /cache:\s*(memory|disk|miss|refreshed)/;

Given('the Strabo server is running against the fixture repository', async function () {
  const response = await fetch(`${this.baseUrl}/api/strabo/health`);
  assert.equal(response.ok, true, 'health endpoint should respond');
  // The repository list persists between scenarios; start each one on the fixture root.
  await fetch(`${this.baseUrl}/api/strabo/repositories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: ACCEPTANCE_ROOT }),
  });
});

Given('I open the Strabo UI', async function () {
  await this.page.goto(this.baseUrl);
  await this.page.waitForFunction(() => window.straboTest?.model() != null, undefined, {
    timeout: 20_000,
  });
});

When('I switch to file detail', async function () {
  const before = await this.page.evaluate(() => window.straboTest.renderedGeneration());
  await this.page.selectOption('#detail', 'file');
  await this.page.waitForFunction(
    (generation) =>
      window.straboTest?.state.mode === 'file' &&
      window.straboTest.renderedGeneration() > generation,
    before,
  );
});

When('I reload the Strabo UI', async function () {
  await this.page.reload();
  await this.page.waitForFunction(() => window.straboTest?.model() != null, undefined, {
    timeout: 20_000,
  });
});

Then('the detail selector shows {string}', async function (value) {
  const selected = await this.page.inputValue('#detail');
  assert.equal(selected, value);
});

When('I double-click the {string} node', async function (id) {
  const before = await this.page.evaluate(() => window.straboTest.renderedGeneration());
  await this.clickNode(id, {
    double: true,
    settled: (nodeId) => window.straboTest?.state.prefix === nodeId,
  });
  await this.page.waitForFunction(
    (generation) => window.straboTest.renderedGeneration() > generation,
    before,
    { timeout: 15_000 },
  );
});

When('I select the {string} node', async function (id) {
  await this.clickNode(id, {
    settled: (nodeId) => {
      const inspector = document.getElementById('inspector');
      return !inspector.hidden && inspector.textContent.includes(nodeId);
    },
  });
});

When('I trace to the first listed dependency', async function () {
  const button = this.page.locator('#inspector .trace-button').first();
  assert.ok((await button.count()) > 0, 'inspector should list a dependency to trace');
  await button.click();
});

When('I open the diagnostics panel', async function () {
  await this.page.click('#diagnostics-toggle');
  await this.page.waitForFunction(
    () => !document.getElementById('diagnostics').hidden &&
      document.getElementById('diagnostics').textContent.includes('Diagnostics'),
  );
});

When('I press Refresh', async function () {
  await this.page.click('#refresh');
});

When('I open the folder dialog', async function () {
  await this.page.click('#browse');
  await this.page.waitForFunction(() => document.getElementById('folder-dialog')?.open === true);
  await this.page.waitForFunction(
    () => document.querySelectorAll('#folder-list .folder').length > 0,
  );
});

When('I go up one folder', async function () {
  const before = (await this.page.textContent('#folder-path')) ?? '';
  await this.page.click('#folder-up');
  await this.page.waitForFunction(
    (previous) => (document.getElementById('folder-path')?.textContent ?? '') !== previous,
    before,
  );
});

When('I choose the {string} folder', async function (name) {
  await this.page.locator('#folder-list .folder').filter({ hasText: name }).first().click();
  await this.page.waitForFunction(
    (folder) => (document.getElementById('folder-path')?.textContent ?? '').endsWith(folder),
    name,
  );
});

When('I use the selected folder', async function () {
  const before = await this.page.evaluate(() => window.straboTest.renderedGeneration());
  await this.page.click('#folder-use');
  await this.page.waitForFunction(
    (generation) => window.straboTest.renderedGeneration() > generation,
    before,
    { timeout: 20_000 },
  );
});

Then('the folder dialog reports it has reached the scan ceiling', async function () {
  await this.page.waitForFunction(
    () => {
      const note = document.getElementById('folder-note');
      return Boolean(note) && note.classList.contains('at-ceiling');
    },
    undefined,
    { timeout: 15_000 },
  );
  const note = (await this.page.textContent('#folder-note')) ?? '';
  assert.match(note, /Scan ceiling reached/);
  assert.match(note, /STRABO_SCAN_CEILING/);

  const disabled = await this.page.evaluate(
    () => document.getElementById('folder-up')?.disabled === true,
  );
  assert.equal(disabled, true, 'Up should be disabled at the ceiling');
});

When('I select an edge from the {string} node', async function (id) {
  await this.clickEdge(id, () => {
    const panel = document.getElementById('edge-panel');
    return Boolean(panel) && !panel.hidden && panel.textContent.includes('Edge ·');
  });
});

Then('the edge panel reports the relationship and resolution', async function () {
  const text = (await this.page.textContent('#edge-panel')) ?? '';
  assert.match(text, /Edge · \w+/);
  assert.match(text, /Specifier/);
  assert.match(text, /Line/);
  assert.match(text, /Resolution/);
});

Then('the repository is {string}', async function (name) {
  const repository = await this.page.evaluate(() => window.straboTest.state.repository);
  assert.equal(repository.split(/[\\/]/).filter(Boolean).pop(), name);
});

Then('the repository picker lists {string}', async function (name) {
  await this.page.waitForFunction(
    (expected) => {
      const options = [...document.querySelectorAll('#repository option')];
      return options.some((option) => option.textContent === expected);
    },
    name,
    { timeout: 15_000 },
  );
});

Then('the repository picker lists the fixture repository', async function () {
  await this.page.waitForFunction(
    () => document.querySelectorAll('#repository option').length > 0,
    undefined,
    { timeout: 15_000 },
  );
});

When('I select the remembered {string} repository', async function (name) {
  const before = await this.page.evaluate(() => window.straboTest.renderedGeneration());
  await this.page.selectOption('#repository', { label: name });
  await this.page.waitForFunction(
    (generation) => window.straboTest.renderedGeneration() > generation,
    before,
    { timeout: 20_000 },
  );
});

Then('the repository picker marks {string} as active', async function (name) {
  const selected = await this.page.evaluate(() => {
    const option = document.querySelector('#repository option:checked');
    return option ? option.textContent : null;
  });
  assert.equal(selected, name);
});

When('I select the review overlay {string}', async function (kind) {
  await this.page.selectOption('#overlay', kind);
  await this.page.waitForFunction(
    (expected) =>
      window.straboTest?.state.overlay === expected &&
      !document.getElementById('overlay-panel').hidden,
    kind,
    { timeout: 20_000 },
  );
});

Then('the overlay panel reports at least one cycle', async function () {
  const text = (await this.page.textContent('#overlay-panel')) ?? '';
  const match = /(\d+) cycle/.exec(text);
  assert.ok(match, `overlay panel "${text}" should report cycles`);
  assert.ok(Number(match[1]) > 0, `expected at least one cycle, got ${match[1]}`);
});

Then('the overlay panel reports unreached modules', async function () {
  const text = (await this.page.textContent('#overlay-panel')) ?? '';
  const match = /(\d+) unreached/.exec(text);
  assert.ok(match, `overlay panel "${text}" should report unreached modules`);
  assert.ok(Number(match[1]) > 0, `expected unreached modules, got ${match[1]}`);
});

Then('the overlay panel reports a health score', async function () {
  const text = (await this.page.textContent('#overlay-panel')) ?? '';
  assert.match(text, /score \d+\/100/);
});

Then('the overlay panel lists health axes', async function () {
  const text = (await this.page.textContent('#overlay-panel')) ?? '';
  assert.match(text, /Cohesion/);
  assert.match(text, /Low coupling/);
  assert.match(text, /Coverage/);
});

When('I open the timeline', async function () {
  await this.page.click('#tb-timeline');
  await this.page.waitForFunction(
    () =>
      !document.getElementById('timeline-panel').hidden &&
      document.querySelectorAll('#timeline-panel .commit').length > 0,
    undefined,
    { timeout: 15_000 },
  );
});

Then('the timeline lists recorded changes', async function () {
  const text = (await this.page.textContent('#timeline-panel')) ?? '';
  assert.match(text, /initial import/);
});

When('I select the most recent change', async function () {
  await this.page.locator('#timeline-panel .commit').first().click();
  await this.page.waitForFunction(
    () => {
      const panel = document.getElementById('review-panel');
      return !panel.hidden && /file\(s\)/.test(panel.textContent);
    },
    undefined,
    { timeout: 15_000 },
  );
});

Then('the overlay panel reports changed files', async function () {
  const text = (await this.page.textContent('#review-panel')) ?? '';
  const match = /(\d+) file\(s\)/.exec(text);
  assert.ok(match, `review panel "${text}" should report changed files`);
  assert.ok(Number(match[1]) > 0, `expected at least one changed file, got ${match[1]}`);
});

When('I open the working-tree review', async function () {
  await this.page.click('#tb-review');
  await this.page.waitForFunction(
    () => {
      const panel = document.getElementById('review-panel');
      return !panel.hidden && /file\(s\)/.test(panel.textContent);
    },
    undefined,
    { timeout: 15_000 },
  );
});

Then('the review panel reports the commit and its changed files', async function () {
  const panel = await this.page.textContent('#review-panel');
  const commit = await this.page.textContent('#review-panel [data-role="review-commit"]');
  assert.match(commit ?? '', /\w+ · .+ · \d{4}-\d{2}-\d{2} · .+/);
  assert.match(panel ?? '', /Commit review/);
  assert.match(panel ?? '', /file\(s\)/);
});

Then('the review panel reports a working-tree review', async function () {
  const panel = (await this.page.textContent('#review-panel')) ?? '';
  assert.match(panel, /Working tree review/);
  assert.match(panel, /file\(s\)/);
  // The fixture leaves one uncommitted edit, so the group must be labelled explicitly.
  assert.match(panel, /Unstaged \(\d+\)/);
});

Then('the change passport reports a cohesion delta', async function () {
  await this.page.waitForSelector('#review-panel [data-role="change-passport"]', {
    timeout: 15_000,
  });
  const text = (await this.page.textContent('#review-panel [data-role="change-passport"]')) ?? '';
  assert.match(text, /Counter\.kt/);
  assert.match(text, /cohesion 67 → 100 \(\+33\)/);
});

Then('the status line reports nodes and a cache status', async function () {
  const status = (await this.page.textContent('#status')) ?? '';
  assert.match(status, /\d+ nodes . \d+ edges/);
  assert.match(status, CACHE_STATUS);
});

Then('the graph contains the directory block {string}', async function (id) {
  await this.page.waitForFunction(
    (nodeId) => window.straboTest?.model()?.nodes.some((node) => node.id === nodeId),
    id,
    { timeout: 15_000 },
  );
});

Then('the breadcrumb shows {string}', async function (label) {
  const text = (await this.page.textContent('#breadcrumb')) ?? '';
  assert.ok(text.includes(label), `breadcrumb "${text}" should include "${label}"`);
});

Then('the breadcrumb includes {string}', async function (label) {
  const text = (await this.page.textContent('#breadcrumb')) ?? '';
  assert.ok(text.includes(label), `breadcrumb "${text}" should include "${label}"`);
});

Then('the inspector is shown for {string}', async function (id) {
  const visible = await this.page.evaluate(() => !document.getElementById('inspector').hidden);
  assert.equal(visible, true);
  const text = (await this.page.textContent('#inspector')) ?? '';
  assert.ok(text.includes(id), `inspector should describe "${id}"`);
});

Then('the inspector lists dependencies and dependents', async function () {
  const text = (await this.page.textContent('#inspector')) ?? '';
  assert.match(text, /Dependencies \(\d+\)/);
  assert.match(text, /Dependents \(\d+\)/);
});

Then('the trace reports a step count or an explicit no-path', async function () {
  const text = (await this.page.textContent('#inspector [data-role="trace"]')) ?? '';
  assert.match(text, /(\d+ step\(s\))|(No directed path)/);
});

Then('the diagnostics panel reports counts', async function () {
  const text = (await this.page.textContent('#diagnostics')) ?? '';
  assert.match(text, /Diagnostics · \d+/);
  assert.match(text, /excluded: \d+/);
});

Then('the status line reports cache status {string}', async function (status) {
  await this.page.waitForFunction(
    (expected) => (document.getElementById('status')?.textContent ?? '').includes(`cache: ${expected}`),
    status,
    { timeout: 20_000 },
  );
});

Then('the vulnerabilities endpoint reports available false', async function () {
  const response = await fetch(`${this.baseUrl}/api/strabo/vulnerabilities`);
  assert.equal(response.ok, true);
  const body = await response.json();
  assert.equal(body.available, false);
});

Then('the graph endpoint still responds', async function () {
  const response = await fetch(`${this.baseUrl}/api/strabo/graph`);
  assert.equal(response.ok, true);
  const body = await response.json();
  assert.ok(body.nodes.length > 0);
});
