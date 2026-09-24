import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';

import { bundleStyles } from '../../scripts/styles.mjs';

/**
 * The Review and History tabs are declared in the served markup and styled in the sheet.
 * They are wired by the browser controller, which runs on import, so the contract that can
 * be checked from Node is that the markup and styles exist and line up: each top-level
 * screen tab names a section that is present, and the sections are hidden until shown.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(here, '..', '..', 'ui');
const html = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8');
const styles = bundleStyles(uiDir);

const dom = new JSDOM(html);
const { document } = dom.window;

test('the screen tab strip declares Graph, Terminal, Review, and History', () => {
  const tabs = [...document.querySelectorAll('.screen-tabs .screen-tab')];
  assert.deepEqual(
    tabs.map((tab) => tab.id),
    ['screen-tab-graph', 'screen-tab-terminal', 'screen-tab-review', 'screen-tab-history'],
  );
  // Every tab is a tablist member pointing at a screen section that exists.
  for (const tab of tabs) {
    assert.equal(tab.getAttribute('role'), 'tab');
    const controls = tab.getAttribute('aria-controls');
    assert.ok(controls, `${tab.id} should name its screen`);
    assert.ok(document.getElementById(controls), `${tab.id} points at a missing screen`);
  }
});

test('the Review and History screens host a full-width body and start hidden', () => {
  for (const id of ['review-screen', 'history-screen']) {
    const screen = document.getElementById(id);
    assert.ok(screen, `${id} should exist`);
    assert.equal(screen.hidden, true, `${id} should start hidden`);
    assert.ok(screen.classList.contains('screen'), `${id} should share the screen layout`);
    const body = screen.querySelector('.git-screen-body');
    assert.ok(body, `${id} should host a body`);
  }
});

test('the Review screen offers a Pending action and both screens offer Refresh', () => {
  assert.ok(document.getElementById('review-screen-pending'));
  assert.ok(document.getElementById('review-screen-refresh'));
  assert.ok(document.getElementById('history-screen-refresh'));
});

test('the stylesheet lays the Git screens out full-height and hides panels off-graph', () => {
  assert.match(styles, /\.git-screen-body\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(styles, /body\.screen-off-graph\s+\.float-window\s*\{[^}]*display:\s*none/);
});
