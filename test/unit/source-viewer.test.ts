import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;

globalThis.document = window.document;
globalThis.window = window;
globalThis.HTMLElement = window.HTMLElement;
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

const { createSourceViewer } = await import('../../ui/strabo-source-viewer.js');

/**
 * A viewer wired to a scripted `request`, so the fallback's two calls are observable and the
 * rendered panel can be read back. The first `/source` for the bare file rejects, standing in
 * for a file that is no longer on disk.
 */
function setup(handler) {
  const calls = [];
  const sourcePanel = document.createElement('div');
  const app = {
    state: { repository: null, scannedRef: null },
    elements: { sourcePanel },
    floatingWindows: [{ key: 'source', open() {} }],
    request: async (path) => {
      calls.push(path);
      return handler(path);
    },
  };
  const viewer = createSourceViewer(app);
  return { app, viewer, calls, sourcePanel };
}

test('a file the working tree cannot read is shown from the scanned revision', async () => {
  const { app, viewer, calls, sourcePanel } = setup(async (path) => {
    if (path.startsWith('/source?file=gone.ts&ref=')) {
      return { file: 'gone.ts', ref: 'abc1234', content: 'class Gone {}\n' };
    }
    throw new Error('"gone.ts" is not readable as text.');
  });
  app.state.scannedRef = 'abc1234';

  viewer.viewSource('gone.ts');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ['/source?file=gone.ts', '/source?file=gone.ts&ref=abc1234']);
  assert.match(sourcePanel.textContent, /class Gone/);
  assert.equal(sourcePanel.querySelector('[data-role="source-unavailable"]'), null);
});

test('with no scanned revision the working-tree failure stands', async () => {
  const { app, viewer, sourcePanel } = setup(async () => {
    throw new Error('"gone.ts" is not readable as text.');
  });
  app.state.scannedRef = null;

  viewer.viewSource('gone.ts');
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(sourcePanel.textContent, /Unavailable: "gone\.ts" is not readable as text\./);
});
