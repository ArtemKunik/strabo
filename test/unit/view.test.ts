import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Fragment, h, host } from '../../ui/view.js';

test('h builds a vnode and lifts key out of props', () => {
  const vnode = h('button', { type: 'button', className: 'chip', key: 'k', dataset: { filter: 'x' } }, 'label');

  assert.equal(vnode.type, 'button');
  assert.equal(vnode.key, 'k');
  assert.deepEqual(vnode.props, { type: 'button', className: 'chip', dataset: { filter: 'x' } });
  assert.deepEqual(vnode.children, [
    { type: '#text', text: 'label', props: {}, key: null, children: [] },
  ]);
});

test('h skips empty children, flattens arrays, and converts numbers to text', () => {
  const vnode = h('div', null, ['a', null, false, 3, h('span', { key: 's' }, 'b')]);

  assert.equal(vnode.key, null);
  assert.deepEqual(
    vnode.children.map((child) => (child.type === '#text' ? child.text : child.key)),
    ['a', '3', 's'],
  );
});

test('h returns a fragment that groups children without a wrapper', () => {
  const vnode = h(Fragment, null, h('i'), h('b'));

  assert.equal(vnode.type, Fragment);
  assert.equal(vnode.children.length, 2);
});

test('host embeds an external element and is accepted as a child', () => {
  const embedded = host('main:x', () => null);
  const parent = h('div', null, embedded);

  assert.equal(embedded.key, 'main:x');
  assert.equal(typeof embedded.create, 'function');
  assert.equal(parent.children[0], embedded);
});
