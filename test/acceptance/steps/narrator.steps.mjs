import assert from 'node:assert/strict';
import http from 'node:http';

import { After, Given, Then, When } from '@cucumber/cucumber';

/**
 * A loopback chat-completions stub, so the narrator can be set up against a real
 * endpoint without contacting a third party. One stub per scenario; closed in After.
 */
const stubs = new Set();

After(async function () {
  for (const stub of stubs) {
    await new Promise((resolve) => stub.server.close(resolve));
    stubs.delete(stub);
  }
});

function startStub(reply = 'The stub says the wiring is recorded.') {
  const server = http.createServer((request, response) => {
    const url = request.url ?? '';
    if (request.method === 'GET' && url.endsWith('/models')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'stub-model' }, { id: 'stub-model-mini' }] }));
      return;
    }
    if (request.method === 'POST' && url.endsWith('/chat/completions')) {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({ model: 'stub-model', choices: [{ message: { role: 'assistant', content: reply } }] }),
        );
      });
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const stub = { server, port, url: `http://127.0.0.1:${port}/v1/chat/completions` };
      stubs.add(stub);
      resolve(stub);
    });
  });
}

Given('a loopback narrator stub is running', async function () {
  this.narratorStub = await startStub();
  // A second stub on a different port, for the host-change scenario.
  this.narratorStubTwo = await startStub();
});

/**
 * Close the floating panels that cover the inspector or the canvas.
 *
 * The first-visit Repository passport opens automatically and floats over the left
 * side, so it must be dismissed before a step can click into the inspector.
 */
async function closeFloatingPanels(page, exceptKey = null) {
  await page.evaluate((except) => {
    for (const controller of window.straboTest?.floatingWindows?.() ?? []) {
      // The inspector is itself a floating window and is exactly what we need to reach.
      if (controller.key === 'inspector' || controller.key === except) continue;
      if (controller.isOpen?.()) controller.toggle();
    }
  }, exceptKey);
}

/** Open the Settings floating window and wait for the Narrator section to load. */
async function openNarratorSettings(page) {
  const hidden = await page.evaluate(() => document.getElementById('settings-panel')?.hidden ?? true);
  if (hidden) {
    await page.click('#settings-toggle');
  }
  await page.waitForSelector('#setting-narrator #narrator-endpoint', { timeout: 15_000 });
}

When('I open the Settings window', async function () {
  await openNarratorSettings(this.page);
});

When('I set the narrator endpoint to the stub and model {string}', async function (model) {
  await this.page.fill('#narrator-endpoint', this.narratorStub.url);
  await this.page.fill('#narrator-model', model);
});

When('I change the narrator endpoint host', async function () {
  // Save the new host through the same-origin API. Driving it through the UI would not
  // re-read the stored key from the server, so a key the server rejected could still read as
  // present; the endpoint must be registered first, exactly as the save handler does it.
  const host = new URL(this.narratorStubTwo.url).host;
  const result = await this.page.evaluate(async (endpointHost) => {
    const saved = await fetch('/api/strabo/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ narrator: { endpoint: `http://${endpointHost}/v1/chat/completions` } }),
    });
    const body = await saved.json().catch(() => ({}));
    // Reload the page so it re-reads `/settings` and the `/narrator` status the way a fresh
    // session would, rather than trusting in-place UI state.
    window.location.reload();
    return { ok: saved.ok, keyCleared: body?.narrator?.keyCleared === true };
  }, host);
  assert.equal(result.ok, true, 'saving the narrator endpoint should succeed');
  assert.equal(result.keyCleared, true, 'a host change must clear the stored key');
  await this.page.waitForFunction(() => window.straboTest?.model() != null, undefined, { timeout: 20_000 });
  // The reload closed Settings; reopen it so the panel can report the key state.
  await openNarratorSettings(this.page);
});

/**
 * Clear the narrator setup so a scenario starts from "off".
 *
 * The settings the narrator scenarios write persist on the server for the whole run (the
 * state file outlives the browser), so a scenario that expects the narrator to be off must
 * ask for it explicitly rather than relying on ordering. Routed through the same-origin
 * `PUT /settings` the app uses, driving no UI.
 */
When('I reset the narrator setup', async function () {
  const response = await this.page.evaluate(async () => {
    const result = await fetch('/api/strabo/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ narrator: { reset: true } }),
    });
    return { ok: result.ok, status: result.status };
  });
  assert.equal(response.ok, true, `resetting the narrator responded ${response.status}`);
  // The page cached the previous narrator status when it loaded; reload so every affordance
  // is rebuilt from the reset state rather than from a status a prior scenario set up.
  await this.page.reload();
  await this.page.waitForFunction(() => window.straboTest?.model() != null, undefined, { timeout: 20_000 });
});

When('I save the narrator settings', async function () {
  await this.page.click('#narrator-save');
  await this.page.waitForFunction(
    () => {
      const note = document.querySelector('#setting-narrator .setting-note');
      return note != null && !/Loading narrator settings/.test(document.getElementById('setting-narrator')?.textContent ?? '');
    },
    undefined,
    { timeout: 15_000 },
  );
});

