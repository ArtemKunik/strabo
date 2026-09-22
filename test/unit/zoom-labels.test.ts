import assert from 'node:assert/strict';
import { test } from 'node:test';

import { labelFontSize } from '../../ui/strabo-view.js';

test('labelFontSize holds the rendered label at the target device size across the zoom range', () => {
  // The two measured extremes: Directories fitted at 5.11, Files at 0.38.
  assert.ok(Math.abs(labelFontSize(5.11) * 5.11 - 10) < 1e-9);
  assert.ok(Math.abs(labelFontSize(0.38) * 0.38 - 10) < 1e-9);
});

test('labelFontSize honours a hub size override', () => {
  assert.equal(labelFontSize(2, 12) * 2, 12);
});

test('labelFontSize falls back to zoom 1 for a missing or unusable zoom', () => {
  assert.equal(labelFontSize(0), 10);
  assert.equal(labelFontSize(-1), 10);
  assert.equal(labelFontSize(Number.NaN), 10);
  assert.equal(labelFontSize(undefined), 10);
});
