/**
 * Cytoscape rendering for Strabo.
 *
 * Joins API nodes to metrics and positions by ID, resolves server-assigned palette
 * indexes, and generates Cytoscape elements. Pure element construction lives in
 * strabo-core so it can be unit-tested; this module only touches Cytoscape.
 */

import { SHAPES, buildElements } from './strabo-core.js';

const OVERLAY_CLASSES = ['ov-changed', 'ov-affected', 'ov-cycle', 'ov-unreached'];

/** Zoom level at which ordinary nodes earn a label. */
const LABEL_DETAIL_ZOOM = 0.65;

export function createView(container) {
  const cy = createCytoscape(container);
  const gpu = Boolean(cy.renderer()?.webgl);

  const selectHandlers = [];
  const drillHandlers = [];
  const hoverHandlers = [];
  const edgeHandlers = [];
  const contextHandlers = [];
  const groupHandlers = [];
  let selectedEdge = null;

  // Cytoscape does not observe container size itself. The breadcrumb, diagnostics panel,
  // and inspector all change layout after the graph is created, so keep it in sync or
  // rendered coordinates drift from the DOM and hit-testing misses.
  const observer = new ResizeObserver(() => cy.resize());
  observer.observe(container);

  cy.on('tap', 'node', (event) => {
    for (const handler of selectHandlers) handler(event.target.id());
    applyLabelBudget(cy, true);
  });
  cy.on('dbltap', 'node', (event) => {
    for (const handler of drillHandlers) handler(event.target.id());
  });
  cy.on('tap', 'edge', (event) => {
    selectEdge(event.target.id());
    for (const handler of edgeHandlers) handler(event.target.id());
  });
  cy.on('tap', (event) => {
    if (event.target === cy) {
      selectEdge(null);
      for (const handler of edgeHandlers) handler(null);
    }
  });
  cy.on('zoom', () => applyLabelBudget(cy));
  cy.on('cxttap', 'node', (event) => {
    for (const handler of contextHandlers) {
      handler({ kind: 'node', id: event.target.id() }, event.originalEvent);
    }
  });
  cy.on('cxttap', 'edge', (event) => {
    for (const handler of contextHandlers) {
      handler({ kind: 'edge', id: event.target.id() }, event.originalEvent);
    }
  });
  cy.on('cxttap', (event) => {
    if (event.target === cy) {
      for (const handler of contextHandlers) {
        handler({ kind: 'view' }, event.originalEvent);
      }
    }
  });
  cy.on('mouseover', 'node', (event) => {
    for (const handler of hoverHandlers) handler(event.target.id(), event.originalEvent);
  });
  cy.on('mouseout', 'node', () => {
    for (const handler of hoverHandlers) handler(null);
  });
  cy.on('mouseover', 'edge', (event) => {
    event.target.addClass('hover');
  });
  cy.on('mouseout', 'edge', (event) => {
    event.target.removeClass('hover');
  });
  // Cytoscape's own selection state (ctrl/⌘-click toggles a node; shift-drag box-selects
  // a region) is the group: a plain tap already goes through this same state — it just
  // replaces the set with one node — so "group" here means whatever's currently selected,
  // read fresh rather than tracked, since select/unselect can fire once per element in a
  // box-select and per-event bookkeeping would just have to re-derive the same set anyway.
  cy.on('select unselect', 'node', () => notifyGroup());

  function notifyGroup() {
    const ids = cy.nodes(':selected').map((node) => node.id());
    for (const handler of groupHandlers) handler(ids);
  }

  /** Highlight one edge, or clear when null. The selected edge is always classed. */
  function selectEdge(edgeId) {
    cy.edges().removeClass('edge-selected');
    selectedEdge = edgeId;
    if (edgeId) {
      const edge = cy.getElementById(edgeId);
      if (edge.nonempty()) {
        edge.addClass('edge-selected');
      }
    }
  }

  return {
    cy,
    capabilities: { webgl2: gpu, renderer: gpu ? 'webgl2' : 'canvas' },
    resize() {
      cy.resize();
    },
    render(model) {
      const elements = buildElements(model);
      selectedEdge = null;
      cy.batch(() => {
        cy.elements().remove();
        cy.add(elements.nodes);
        cy.add(elements.edges);
      });
      applyLabelBudget(cy, true);
      // Removal doesn't fire unselect events, so the old node ids would otherwise linger
      // in whatever last read the group — tell listeners the slate is clean.
      notifyGroup();
    },
    highlight(ids) {
      const keep = ids ? new Set(ids) : null;
      cy.batch(() => {
        cy.elements().removeClass('dimmed');
        if (keep) {
          cy.nodes().forEach((node) => {
            if (!keep.has(node.id())) node.addClass('dimmed');
          });
        }
      });
    },
    /** Annotate nodes from a review analysis. Pass null to clear. */
    overlay(classesByNode) {
      cy.batch(() => {
        cy.nodes().removeClass(OVERLAY_CLASSES.join(' '));
        for (const [id, className] of classesByNode ?? []) {
          const node = cy.getElementById(id);
          if (node.nonempty()) node.addClass(className);
        }
      });
    },
    /** Hide nodes that do not match, then reapply labels so hidden nodes don't consume budget. */
    filter(ids) {
      const keep = ids ? new Set(ids) : null;
      cy.batch(() => {
        cy.nodes().forEach((node) => {
          const visible = !keep || keep.has(node.id());
          node.toggleClass('filtered-out', !visible);
        });
      });
      applyLabelBudget(cy, true);
    },
    /** Fit the viewport to a set of node ids, ignoring the rest. */
    fitNodes(ids) {
      const collection = cy.collection(
        (ids ?? []).map((id) => cy.getElementById(id)).filter((node) => node.nonempty()),
      );
      if (collection.nonempty()) {
        cy.fit(collection, 80);
      }
    },
    onSelect(handler) {
      selectHandlers.push(handler);
    },
    onDrill(handler) {
      drillHandlers.push(handler);
    },
    onHover(handler) {
      hoverHandlers.push(handler);
    },
    onEdge(handler) {
      edgeHandlers.push(handler);
    },
    /** Right-click (or long-press) on a node, edge, or empty canvas. */
    onContext(handler) {
      contextHandlers.push(handler);
    },
    clearEdge() {
      selectEdge(null);
    },
    /** Ids of the natively-selected nodes: ⌘/ctrl-click toggles one, shift-drag a region. */
    selectedNodeIds() {
      return cy.nodes(':selected').map((node) => node.id());
    },
    /** Fires with the current id list whenever the native selection changes, including
     * to `[]` after a render replaces the elements out from under it. */
    onGroupChange(handler) {
      groupHandlers.push(handler);
    },
    clearGroupSelection() {
      cy.nodes(':selected').unselect();
    },
  };
}

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
function createCytoscape(container) {
  const options = {
    container,
    style: stylesheet(),
    layout: { name: 'preset' },
    wheelSensitivity: 0.2,
  };

  if (webglRequested() && !webglRefused() && probeWebGL2()) {
    // Cytoscape's WebGL renderer blends arrow tips against the container's *inline*
    // background colour and never consults the stylesheet. Unset, it blends against
    // white, fringing every arrowhead on this dark theme. Set it before the renderer
    // reads it; the 2D path never looks at this, so it stays unset by default.
    container.style.backgroundColor = surfaceColour(container);
    try {
      return window.cytoscape({ ...options, renderer: { name: 'canvas', webgl: true } });
    } catch (error) {
      return reloadWithoutWebGL(error);
    }
  }
  return window.cytoscape(options);
}