When('I store a narrator key', async function () {
  await this.page.selectOption('#narrator-key-source', 'stored');
  await this.page.waitForSelector('#narrator-key', { timeout: 15_000 });
  await this.page.fill('#narrator-key', 'stub-secret-key');
  await this.page.click('#narrator-key-store');
  await this.page.waitForFunction(
    () => /stored on this machine/i.test(document.getElementById('setting-narrator')?.textContent ?? ''),
    undefined,
    { timeout: 15_000 },
  );
});

Then('the narrator panel reports the key is stored', async function () {
  const text = (await this.page.textContent('#setting-narrator')) ?? '';
  assert.match(text, /stored on this machine/i);
});

Then('the narrator panel reports the key is missing', async function () {
  // "Missing" is the panel's own status line for a host with no key; it is independent of
  // which key-source mode the panel happens to be showing.
  await this.page.waitForFunction(
    () => /Key missing/i.test(document.getElementById('setting-narrator')?.textContent ?? ''),
    undefined,
    { timeout: 15_000 },
  );
  const text = (await this.page.textContent('#setting-narrator')) ?? '';
  assert.doesNotMatch(text, /Key stored on this machine for this host/i);
});

When('I narrate the {string} file', async function (_id) {
  // Settings and the first-visit passport would otherwise cover the inspector.
  await closeFloatingPanels(this.page);
  await this.openInspectorTab('functions');
  await this.page.waitForSelector('#inspector #narrate-functions', { timeout: 15_000 });
  await this.page.waitForFunction(
    () => document.getElementById('narrate-functions')?.disabled === false,
    undefined,
    { timeout: 15_000 },
  );
  await this.page.click('#inspector #narrate-functions');
});

Then('the narrative reports the stub reply', async function () {
  await this.page.waitForFunction(
    () => /stub says the wiring is recorded/i.test(
      document.querySelector('#inspector [data-role="narrative"]')?.textContent ?? '',
    ),
    undefined,
    { timeout: 20_000 },
  );
  const reply = (await this.page.textContent('#inspector [data-role="narrative"]')) ?? '';
  assert.match(reply, /Model-generated narrative/);
});

When('I narrate the change set', async function () {
  // Settings and the first-visit passport would otherwise cover the review panel; the review
  // is a floating window too, so it is kept open while the others are dismissed.
  await closeFloatingPanels(this.page, 'review');
  await this.page.waitForSelector('#review-panel #narrate-change', { timeout: 15_000 });
  await this.page.waitForFunction(
    () => document.getElementById('narrate-change')?.disabled === false,
    undefined,
    { timeout: 15_000 },
  );
  await this.page.click('#review-panel #narrate-change');
});

Then('the review narrative reports the stub reply', async function () {
  await this.page.waitForFunction(
    () => /stub says the wiring is recorded/i.test(
      document.querySelector('#review-panel [data-role="narrative"]')?.textContent ?? '',
    ),
    undefined,
    { timeout: 20_000 },
  );
  const reply = (await this.page.textContent('#review-panel [data-role="narrative"]')) ?? '';
  assert.match(reply, /Model-generated narrative/);
});

Then('the inspector offers the narrator and reports it is off', async function () {
  await closeFloatingPanels(this.page);
  await this.openInspectorTab('functions');
  await this.page.waitForFunction(
    () => /off/i.test(document.querySelector('#inspector .narrator-note')?.textContent ?? ''),
    undefined,
    { timeout: 15_000 },
  );
  const note = (await this.page.textContent('#inspector .narrator-note')) ?? '';
  assert.match(note, /off/i);

  // One call to action, and the Narrate button is disabled with the reason as its tooltip.
  await this.page.waitForSelector('#inspector [data-role="narrator-setup"]', { timeout: 15_000 });
  const disabled = await this.page.evaluate(() => {
    const button = document.getElementById('narrate-functions');
    return { disabled: button?.disabled === true, title: button?.title ?? '' };
  });
  assert.equal(disabled.disabled, true, 'Narrate should be disabled while the narrator is off');
  assert.match(disabled.title, /off|set it up/i);
});

Then('the review panel offers the narrator and reports it is off', async function () {
  // The panel is rendered from the narrator status the page loaded with; make sure the status
  // reflects the reset before reading it, so a previous scenario's setup cannot leak through.
  await this.page.waitForFunction(
    () =>
      /off/i.test(
        document.querySelector('#review-panel .review-narrator .narrator-note')?.textContent ?? '',
      ),
    undefined,
    { timeout: 15_000 },
  );
  await this.page.waitForSelector('#review-panel .review-narrator .narrator-note', { timeout: 15_000 });
  const note = (await this.page.textContent('#review-panel .review-narrator .narrator-note')) ?? '';
  assert.match(note, /off/i);

  // One call to action, and the Narrate change button is disabled with the reason as its tooltip.
  await this.page.waitForSelector('#review-panel [data-role="narrator-setup"]', { timeout: 15_000 });
  const disabled = await this.page.evaluate(() => {
    const button = document.getElementById('narrate-change');
    return { disabled: button?.disabled === true, title: button?.title ?? '' };
  });
  assert.equal(disabled.disabled, true, 'Narrate change should be disabled while the narrator is off');
  assert.match(disabled.title, /off|set it up/i);
});
