/**
 * Cytoscape rendering for Strabo.
 *
 * Joins API nodes to metrics and positions by ID and generates Cytoscape elements. Pure
 * element construction lives in strabo-core so it can be unit-tested; this module only
 * touches Cytoscape.
 */

import {
  LABEL_INSET,
  SHAPES,
  TIER_ORDER,
  buildElements,
  diffGraph,
  fitLabel,
  islandBounds,
  islandHit,
  islandLabelFits,
  islandTooltipText,
  projectIsland,
} from './strabo-core.js';

const OVERLAY_CLASSES = ['ov-changed', 'ov-affected', 'ov-cycle', 'ov-unreached', 'ov-hotspot', 'ov-wide-interface', 'ov-pass-through', 'ov-sole-owner', 'ov-cross-repo'];

/**
 * Classes the graph applies after building elements. An incremental render reuses existing
 * elements, so it clears these first to match the "fresh elements" the old rebuild produced.
 */
const RESET_CLASSES = [
  ...OVERLAY_CLASSES,
  ...TIER_ORDER.map((tier) => `tier-${tier}`),
  'hover',
  'edge-selected',
  'dimmed',
  'edge-faded',
  'label-hidden',
  'filtered-out',
  'tier-hidden',
  'tier-upward',
  'tier-skip',
  'edge-tier-upward',
  'edge-tier-skip',
];

/** When false, the settings panel asked for a label-free map. Set via `view.setLabelsVisible`. */
let labelsVisible = true;

/** Zoom level at which ordinary nodes earn a label. */
const LABEL_DETAIL_ZOOM = 0.65;

/**
 * Viewport clamp. `fit()` has no ceiling of its own, so the two extremes of graph size
 * produced the two extremes of encoding: five directories fit at zoom 5.11 (10-unit labels
 * rendered at 51px) while 192 files fit at 0.38 (the same labels at 3.8px). The clamp keeps
 * `fit()` inside a range where one encoding is readable; a graph too large to fit at
 * `minZoom` is panned rather than shrunk to a hairline.
 */
const MIN_ZOOM = 0.12;
const MAX_ZOOM = 2.5;

/**
 * A node label holds one device size at every zoom.
 *
 * Cytoscape multiplies every style length by the current zoom, so a constant `font-size`
 * scales with the map. The stylesheet instead returns the model-unit font that renders at
 * the target device size, and a zoom change re-evaluates it. Kept at 11px: the size the UI
 * type scale already uses for secondary text.
 */
const LABEL_DEVICE_PX = 11;
const HUB_LABEL_DEVICE_PX = 12;

/** Model-unit font that renders at `devicePx` at the given zoom. */
export function labelFontSize(zoom, devicePx = LABEL_DEVICE_PX) {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return devicePx / safeZoom;
}

