import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  averageFrameTimes,
  createFrameSampler,
  edgeLodHidden,
  viewportPerfFor,
} from '../../ui/strabo-perf.js';

test('viewportPerfFor arms the fast paths only past the element gate', () => {
  assert.deepEqual(viewportPerfFor(100, 100), {
    enabled: false,
    textureOnViewport: false,
    hideEdgesOnViewport: false,
  });
  const armed = viewportPerfFor(1000, 600);
  assert.equal(armed.enabled, true);
  assert.equal(armed.textureOnViewport, true);
  assert.equal(armed.hideEdgesOnViewport, true);
});

test('viewportPerfFor treats a missing count as zero', () => {
  assert.equal(viewportPerfFor(undefined, undefined).enabled, false);
});

test('edgeLodHidden drops hairline edges only on a large graph zoomed far out', () => {
  assert.equal(edgeLodHidden(1, 0.2, 5000), true);
  // A weighted roll-up carries information the overview still uses.
  assert.equal(edgeLodHidden(2, 0.2, 5000), false);
  // Zoomed in, every edge draws.
  assert.equal(edgeLodHidden(1, 0.9, 5000), false);
  // A small graph is never thinned.
  assert.equal(edgeLodHidden(1, 0.2, 100), false);
});

test('edgeLodHidden treats a missing weight as unit weight', () => {
  assert.equal(edgeLodHidden(undefined, 0.2, 5000), true);
  assert.equal(edgeLodHidden(Number.NaN, 0.2, 5000), true);
});

test('averageFrameTimes turns a window of timestamps into fps and milliseconds', () => {
  assert.deepEqual(averageFrameTimes([0, 16, 32]), { frames: 2, fps: 62.5, ms: 16 });
});

test('averageFrameTimes refuses to invent a rate from too few samples', () => {
  assert.deepEqual(averageFrameTimes([]), { frames: 0, fps: null, ms: null });
  assert.deepEqual(averageFrameTimes([10]), { frames: 0, fps: null, ms: null });
  assert.deepEqual(averageFrameTimes(undefined), { frames: 0, fps: null, ms: null });
});

test('createFrameSampler records painted-frame intervals and stops cleanly', () => {
  let callback: ((now: number) => void) | null = null;
  let nextId = 1;
  const win = {
    requestAnimationFrame(handler: (now: number) => void) {
      callback = handler;
      return nextId++;
    },
    cancelAnimationFrame() {
      callback = null;
    },
  };
  const sampler = createFrameSampler(win as unknown as Window, 4);

  assert.equal(sampler.active(), false);
  sampler.start();
  assert.equal(sampler.active(), true);
  for (const now of [0, 16, 32, 48]) {
    const handler = callback;
    callback = null;
    handler?.(now);
  }
  const stats = sampler.stats();
  assert.equal(stats.frames, 3);
  assert.ok(Math.abs((stats.fps ?? 0) - 62.5) < 1e-9);

  sampler.stop();
  assert.equal(sampler.active(), false);
  assert.deepEqual(sampler.stats(), { frames: 0, fps: null, ms: null });
});
