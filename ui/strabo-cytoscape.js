/**
 * Build the Cytoscape instance. 2D canvas by default; WebGL only if asked for.
 *
 * Measured on real hardware (an AMD Radeon 780M via ANGLE/D3D11, not a software
 * rasteriser) across Strabo's actual size range, panning and zooming a graph styled
 * like this one: Cytoscape's WebGL renderer was slower than the 2D canvas renderer at
 * every size tried, from 200 nodes (~8x slower) up to 15,000 (~1.6x slower). The gap
 * narrows as the graph grows but never closes in that range. The reason is architectural,
 * not a tuning knob: WebGL still walks every element in JS every frame — resolving
 * styles, computing bounding boxes, writing instance buffers — before the GPU sees
 * anything, and that per-element bookkeeping outweighs what batched draw calls save at
 * the sizes a single Strabo view actually reaches (one directory's drill-down, typically
 * a few hundred to a few thousand nodes). So 2D canvas is the default.
 *
 * WebGL is left in as an opt-in, not deleted, because the gap was still narrowing at
 * 15,000 nodes — a monorepo pushing a view past that might see it pay off. Turn it on
 * with `?renderer=webgl` (remembered after that; `?renderer=canvas` clears it) or by
 * setting `localStorage['strabo:renderer-preference'] = 'webgl'` directly.
 *
 * Cytoscape does not degrade on its own: with `webgl: true` and no WebGL2 context it
 * throws while initialising. Probe first, and still catch, so a driver that advertises
 * WebGL2 but fails to compile the shaders leaves a working map instead of a blank one.
 */

import { stylesheet } from './strabo-stylesheet.js';
import {
  paintContainerBackground,
  probeWebGL2,
  reloadWithoutWebGL,
  webglRefused,
  webglRequested,
} from './strabo-renderer-preference.js';

/**
 * Viewport clamp. `fit()` has no ceiling of its own, so the two extremes of graph size
 * produced the two extremes of encoding: five directories fit at zoom 5.11 (10-unit labels
 * rendered at 51px) while 192 files fit at 0.38 (the same labels at 3.8px). The clamp keeps
 * `fit()` inside a range where one encoding is readable; a graph too large to fit at
 * `minZoom` is panned rather than shrunk to a hairline.
 */
const MIN_ZOOM = 0.12;
const MAX_ZOOM = 2.5;

export function createCytoscape(container) {
  const options = {
    container,
    style: stylesheet(),
    layout: { name: 'preset' },
    wheelSensitivity: 0.2,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
  };

  if (webglRequested() && !webglRefused() && probeWebGL2()) {
    // Cytoscape's WebGL renderer blends arrow tips against the container's *inline*
    // background colour and never consults the stylesheet. Unset, it blends against
    // white, fringing every arrowhead on this dark theme. Set it before the renderer
    // reads it; the 2D path never looks at this, so it stays unset by default.
    paintContainerBackground(container);
    try {
      return window.cytoscape({ ...options, renderer: { name: 'canvas', webgl: true } });
    } catch (error) {
      return reloadWithoutWebGL(error);
    }
  }
  return window.cytoscape(options);
}

/**
 * Turn the built-in viewport fast paths on or off for the live renderer.
 *
 * `textureOnViewport` transforms the last painted frame while a wheel/pinch/drag gesture is
 * in flight instead of walking every element, and `hideEdgesOnViewport` skips the edge draw
 * for those frames. Both are read from the renderer each frame, so assigning them here
 * works on the 2D renderer even though it is chosen at construction. The element count is
 * only known after a render, and the tradeoff (a soft, briefly stale frame) is only worth
 * it on a large graph, so the caller gates them with {@link viewportPerfFor}.
 */
export function applyViewportPerf(cy, perf) {
  const renderer = cy?.renderer?.();
  if (!renderer) {
    return;
  }
  renderer.textureOnViewport = Boolean(perf?.textureOnViewport);
  renderer.hideEdgesOnViewport = Boolean(perf?.hideEdgesOnViewport);
}
