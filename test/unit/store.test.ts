import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createStore } from '../../ui/store.js';

test('set merges a patch into a slice and notifies which slice changed', () => {
  const store = createStore({ view: { mode: 'block' }, member: { find: '' } });
  const seen = [];
  store.subscribe((state, changed) => seen.push([state.view.mode, { ...changed }]));

  store.set('view', { mode: 'file' });

  assert.equal(store.get().view.mode, 'file');
  assert.deepEqual(seen, [['file', { view: true }]]);
});

test('set accepts an updater and keeps the slice object identity', () => {
  const store = createStore({ member: { stepIndex: 0 } });
  const slice = store.get().member;

  store.set('member', (current) => ({ stepIndex: current.stepIndex + 1 }));

  assert.equal(slice.stepIndex, 1);
  assert.equal(store.get().member, slice);
});

test('commit notifies without changing state, and unsubscribe stops delivery', () => {
  const store = createStore({ view: { mode: 'block' } });
  const calls = [];
  const unsubscribe = store.subscribe((_, changed) => calls.push(changed));

  store.commit('view');
  unsubscribe();
  store.commit('view');

  assert.deepEqual(calls, [{ view: true }]);
  assert.equal(store.get().view.mode, 'block');
});

test('set on an unknown slice throws rather than silently doing nothing', () => {
  const store = createStore({ view: {} });
  assert.throws(() => store.set('nope', {}), /Unknown store slice/);
});