/** Where the WebGL opt-in is remembered once granted via `?renderer=webgl`. */
const RENDERER_PREFERENCE_KEY = 'strabo:renderer-preference';

/** Read and, on an explicit `?renderer=` visit, update the WebGL opt-in. */
function webglRequested() {
  try {
    const param = new URL(window.location.href).searchParams.get('renderer');
    if (param === 'webgl') {
      window.localStorage.setItem(RENDERER_PREFERENCE_KEY, 'webgl');
      return true;
    }
    if (param === 'canvas') {
      window.localStorage.removeItem(RENDERER_PREFERENCE_KEY);
      return false;
    }
    return window.localStorage.getItem(RENDERER_PREFERENCE_KEY) === 'webgl';
  } catch {
    return false;
  }
}

/** Session flag recording that the GPU renderer already failed in this tab. */
const WEBGL_REFUSED = 'strabo:webgl-refused';

function webglRefused() {
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
function reloadWithoutWebGL(error) {
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
 * The colour the WebGL renderer should blend against.
 *
 * `.graph` is transparent over the dotted `.graph-wrap`, so fall back to the surface
 * token rather than letting Cytoscape assume white.
 */
function surfaceColour(container) {
  const own = getComputedStyle(container).backgroundColor;
  if (own && !own.startsWith('rgba(0, 0, 0, 0)') && own !== 'transparent') {
    return own;
  }
  const token = getComputedStyle(document.documentElement).getPropertyValue('--bg-1').trim();
  return token || '#10141a';
}

/** Probe a real WebGL2 context, then release it so it does not count against the
 * browser's live-context limit. */
function probeWebGL2() {
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

/**
 * Semantic zoom: hubs keep labels when zoomed out, ordinary nodes gain labels as the
 * user zooms in. Selected nodes always keep labels. Runs after render/filter/select.
 *
 * A wheel gesture fires `zoom` once per frame, so walking every node each time is the
 * one piece of per-frame work the GPU renderer cannot absorb. The label set only changes
 * when the zoom crosses the threshold, so remember which side we are on and skip the
 * walk otherwise; callers that change the nodes themselves pass `force`.
 */
function applyLabelBudget(cy, force = false) {
  const detailed = cy.zoom() > LABEL_DETAIL_ZOOM;
  if (!force && detailed === cy.scratch('_straboLabelDetail')) {
    return;
  }
  cy.scratch('_straboLabelDetail', detailed);
  cy.batch(() => {
    cy.nodes().forEach((node) => {
      const show = detailed || node.data('hub') || node.selected();
      node.toggleClass('label-hidden', !show);
    });
  });
}

function stylesheet() {
  const kindRules = Object.entries(SHAPES).map(([kind, shape]) => ({
    selector: `node.kind-${kind}`,
    style: { shape },
  }));

  return [
    {
      selector: 'node',
      style: {
        shape: 'round-rectangle',
        'background-color': 'data(color)',
        'background-opacity': 0.88,
        width: 'data(diameter)',
        height: 'data(diameter)',
        label: 'data(label)',
        'font-size': 10,
        'font-weight': 500,
        color: '#eef3fa',
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'text-opacity': 1,
        'text-outline-color': '#0c1016',
        'text-outline-width': 3,
        'text-outline-opacity': 0.9,
        'border-width': 1.5,
        'border-color': 'rgba(255,255,255,0.22)',
        'border-opacity': 1,
      },
    },
    ...kindRules,
    { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#ffffff', 'background-opacity': 1 } },
    { selector: 'node[?hub]', style: { 'border-width': 2.5, 'border-color': '#4c9aff', 'font-size': 12, 'font-weight': 700 } },
    { selector: 'node.ov-changed', style: { 'border-width': 4, 'border-color': '#ff5c5c', 'background-opacity': 1 } },
    { selector: 'node.ov-affected', style: { 'border-width': 3, 'border-color': '#f2b25c', 'background-opacity': 1 } },
    { selector: 'node.ov-cycle', style: { 'border-width': 4, 'border-color': '#c98bf0', 'background-opacity': 1 } },
    { selector: 'node.ov-unreached', style: { 'border-width': 2.5, 'border-style': 'dashed', 'border-color': '#8da0b5', 'background-opacity': 0.55 } },
    { selector: 'node.label-hidden', style: { 'text-opacity': 0 } },
    { selector: 'node.filtered-out', style: { display: 'none' } },
    { selector: '.dimmed', style: { opacity: 0.12 } },
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        width: 1.2,
        opacity: 0.55,
        'line-color': '#3a4a5e',
        'target-arrow-color': '#3a4a5e',
        'arrow-scale': 0.9,
      },
    },
    { selector: 'edge.dimmed', style: { opacity: 0.05 } },
    {
      selector: 'edge.edge-selected',
      style: {
        width: 2.75,
        opacity: 1,
        'line-color': '#4c9aff',
        'target-arrow-color': '#4c9aff',
        'arrow-scale': 1.1,
        'z-index': 10,
      },
    },
    {
      selector: 'edge.hover',
      style: {
        width: 2,
        opacity: 0.9,
        'line-color': '#7fb4ff',
        'target-arrow-color': '#7fb4ff',
      },
    },
  ];
}
