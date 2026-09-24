/**
 * The live frame-time line in the Diagnostics panel.
 */

import { createFrameSampler } from './strabo-perf.js';

export function createRuntimeReadout(app) {
  const { view, elements } = app;

  /**
   * A rolling frame-time readout for the Diagnostics panel.
   *
   * Rendering is CPU-bound — the renderer walks every element in JS before the GPU sees
   * anything — so the useful numbers are the frame interval and the renderer's own redraw
   * count, not GPU utilisation. Sampled only while Diagnostics is open, since an idle rAF loop
   * is itself work. The renderer's `redraws` counter is the honest "did the map actually
   * repaint" signal behind the viewport fast paths.
   */
  const frameSampler = createFrameSampler(window);
  let runtimeBase = '';
  let runtimeTimer = 0;

  function runtimeSuffix() {
    const { fps, ms } = frameSampler.stats();
    const redraws = view.cy?.renderer?.()?.redraws ?? 0;
    const drawn = view.cy?.elements().length ?? 0;
    const fpsText = fps === null ? 'fps: sampling…' : `${Math.round(fps)} fps`;
    const msText = ms === null ? '' : ` / ${ms.toFixed(1)} ms`;
    return `${fpsText}${msText} · ${redraws} redraws · ${drawn} elements`;
  }

  function refreshRuntimeReadout() {
    if (!elements.diagnostics || elements.diagnostics.hidden || !runtimeBase) {
      return;
    }
    const line = elements.diagnostics.querySelector('[data-role="runtime"]');
    if (line) {
      line.textContent = `${runtimeBase} · ${runtimeSuffix()}`;
    }
  }

  function startRuntimeReadout() {
    frameSampler.start();
    if (!runtimeTimer) {
      runtimeTimer = setInterval(refreshRuntimeReadout, 500);
    }
    refreshRuntimeReadout();
  }

  /** Keep the per-graph half of the runtime line the Diagnostics panel just wrote. */
  function setRuntimeBase(text) {
    runtimeBase = text;
  }

  function stopRuntimeReadout() {
    frameSampler.stop();
    if (runtimeTimer) {
      clearInterval(runtimeTimer);
      runtimeTimer = 0;
    }
  }

  return {
    refreshRuntimeReadout,
    setRuntimeBase,
    startRuntimeReadout,
    stopRuntimeReadout,
  };
}
