/**
 * The WebGL renderer opt-in and its failure recovery.
 *
 * This is a preference about how the map is drawn and a lifecycle concern around the
 * browser's WebGL2 context, not part of rendering itself. `strabo-cytoscape.js` asks
 * `shouldUseWebGL` before building the map, and the settings panel reads and writes the
 * stored preference here.
 */

import { cssVar } from './strabo-theme.js';

/** Where the WebGL opt-in is remembered once granted via `?renderer=webgl`. */
const RENDERER_PREFERENCE_KEY = 'strabo:renderer-preference';

/**
 * Whether the next map build should ask for the GPU.
 *
 * The Settings toggle and `?renderer=` write this one key, so the panel, the URL, and a
 * hand-set `localStorage` entry cannot disagree about which renderer is armed.
 */
export function webglPreferred() {
  try {
    return window.localStorage.getItem(RENDERER_PREFERENCE_KEY) === 'webgl';
  } catch {
    return false;
  }
}

/**
 * Arm or disarm the GPU renderer for the next map build.
 *
 * Cytoscape chooses its renderer when the instance is constructed, and tracks the canvas
 * layer count on a module-private object shared by the whole document, so there is no
 * supported way to swap renderers on a live map. The caller reloads.
 */
export function setWebglPreferred(preferred) {
  try {
    if (preferred) {
      window.localStorage.setItem(RENDERER_PREFERENCE_KEY, 'webgl');
    } else {
      window.localStorage.removeItem(RENDERER_PREFERENCE_KEY);
    }
  } catch {
    // Storage is optional; without it the choice just does not outlive the reload.
  }
}

/** Read and, on an explicit `?renderer=` visit, update the WebGL opt-in. */
export function webglRequested() {
  try {
    const param = new URL(window.location.href).searchParams.get('renderer');
    if (param === 'webgl') {
      setWebglPreferred(true);
      return true;
    }
    if (param === 'canvas') {
      setWebglPreferred(false);
      return false;
    }
  } catch {
    return false;
  }
  return webglPreferred();
}

/** Session flag recording that the GPU renderer already failed in this tab. */
const WEBGL_REFUSED = 'strabo:webgl-refused';

export function webglRefused() {
  try {
    return window.sessionStorage.getItem(WEBGL_REFUSED) === '1';
  } catch {
    return false;
  }
}

/**
 * Recover from a WebGL renderer that threw while initialising.
 *
 * Cytoscape counts its canvas layers on a module-private object rather than on the
 * instance, and enabling WebGL raises that count for the whole document. A failed
 * attempt therefore poisons every renderer built afterwards — including a plain 2D one,
 * which would ask for a `webgl2` layer it was never meant to have and throw the same
 * way. Nothing in the public API can put that count back, so the only honest recovery is
 * to reload into the 2D path. The flag is session-scoped and checked before the next
 * attempt, so the reload happens once rather than looping.
 *
 * Without session storage there is nowhere to record the refusal, and reloading would
 * loop forever; rethrow instead and let the error surface.
 */
export function reloadWithoutWebGL(error) {
  console.warn('Strabo: WebGL rendering failed to start; reloading on the 2D canvas renderer.', error);
  try {
    window.sessionStorage.setItem(WEBGL_REFUSED, '1');
  } catch {
    throw error;
  }
  window.location.reload();
  throw error;
}

/**
 * Write the theme's surface onto the container as an inline colour.
 *
 * `.graph` is transparent over the dotted `.graph-wrap`, so the WebGL renderer would
 * otherwise blend against white. The surface is the `--bg-1` token, the same definition
 * the CSS uses; assigning the token directly means a re-theme reads the new value rather
 * than a colour written last time.
 */
export function paintContainerBackground(container) {
  container.style.backgroundColor = cssVar('--bg-1');
}

/**
 * Move the WebGL renderer onto the new theme's background.
 *
 * `initWebgl` reads the container background exactly once and keeps it as an `[r, g, b]`
 * tuple on the drawing instance; the stylesheet never feeds it. Restyling alone therefore
 * leaves arrow tips blending against the *previous* theme — the fringing
 * `paintContainerBackground` exists to prevent at startup, arriving later instead. The
 * tuple is read per draw call, so assigning it is enough: no atlas rebuild, and the next
 * frame carries it.
 *
 * The 2D renderer has no `drawing`, and never consults the inline colour, so this is a
 * no-op there.
 */
export function retintBackground(cy, container) {
  const drawing = cy.renderer()?.drawing;
  if (!drawing) {
    return;
  }
  paintContainerBackground(container);
  const tuple = containerColourTuple(container);
  if (tuple) {
    drawing.bgColor = tuple;
  }
}

/**
 * The container's background as the `[r, g, b]` tuple Cytoscape stores.
 *
 * Read back through `getComputedStyle` rather than parsed from the token, because that
 * normalises whatever the theme used — hex, `rgb()`, a colour name — to one `rgb()` form.
 */
function containerColourTuple(container) {
  const computed = getComputedStyle(container).backgroundColor;
  const open = computed.indexOf('(');
  const close = computed.lastIndexOf(')');
  if (open < 0 || close < open) {
    return null;
  }
  // Browsers return either `rgb(r, g, b)` or the space-separated `rgb(r g b / a)` form,
  // so accept both separators and keep the first three channels.
  const channels = computed
    .slice(open + 1, close)
    .split(',')
    .join(' ')
    .split(' ')
    .filter(Boolean)
    .map(Number);
  const rgb = channels.slice(0, 3);
  return rgb.length === 3 && rgb.every(Number.isFinite) ? rgb : null;
}

/** Probe a real WebGL2 context, then release it so it does not count against the
 * browser's live-context limit. */
export function probeWebGL2() {
  try {
    if (!window.WebGL2RenderingContext) {
      return false;
    }
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) {
      return false;
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}
