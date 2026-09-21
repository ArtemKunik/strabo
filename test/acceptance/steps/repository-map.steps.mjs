import assert from 'node:assert/strict';

import { Given, Then, When } from '@cucumber/cucumber';

import { ACCEPTANCE_ROOT } from '../support/server.mjs';

const CACHE_STATUS = /cache:\s*(memory|disk|miss|refreshed)/;

/**
 * Click a canvas-toolbar action that may live in the "More actions" overflow menu.
 *
 * Timeline, review, and risk moved behind `#tb-overflow`; open the menu when the target
 * is not already visible so the step keeps working regardless of the toolbar width.
 */
async function clickToolbarAction(page, id) {
  if (!(await page.locator(`#${id}`).isVisible())) {
    await page.click('#tb-overflow');
    await page.waitForFunction(() => document.getElementById('tb-overflow-menu')?.hidden === false, undefined, {
      timeout: 5_000,
    });
  }
  await page.click(`#${id}`);
}

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

When('I close the open panels', async function () {
  await this.page.evaluate(() => {
    for (const controller of window.straboTest?.floatingWindows?.() ?? []) {
      if (controller.isOpen?.()) controller.toggle();
    }
  });
});

When('I open the folder dialog', async function () {
  await this.dismissPassportGreeting();
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
  await clickToolbarAction(this.page, 'tb-timeline');
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

When('I open the branches panel', async function () {
  await clickToolbarAction(this.page, 'tb-branches');
  await this.page.waitForSelector('#branches-panel [data-role="branches-list"]', { timeout: 15_000 });
});

Then('the branches panel lists {string} with unmerged work', async function (name) {
  const row = this.page.locator('#branches-panel .branch-row', {
    has: this.page.locator(`.branch[data-branch="${name}"]`),
  });
  const divergence = (await row.locator('[data-role="branch-divergence"]').textContent()) ?? '';
  assert.match(divergence, /↑1/);
  assert.doesNotMatch((await row.textContent()) ?? '', /merged/);
});

When('I select the {string} branch', async function (name) {
  await this.page.click(`#branches-panel .branch[data-branch="${name}"]`);
  await this.page.waitForSelector('#review-panel [data-role="review-merge"]', { timeout: 15_000 });
});

Then('the review panel reports a branch review with a merge verdict', async function () {
  const panel = (await this.page.textContent('#review-panel')) ?? '';
  assert.match(panel, /Branch review · feature\/acceptance/);
  assert.match(panel, /1 commit\(s\) ahead of/);
  assert.match((await this.page.textContent('#review-panel [data-role="review-merge"]')) ?? '', /Merges cleanly/);
  assert.match(panel, /Changed on the branch \(1\)/);
});

When('I open the working-tree review', async function () {
  await clickToolbarAction(this.page, 'tb-review');
  await this.page.waitForFunction(
    () => {
      const panel = document.getElementById('review-panel');
      return !panel.hidden && /file\(s\)/.test(panel.textContent);
    },
    undefined,
    { timeout: 15_000 },
  );
});

When('I review the working tree through the automation hook', async function () {
  await this.page.evaluate(() => window.straboTest.review());
  await this.page.waitForFunction(() => !document.getElementById('review-panel').hidden, undefined, {
    timeout: 20_000,
  });
  const info = await this.page.evaluate(() => {
    const cy = window.straboTest?.cy;
    return {
      changed: cy ? cy.nodes('.ov-changed').length : -1,
      affected: cy ? cy.nodes('.ov-affected').length : -1,
      nodes: cy ? cy.nodes().length : -1,
      text: (document.getElementById('review-panel').textContent || '').slice(0, 160),
    };
  });
  assert.ok(
    info.changed > 0 && info.affected > 0,
    `expected changed and affected overlays: ${JSON.stringify(info)}`,
  );
});

Then('a changed node and an affected node differ by more than hue', async function () {
  const handle = await this.page.waitForFunction(
    () => {
      const cy = window.straboTest?.cy;
      if (!cy) return null;
      const changed = cy.nodes('.ov-changed').first();
      const affected = cy.nodes('.ov-affected').first();
      if (changed.empty() || affected.empty()) return null;
      return {
        changedStyle: changed.style('border-style'),
        affectedStyle: affected.style('border-style'),
        changedWidth: changed.style('border-width'),
        affectedWidth: affected.style('border-width'),
      };
    },
    undefined,
    { timeout: 20_000 },
  );
  const value = await handle.jsonValue();
  assert.ok(value, 'expected both a changed node and an affected node on the map');
  assert.ok(
    value.changedStyle !== value.affectedStyle || value.changedWidth !== value.affectedWidth,
    `changed and affected differ only by hue: ${JSON.stringify(value)}`,
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

Then('the review panel offers Back with nothing behind it', async function () {
  const back = this.page.locator('#review-panel [data-role="panel-back"]');
  assert.equal(await back.count(), 1, 'the review panel should offer Back');
  assert.equal(await back.isDisabled(), true, 'Back should be disabled with no earlier review');
});

Then('the review panel can step back to the working-tree review', async function () {
  const back = this.page.locator('#review-panel [data-role="panel-back"]');
  assert.equal(await back.isDisabled(), false, 'Back should be enabled after a commit review');
  await back.click();
  await this.page.waitForFunction(
    () => /Working tree review/.test(document.getElementById('review-panel')?.textContent ?? ''),
    undefined,
    { timeout: 15_000 },
  );
  const disabled = await this.page.locator('#review-panel [data-role="panel-back"]').isDisabled();
  assert.equal(disabled, true, 'Back should be disabled again at the start of the history');
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
  // Cache/renderer vocabulary lives in Diagnostics, not the header.
  await this.page.evaluate(() => {
    if (document.getElementById('diagnostics')?.hidden) {
      document.getElementById('diagnostics-toggle')?.click();
    }
  });
  const diagnostics = (await this.page.textContent('#diagnostics')) ?? '';
  assert.match(diagnostics, CACHE_STATUS);
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
  await this.page.evaluate(() => {
    if (document.getElementById('diagnostics')?.hidden) {
      document.getElementById('diagnostics-toggle')?.click();
    }
  });
  await this.page.waitForFunction(
    (expected) =>
      (document.getElementById('diagnostics')?.textContent ?? '').includes(`cache: ${expected}`),
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

Then('the map draws no directory islands', async function () {
  const directories = await this.page.evaluate(() => window.straboTest.islands());
  assert.deepEqual(directories, [], 'block mode aggregates directories into nodes already');
  assert.equal(await this.page.locator('.island-plate').count(), 0);
});

Then('the map draws a directory island for {string}', async function (directory) {
  const directories = await this.page.evaluate(() => window.straboTest.islands());
  assert.ok(
    directories.includes(directory),
    `expected an island for ${directory}, got ${directories.join(', ')}`,
  );
});

Then('every directory island has a plate on the canvas', async function () {
  const directories = await this.page.evaluate(() => window.straboTest.islands());
  assert.equal(await this.page.locator('.island-plate').count(), directories.length);
});

/*
 * A plate too small to hold its name drops the label rather than overflowing onto the
 * neighbouring island, and a label wider than its plate is trimmed to the tail, so the
 * contract is that every label drawn names a directory that is drawn — not that every
 * island carries one.
 */
Then('every island label names a drawn directory', async function () {
  const directories = await this.page.evaluate(() => window.straboTest.islands());
  const names = directories.map((directory) => (directory === '.' ? '/' : directory));
  const labels = await this.page.locator('.island-label:not(.is-hidden)').allTextContents();
  assert.ok(labels.length > 0, 'the fixture has islands wide enough to name');
  for (const label of labels) {
    const matches = label.startsWith('…')
      ? names.some((name) => name.endsWith(label.slice(1)))
      : names.includes(label);
    assert.ok(matches, `label ${label} matches no drawn directory in ${names.join(', ')}`);
  }
});
