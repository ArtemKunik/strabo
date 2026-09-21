import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ROVING_KEYS, rovingIndex } from '../../ui/strabo-a11y.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const styles = fs.readFileSync(path.resolve(here, '..', '..', 'ui', 'styles.css'), 'utf8');

test('rovingIndex moves and wraps in both orientations', () => {
  assert.equal(rovingIndex(0, 3, 'ArrowRight'), 1);
  assert.equal(rovingIndex(2, 3, 'ArrowRight'), 0);
  assert.equal(rovingIndex(0, 3, 'ArrowLeft'), 2);
  assert.equal(rovingIndex(1, 3, 'ArrowUp'), 0);
  assert.equal(rovingIndex(1, 3, 'ArrowDown'), 2);
});

test('rovingIndex honours Home and End and ignores other keys', () => {
  assert.equal(rovingIndex(2, 4, 'Home'), 0);
  assert.equal(rovingIndex(1, 4, 'End'), 3);
  assert.equal(rovingIndex(1, 4, 'Enter'), null);
  assert.equal(rovingIndex(1, 0, 'ArrowRight'), null);
});

test('rovingIndex can clamp instead of wrap', () => {
  assert.equal(rovingIndex(2, 3, 'ArrowRight', { wrap: false }), 2);
  assert.equal(rovingIndex(0, 3, 'ArrowLeft', { wrap: false }), 0);
});

test('ROVING_KEYS names the six navigation keys', () => {
  assert.deepEqual(ROVING_KEYS, ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);
});

test('the design system defines one focus ring for keyboard focus', () => {
  assert.match(styles, /--focus-ring:/, 'the focus ring should be a token');
  assert.match(styles, /:focus-visible\s*\{[^}]*outline:[^;]*var\(--focus-ring\)/);
});
