/**
 * Rendering-performance knobs and readouts.
 *
 * The map is drawn on the CPU: Cytoscape's renderers walk every element in JS each frame
 * before anything reaches a canvas, so the GPU cannot absorb the cost (see
 * `strabo-cytoscape.js`). The levers here cut that per-frame JS work instead: a cached
 * viewport texture while a gesture is in flight, edges dropped from the draw at far zoom,
 * and a rolling frame-time sample the Diagnostics panel reports.
 *
 * Pure functions only, apart from the rAF sampler; the sampler takes its `window` so a
 * test can drive it with a stub.
 */

/**
 * Above this many elements (nodes + edges) the viewport fast paths engage.
 *
 * They trade a soft, briefly stale frame during a gesture for skipping the full scene walk.
 * At small sizes the walk is already cheap and the tradeoff only costs looks, so the
 * threshold keeps them off until the map is actually large.
 */
export const VIEWPORT_PERF_MIN_ELEMENTS = 1500;

/** Below this drawn-edge count the edge level-of-detail pass stays off entirely. */
export const EDGE_LOD_MIN_EDGES = 4000;

/** At or below this zoom a large graph hides its unweighted (hairline) edges. */
export const EDGE_LOD_ZOOM = 0.4;

/** Edges at or above this rolled-up weight always draw; below it they are LOD-hidden. */
export const EDGE_LOD_MIN_WEIGHT = 2;

/**
 * Which viewport fast paths a graph of this size should use.
 *
 * Both flags are written onto the live renderer after a render (`applyViewportPerf`),
 * because the element count is not known when the Cytoscape instance is built.
 */
export function viewportPerfFor(nodes, edges) {
  const total = (Number.isFinite(nodes) ? nodes : 0) + (Number.isFinite(edges) ? edges : 0);
  const enabled = total >= VIEWPORT_PERF_MIN_ELEMENTS;
  return { enabled, textureOnViewport: enabled, hideEdgesOnViewport: enabled };
}

/**
 * Whether one edge should be dropped from the draw at this zoom, by level of detail.
 *
 * Only a large graph is thinned, and only when zoomed far out: at that scale a hairball of
 * unit-weight edges is unreadable anyway and costs the most to draw. A weighted edge (a
 * System/co-change roll-up) carries information the overview can still use and survives.
 */
export function edgeLodHidden(weight, zoom, edgeCount) {
  if (!(edgeCount >= EDGE_LOD_MIN_EDGES)) {
    return false;
  }
  if (!(zoom < EDGE_LOD_ZOOM)) {
    return false;
  }
  const value = Number.isFinite(weight) ? weight : 1;
  return value < EDGE_LOD_MIN_WEIGHT;
}

/**
 * Rolling frame rate from a window of `requestAnimationFrame` timestamps.
 *
 * `ms` is the mean interval between painted frames and `fps` its reciprocal. Fewer than two
 * samples has no interval to speak of, so both are null rather than a fabricated number.
 */
export function averageFrameTimes(samplesMs) {
  const samples = samplesMs ?? [];
  const frames = samples.length - 1;
  if (frames < 1) {
    return { frames: Math.max(0, frames), fps: null, ms: null };
  }
  const span = samples[samples.length - 1] - samples[0];
  const ms = span / frames;
  return { frames, fps: ms > 0 ? 1000 / ms : null, ms: ms > 0 ? ms : null };
}

/**
 * A rolling frame-time sampler driven by `requestAnimationFrame`.
 *
 * Off unless Diagnostics is open, because an idle rAF loop is itself work. `start`/`stop`
 * are idempotent so a panel toggle and a dock open can both call them.
 */
export function createFrameSampler(win = globalThis.window, capacity = 60) {
  const samples = [];
  let handle = 0;

  function tick(now) {
    samples.push(now);
    if (samples.length > capacity) {
      samples.shift();
    }
    handle = win.requestAnimationFrame(tick);
  }

  return {
    start() {
      if (!handle) {
        handle = win.requestAnimationFrame(tick);
      }
    },
    stop() {
      if (handle) {
        win.cancelAnimationFrame(handle);
        handle = 0;
      }
      samples.length = 0;
    },
    active() {
      return handle !== 0;
    },
    stats() {
      return averageFrameTimes(samples);
    },
  };
}
