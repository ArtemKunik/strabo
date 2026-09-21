import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

import { createFreshnessBadge } from '../../ui/strabo-freshness.js';

const dom = new JSDOM(
  '<!doctype html><html><body><button id="freshness" hidden></button></body></html>',
);
const { window } = dom;
globalThis.document = window.document;

function element() {
  const badge = document.getElementById('freshness');
  badge.hidden = true;
  badge.textContent = '';
  badge.className = '';
  return badge;
}

test('the badge stays hidden when no revision was indexed', async () => {
  const target = element();
  const badge = createFreshnessBadge(target, {
    request: async () => ({ indexed: { revision: null }, stale: false }),
  });
  await badge.refresh({ repository: 'demo' });
  assert.equal(target.hidden, true);
});

test('the badge names the indexed revision and offers a rebuild when stale', async () => {
  const target = element();
  const badge = createFreshnessBadge(target, {
    request: async () => ({ indexed: { revision: 'abcdef1234567' }, stale: true, behind: 3 }),
  });
  await badge.refresh({ repository: 'demo' });
  assert.equal(target.hidden, false);
  assert.match(target.textContent, /indexed at abcdef1 \(3 behind\)/);
  assert.match(target.textContent, /Rebuild/);
  assert.equal(target.classList.contains('is-stale'), true);
});

test('a fresh map names the revision without a rebuild action', async () => {
  const target = element();
  const badge = createFreshnessBadge(target, {
    request: async () => ({ indexed: { revision: 'abcdef1234567' }, stale: false }),
  });
  await badge.refresh({});
  assert.match(target.textContent, /^indexed at abcdef1$/);
  assert.equal(target.classList.contains('is-stale'), false);
});

test('a failed status request hides the badge rather than inventing one', async () => {
  const target = element();
  const badge = createFreshnessBadge(target, {
    request: async () => {
      throw new Error('offline');
    },
  });
  await badge.refresh({});
  assert.equal(target.hidden, true);
});
