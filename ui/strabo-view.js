/**
 * Cytoscape rendering for Strabo.
 *
 * The composition root of the map: it builds the Cytoscape instance and its layers, wires
 * the browser events to the handler registries, and returns a thin facade. Element
 * construction lives in `strabo-core.js`, the layers and lenses in their own modules.
 */

import { islandBounds } from './strabo-core.js';
import { createIslandLayer } from './strabo-island-layer.js';
import { createCytoscape } from './strabo-cytoscape.js';
import { createUnitCardLayer } from './strabo-unit-card-layer.js';
import { applyGraphDiff } from './strabo-graph-sync.js';
import { createEdgeFocus } from './strabo-edge-focus.js';
import { createEdgeHighlight } from './strabo-edge-highlight.js';
import {
  applyTier,
  applyTierDirections,
  dimOutside,
  filterNodes,
  overlayNodes,
  ringCrossRepo,
} from './strabo-lenses.js';
import { stylesheet } from './strabo-stylesheet.js';
import { retintBackground } from './strabo-renderer-preference.js';
import {
  applyLabelBudget,
  rescaleLabels,
  setLabelsVisible as setLabelsVisibleState,
} from './strabo-labels.js';

export { labelFontSize } from './strabo-labels.js';

export function createView(container) {
  const islands = createIslandLayer(container);
  const cy = createCytoscape(container);
  const gpu = Boolean(cy.renderer()?.webgl);
  const cards = createUnitCardLayer(container, cy, openCard);
  const edgeFocus = createEdgeFocus(cy);
  const edgeHighlight = createEdgeHighlight(cy);
  let lastModel = null;
  // Model-coordinate bounds, recomputed only when the node set changes; pan and zoom
  // just re-project them.
  let islandModel = null;
  let islandVisible = null;
  // The element set from the last render, so a re-render can update only what changed.
  let renderedElements = { nodes: [], edges: [] };

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
  cy.on('pan zoom resize', cards.repaint);

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
    edgeHighlight.select(event.target.id());
    for (const handler of edgeHandlers) handler(event.target.id());
  });
  cy.on('tap', (event) => {
    if (event.target === cy) {
      edgeHighlight.select(null);
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
    edgeHighlight.fade(event.target);
    for (const handler of hoverHandlers) handler(event.target.id(), event.originalEvent);
  });
  cy.on('mouseout', 'node', () => {
    edgeHighlight.fade(null);
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

  /** A card header is a second door into a unit: the same drill a double-click performs. */
  function openCard(id) {
    for (const handler of drillHandlers) handler(id);
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
      setLabelsVisibleState(cy, visible);
    },
    render(model) {
      renderedElements = applyGraphDiff(cy, model, renderedElements);
      islandModel = model;
      lastModel = model;
      islandVisible = null;
      repaintIslands();
      cards.apply(model);
      edgeFocus.apply();
      applyLabelBudget(cy, true);
      // Removal doesn't fire unselect events, so the old node ids would otherwise linger
      // in whatever last read the group — tell listeners the slate is clean.
      notifyGroup();
    },
    highlight(ids) {
      dimOutside(cy, ids);
    },
    /**
     * Draw only one file's edges inside its unit in a System drill-down; null hides them.
     *
     * This is L16: before a file is chosen the unit's internal wiring is not drawn, and
     * once one is chosen only its import edges to and from files in the same unit show.
     */
    focusFile(fileId) {
      edgeFocus.setFile(fileId);
    },
    /** Annotate nodes from a review analysis. Pass null to clear. */
    overlay(classesByNode) {
      overlayNodes(cy, classesByNode);
    },
    /**
     * Ring the nodes that take part in a recorded cross-repo interaction. Pass null to clear.
     *
     * This is separate from the review `overlay()` because it is driven by the workspace
     * report, not by a graph analysis, and the two can be on screen at once.
     */
    crossRepo(ids) {
      ringCrossRepo(cy, ids);
    },
    /** Hide nodes that do not match, then reapply labels so hidden nodes don't consume budget. */
    filter(ids) {
      islandVisible = filterNodes(cy, ids);
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
      applyTier(cy, tierByFile, filterTier);
    },
    /**
     * Mark the files and edges in a wrong-way dependency. Pass null to clear.
     *
     * `byNode` maps a file to its classes and `edges` names the endpoints to mark. Upward
     * and skip-layer use different classes, so the two differ by border/line shape, not hue.
     */
    applyTierDirections(directions) {
      applyTierDirections(cy, directions);
    },
    /** Replace the L0 unit cards, e.g. after the hotspot report fills their counts (L22). */
    setUnitCards(unitCards) {
      if (lastModel) {
        lastModel = { ...lastModel, unitCards };
        cards.apply(lastModel);
      }
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
      edgeHighlight.select(null);
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