export function createView(container) {
  const islands = createIslandLayer(container);
  const cy = createCytoscape(container);
  const gpu = Boolean(cy.renderer()?.webgl);
  // Model-coordinate bounds, recomputed only when the node set changes; pan and zoom
  // just re-project them.
  let islandModel = null;
  let islandVisible = null;
  // The element set from the last render, so a re-render can update only what changed.
  let renderedElements = { nodes: [], edges: [] };
  // The file whose in-unit edges are drawn in a System drill-down; null hides them all.
  let focusedFile = null;

  /** Show only the focused file's in-unit edges; outside links stay visible. */
  function applyEdgeFocus() {
    cy.batch(() => {
      cy.edges().forEach((edge) => {
        if (edge.data('scope') !== 'unit') {
          edge.removeClass('edge-hidden');
          return;
        }
        const incident =
          focusedFile !== null &&
          (edge.data('source') === focusedFile || edge.data('target') === focusedFile);
        edge.toggleClass('edge-hidden', !incident);
      });
    });
  }

  function repaintIslands() {
    islands.paint(
      islandBounds(islandModel, {
        visible: islandVisible,
        labels: islandModel?.directoryLabels,
      }),
      {
        pan: cy.pan(),
        zoom: cy.zoom(),
      },
    );
  }

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
  const observer = new ResizeObserver(() => {
    cy.resize();
    repaintIslands();
  });
  observer.observe(container);

  // Islands are drawn in the same transform as the nodes, so every viewport change has to
  // carry them along or the plates slide off the regions they name. This stays synchronous:
  // deferring it a frame would let the plates trail the nodes during a drag.
  cy.on('pan zoom resize', repaintIslands);

  // A trackpad pinch or a momentum wheel can fire several `zoom` events inside one frame,
  // and the label work below is the expensive half of the handler — `rescaleLabels` can
  // restyle every element. Collapse a burst to the one recompute the frame will actually
  // paint. Callers that change the elements themselves still force the walk synchronously.
  let labelFrame = 0;
  function scheduleLabelRecompute() {
    if (labelFrame) {
      return;
    }
    labelFrame = requestAnimationFrame(() => {
      labelFrame = 0;
      rescaleLabels(cy);
      applyLabelBudget(cy);
    });
  }

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
  cy.on('zoom', scheduleLabelRecompute);
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
    fadeEdgesAround(cy, event.target);
    for (const handler of hoverHandlers) handler(event.target.id(), event.originalEvent);
  });
  cy.on('mouseout', 'node', () => {
    fadeEdgesAround(cy, null);
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
    /** Re-read the CSS theme variables and restyle the canvas after a theme switch. */
    applyTheme() {
      cy.style().fromJson(stylesheet()).update();
      retintBackground(cy, container);
    },
    /** Show or hide every node label. Islands draw their own layer and are unaffected. */
    setLabelsVisible(visible) {
      labelsVisible = Boolean(visible);
      applyLabelBudget(cy, true);
    },
    render(model) {
      const elements = buildElements(model);
      const diff = diffGraph(renderedElements, elements);
      renderedElements = elements;
      selectedEdge = null;
      cy.batch(() => {
        // Clearing the post-build classes first keeps the reused elements as bare as the
        // freshly-added ones were, so no overlay survives a re-render that dropped it.
        cy.elements().unselect().removeClass(RESET_CLASSES.join(' '));
        for (const id of diff.edges.removed) cy.getElementById(id).remove();
        for (const id of diff.nodes.removed) cy.getElementById(id).remove();
        cy.add(diff.nodes.added);
        cy.add(diff.edges.added);
        for (const { before, after } of diff.nodes.updated) {
          const node = cy.getElementById(after.data.id);
          if (node.empty()) continue;
          node.removeClass(before.classes ?? '');
          node.addClass(after.classes ?? '');
          node.data(after.data);
          if (after.position) node.position(after.position);
        }
        for (const { after } of diff.edges.updated) {
          const edge = cy.getElementById(after.data.id);
          if (edge.nonempty()) edge.data(after.data);
        }
      });
      islandModel = model;
      islandVisible = null;
      repaintIslands();
      applyEdgeFocus();
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
          // An edge is only part of the focus when both ends are: an edge crossing out of
          // the neighbourhood is the boundary, not the structure being read.
          cy.edges().forEach((edge) => {
            const inside = keep.has(edge.source().id()) && keep.has(edge.target().id());
            if (!inside) edge.addClass('dimmed');
          });
        }
      });
    },
    /**
     * Draw only one file's edges inside its unit in a System drill-down; null hides them.
     *
     * This is L16: before a file is chosen the unit's internal wiring is not drawn, and
     * once one is chosen only its import edges to and from files in the same unit show.
     */
    focusFile(fileId) {
      focusedFile = fileId ?? null;
      applyEdgeFocus();
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
    /**
     * Ring the nodes that take part in a recorded cross-repo interaction. Pass null to clear.
     *
     * This is separate from the review `overlay()` because it is driven by the workspace
     * report, not by a graph analysis, and the two can be on screen at once.
     */
    crossRepo(ids) {
      cy.batch(() => {
        cy.nodes().removeClass('ov-cross-repo');
        for (const id of ids ?? []) {
          const node = cy.getElementById(id);
          if (node.nonempty()) node.addClass('ov-cross-repo');
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
      islandVisible = keep;
      repaintIslands();
      applyLabelBudget(cy, true);
    },
    /**
     * Colour nodes by tier and optionally hide every other tier.
     *
     * `tierByFile` is a file → tier map, or null to clear the lens. A tier of `all` colours
     * without filtering. `tier-hidden` is separate from the text filter's `filtered-out`, so
     * the two filters compose instead of clearing each other.
     */
    applyTier(tierByFile, filterTier = 'all') {
      const enabled = tierByFile instanceof Map;
      cy.batch(() => {
        for (const node of cy.nodes()) {
          for (const tier of TIER_ORDER) {
            node.removeClass(`tier-${tier}`);
          }
          if (!enabled) {
            node.removeClass('tier-hidden');
            continue;
          }
          const tier = tierByFile.get(node.id());
          if (tier) {
            node.addClass(`tier-${tier}`);
          }
          const keep = filterTier === 'all' || tier === filterTier;
          node.toggleClass('tier-hidden', !keep);
        }
      });
    },
    /**
     * Mark the files and edges in a wrong-way dependency. Pass null to clear.
     *
     * `byNode` maps a file to its classes and `edges` names the endpoints to mark. Upward
     * and skip-layer use different classes, so the two differ by border/line shape, not hue.
     */
    applyTierDirections(directions) {
      const nodes = directions?.byNode instanceof Map ? directions.byNode : null;
      const edges = Array.isArray(directions?.edges) ? directions.edges : [];
      cy.batch(() => {
        for (const node of cy.nodes()) {
          node.removeClass('tier-upward');
          node.removeClass('tier-skip');
        }
        for (const edge of cy.edges()) {
          edge.removeClass('edge-tier-upward');
          edge.removeClass('edge-tier-skip');
        }
        if (!nodes) {
          return;
        }
        for (const [id, classes] of nodes) {
          const node = cy.getElementById(id);
          if (node.nonempty()) {
            for (const cls of classes) {
              node.addClass(cls);
            }
          }
        }
        for (const direction of edges) {
          const cls = direction.kind === 'upward' ? 'edge-tier-upward' : 'edge-tier-skip';
          cy.edges()
            .filter(
              (edge) =>
                edge.data('source') === direction.source && edge.data('target') === direction.target,
            )
            .addClass(cls);
        }
      });
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
    /** Directories currently drawn as islands, largest plate first. Empty in block mode. */
    islandDirectories() {
      return islandBounds(islandModel, { visible: islandVisible }).map(
        (island) => island.directory,
      );
    },
  };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Baseline offset above a plate's top edge, and the viewport margin it needs to sit there. */
const LABEL_BASELINE_GAP = 6;
const LABEL_MIN_TOP = 12;

/**
 * The SVG plane the directory plates are drawn on.
 *
 * It goes inside the Cytoscape container, ahead of the canvases Cytoscape appends, so it
 * paints over the container's own background but under every node and edge. That order
 * also survives the opt-in WebGL renderer, which sets an opaque inline background colour
 * on the container: a layer outside the container would disappear behind it.
 *
 * Plates are decoration for a structure the nodes already carry, so the layer is
 * `aria-hidden` and never takes pointer events — clicking "an island" means clicking the
 * canvas beneath it, which is what clears the selection.
 */
function createIslandLayer(container) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('island-layer');
  svg.setAttribute('aria-hidden', 'true');
  const plates = document.createElementNS(SVG_NS, 'g');
  const labels = document.createElementNS(SVG_NS, 'g');
  svg.append(plates, labels);
  container.prepend(svg);

  // The hover caption is the one interactive affordance of an otherwise inert layer. It
  // lives outside the SVG so it is not clipped by the layer's `overflow: hidden`, and it is
  // driven by hit-testing the painted boxes rather than by pointer events on the plates —
  // the layer must keep passing clicks through to the canvas so a click on "an island"
  // still clears the selection.
  const tooltip = document.createElement('div');
  tooltip.className = 'island-tooltip';
  tooltip.hidden = true;
  container.appendChild(tooltip);

  let boxes = [];

  function hideTooltip() {
    if (!tooltip.hidden) {
      tooltip.hidden = true;
    }
  }

  container.addEventListener('pointermove', (event) => {
    const bounds = container.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const hit = islandHit(boxes, x, y);
    if (!hit) {
      hideTooltip();
      return;
    }
    tooltip.textContent = islandTooltipText(hit);
    tooltip.hidden = false;
    tooltip.style.left = `${x + 14}px`;
    tooltip.style.top = `${y + 14}px`;
  });
  container.addEventListener('pointerleave', hideTooltip);

  return {
    /** Draw `islands` (model coordinates) under the given viewport transform. */
    paint(islands, viewport) {
      // A pan, zoom, or resize moves the plates out from under any caption, so the next
      // pointermove recomputes it.
      hideTooltip();
      // Reuse elements across frames: a pan repaints every island, and replacing the DOM
      // each time would churn a node per directory per frame.
      sync(plates, 'rect', islands.length);
      sync(labels, 'text', islands.length);

      boxes = [];
      islands.forEach((island, index) => {
        const box = projectIsland(island, viewport);
        const rect = plates.childNodes[index];
        rect.setAttribute('x', String(box.x));
        rect.setAttribute('y', String(box.y));
        rect.setAttribute('width', String(Math.max(0, box.width)));
        rect.setAttribute('height', String(Math.max(0, box.height)));
        rect.setAttribute('class', 'island-plate');

        const label = labels.childNodes[index];
        // The label is chrome, not part of the map, so it holds one device size at every
        // zoom instead of growing with the plate, and is trimmed to what the plate can
        // hold rather than overflowing into the next island.
        const text = islandLabelFits(box) ? fitLabel(island.label, box.width) : '';
        label.setAttribute('class', text ? 'island-label' : 'island-label is-hidden');
        label.setAttribute('x', String(box.x + LABEL_INSET));
        // Above the plate, in the gap the layout already leaves between islands: the
        // layer paints under the nodes, so a label inside the plate would be half-hidden
        // behind the first row of them. Near the top edge there is no gap, so it falls
        // back inside, where the padding still clears the nodes.
        const above = box.y - LABEL_BASELINE_GAP;
        label.setAttribute('y', String(above >= LABEL_MIN_TOP ? above : box.y + 16));
        if (label.textContent !== text) {
          label.textContent = text;
        }
        boxes.push({
          ...box,
          directory: island.directory,
          label: island.label,
          count: island.count,
          trimmed: text !== island.label,
        });
      });
    },
  };
}

/** Grow or shrink `parent` to exactly `count` children of `tag`. */function sync(parent, tag, count) {
  while (parent.childNodes.length > count) {
    parent.removeChild(parent.lastChild);
  }
  while (parent.childNodes.length < count) {
    parent.appendChild(document.createElementNS(SVG_NS, tag));
  }
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
function webglRequested() {
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
 * Write the theme's surface onto the container as an inline colour.
 *
 * `.graph` is transparent over the dotted `.graph-wrap`, so the WebGL renderer would
 * otherwise blend against white. The surface is the `--bg-1` token, the same definition
 * the CSS uses; assigning the token directly means a re-theme reads the new value rather
 * than a colour written last time.
 */
function paintContainerBackground(container) {
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
function retintBackground(cy, container) {
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

/**
 * Fade every edge that is not incident to the hovered node.
 *
 * At 454 edges the base layer draws every relationship at one weight, so nothing stands
 * out under the pointer. `dimmed` (selection focus) is deliberately a step stronger than
 * `edge-faded`, so a hover never lifts an edge the selection put back.
 */
function fadeEdgesAround(cy, node) {
  cy.batch(() => {
    cy.edges().removeClass('edge-faded');
    if (!node || node.empty()) {
      return;
    }
    cy.edges().forEach((edge) => {
      const incident = edge.source().same(node) || edge.target().same(node);
      if (!incident) edge.addClass('edge-faded');
    });
  });
}

/**
 * Re-evaluate the zoom-compensated label sizes after a viewport change.
 *
 * The label stylesheet returns a function of the current zoom, so it has to be re-applied
 * when the zoom changes — but a wheel gesture fires `zoom` once per frame and re-applying
 * the whole stylesheet per frame is exactly the per-element walk the renderer cannot
 * absorb. The rendered size only needs to hold to within a fraction of a pixel, so skip
 * unless the zoom moved by ~2%, which leaves the type inside 11px +/- 0.2px.
 */
function rescaleLabels(cy) {
  const zoom = cy.zoom();
  const last = cy.scratch('_straboLabelZoom');
  if (typeof last === 'number' && Math.abs(zoom - last) < last * 0.02) {
    return;
  }
  cy.scratch('_straboLabelZoom', zoom);
  cy.style().update();
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
  if (!labelsVisible) {
    if (!force && cy.scratch('_straboLabelHidden') === true) {
      return;
    }
    cy.scratch('_straboLabelHidden', true);
    cy.batch(() => cy.nodes().addClass('label-hidden'));
    return;
  }
  if (cy.scratch('_straboLabelHidden') === true) {
    cy.scratch('_straboLabelHidden', false);
    force = true;
  }
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

/**
 * Read one CSS custom property from the document root.
 *
 * `styles.css` is the single definition of every colour (Phase 13 M1a R10/R11): the canvas
 * resolves the tokens at startup rather than carrying a second palette in JavaScript, so the
 * two can never drift. A missing token yields an empty string, which is a bug in the token
 * set, not a value to paper over with a fallback.
 */
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Canvas colours, read from the CSS custom properties so the graph follows the active theme. */
function graphTheme() {
  return {
    ink: cssVar('--graph-ink'),
    inkOutline: cssVar('--graph-ink-outline'),
    nodeFill: cssVar('--node-fill'),
    nodeLine: cssVar('--node-line'),
    edge: cssVar('--graph-edge'),
    edgeAccent: cssVar('--graph-edge-accent'),
    edgeSelected: cssVar('--graph-edge-selected'),
    hub: cssVar('--graph-hub'),
    selected: cssVar('--graph-selected'),
    changed: cssVar('--graph-changed'),
    affected: cssVar('--graph-affected'),
    cycle: cssVar('--graph-cycle'),
    unreached: cssVar('--graph-unreached'),
    tier: Object.fromEntries(
      TIER_ORDER.filter((tier) => tier !== 'unclassified').map((tier) => [tier, cssVar(`--tier-${tier}`)]),
    ),
    tierUnclassified: cssVar('--series-other'),
  };
}

function stylesheet() {
  const theme = graphTheme();
  const kindRules = Object.entries(SHAPES).map(([kind, shape]) => ({
    selector: `node.kind-${kind}`,
    style: { shape },
  }));
  const tierRules = TIER_ORDER.map((tier) => ({
    selector: `node.tier-${tier}`,
    style: {
      'background-color': tier === 'unclassified' ? theme.tierUnclassified : theme.tier[tier],
    },
  }));

  return [
    {
      selector: 'node',
      style: {
        shape: 'round-rectangle',
        // One neutral fill for every node: directory is carried by position (island
        // plates), and hue on the map is reserved for status. See Phase 13 M1 R3.
        'background-color': theme.nodeFill,
        'background-opacity': 1,
        width: 'data(diameter)',
        height: 'data(diameter)',
        label: 'data(label)',
        // Functions of the live zoom: Cytoscape re-evaluates them on `style().update()`,
        // which the zoom handler calls. See `LABEL_DEVICE_PX`.
        'font-size': (ele) => labelFontSize(ele.cy().zoom()),
        'font-weight': 500,
        color: theme.ink,
        'text-valign': 'bottom',
        'text-margin-y': (ele) => 4 / Math.max(0.0001, ele.cy().zoom()),
        'text-opacity': 1,
        'text-outline-color': theme.inkOutline,
        'text-outline-width': (ele) => 2 / Math.max(0.0001, ele.cy().zoom()),
        'text-outline-opacity': 0.9,
        'border-width': 1.5,
        'border-color': theme.nodeLine,
        'border-opacity': 1,
      },
    },
    ...kindRules,
    // The tier lens colours the fill; the neutral node fill is the default when it is off.
    ...tierRules,
    { selector: 'node:selected', style: { 'border-width': 3, 'border-color': theme.selected, 'background-opacity': 1 } },
    { selector: 'node[?hub]', style: { 'border-width': 2.5, 'border-color': theme.hub, 'font-size': (ele) => labelFontSize(ele.cy().zoom(), HUB_LABEL_DEVICE_PX), 'font-weight': 700 } },
    // Status never rides on hue alone (R6): changed is a solid heavy ring, affected a
    // dotted one, cycle a double one, unreached a light dashed one, hotspot a dotted
    // warning ring. The changed/affected pair co-occurs, so its shape differs too.
    { selector: 'node.ov-changed', style: { 'border-width': 4, 'border-style': 'solid', 'border-color': theme.changed, 'background-opacity': 1 } },
    { selector: 'node.ov-affected', style: { 'border-width': 3, 'border-style': 'dotted', 'border-color': theme.affected, 'background-opacity': 1 } },
    { selector: 'node.ov-cycle', style: { 'border-width': 4, 'border-style': 'double', 'border-color': theme.cycle, 'background-opacity': 1 } },
    { selector: 'node.ov-unreached', style: { 'border-width': 2.5, 'border-style': 'dashed', 'border-color': theme.unreached, 'background-opacity': 0.7 } },
    { selector: 'node.ov-hotspot', style: { 'border-width': 3, 'border-style': 'dotted', 'border-color': theme.affected, 'background-opacity': 1 } },
    { selector: 'node.ov-wide-interface', style: { 'border-width': 3, 'border-style': 'solid', 'border-color': theme.affected, 'background-opacity': 1 } },
    { selector: 'node.ov-pass-through', style: { 'border-width': 2.5, 'border-style': 'dashed', 'border-color': theme.unreached, 'background-opacity': 0.7 } },
    { selector: 'node.ov-sole-owner', style: { 'border-width': 3, 'border-style': 'dotted', 'border-color': theme.cycle, 'background-opacity': 1 } },
    // Cross-repo is a relationship, not a status, so it rides on the accent hue: a heavy
    // dotted ring that reads as "part of a workspace flow" without entering the status set.
    { selector: 'node.ov-cross-repo', style: { 'border-width': 4, 'border-style': 'dotted', 'border-color': theme.edgeAccent, 'background-opacity': 1 } },
    // The tier direction check: a wrong-way dependency is a signal, so it rides on the
    // reserved status scale and differs by shape (double vs dashed), never hue alone.
    { selector: 'node.tier-upward', style: { 'border-width': 4, 'border-style': 'double', 'border-color': theme.cycle, 'background-opacity': 1 } },
    { selector: 'node.tier-skip', style: { 'border-width': 3, 'border-style': 'dashed', 'border-color': theme.affected, 'background-opacity': 1 } },
    { selector: 'node.label-hidden', style: { 'text-opacity': 0 } },
    { selector: 'node.filtered-out', style: { display: 'none' } },
    { selector: 'node.tier-hidden', style: { display: 'none' } },
    { selector: 'edge.edge-hidden', style: { display: 'none' } },
    { selector: '.dimmed', style: { opacity: 0.12 } },
    {
      selector: 'edge',
      style: {
        // Straight, not bezier. A bezier is the most expensive edge the renderers
        // draw: the WebGL path emits a mitre-joined segment strip per edge where a
        // straight edge is one stretched quad, and the 2D path recomputes control
        // points on every restyle. The cost buys only the arc that separates a
        // bidirectional pair, so an import cycle now draws as a single line with a
        // head at each end rather than two bowed ones.
        'curve-style': 'straight',
        'target-arrow-shape': 'triangle',
        width: 1.2,
        // `--graph-edge` clears 3:1 on `--bg-1`; the old #3a4a5e read as haze when the
        // whole repository was fitted. Non-neighbourhood edges dim on hover (R9).
        opacity: 1,
        'line-color': theme.edge,
        'target-arrow-color': theme.edge,
        'arrow-scale': 0.9,
      },
    },
    { selector: 'edge.edge-tier-upward', style: { width: 2.75, 'line-color': theme.cycle, 'target-arrow-color': theme.cycle, opacity: 1 } },
    { selector: 'edge.edge-tier-skip', style: { width: 2.25, 'line-color': theme.affected, 'target-arrow-color': theme.affected, opacity: 1 } },
    { selector: 'edge.edge-faded', style: { opacity: 0.1 } },
    { selector: 'edge.dimmed', style: { opacity: 0.05 } },
    {
      selector: 'edge.edge-selected',
      style: {
        width: 2.75,
        opacity: 1,
        'line-color': theme.edgeSelected,
        'target-arrow-color': theme.edgeSelected,
        'arrow-scale': 1.1,
        'z-index': 10,
      },
    },
    {
      selector: 'edge.hover',
      style: {
        width: 2,
        opacity: 0.9,
        'line-color': theme.edgeAccent,
        'target-arrow-color': theme.edgeAccent,
      },
    },
  ];
}
