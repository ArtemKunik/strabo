/**
 * Cytoscape rendering for Strabo.
 *
 * The composition root of the map: it builds the Cytoscape instance and its layers, wires
 * the browser events to the handler registries, and returns a thin facade. Element
 * construction lives in `strabo-core.js`, the layers and lenses in their own modules.
 */

import {
  applyIslandOffsets,
  islandBounds,
  islandsApply,
  normalizeIslandOffsets,
  shiftIslandOffset,
} from './strabo-core.js';
import { createIslandLayer } from './strabo-island-layer.js';
import { applyViewportPerf, createCytoscape } from './strabo-cytoscape.js';
import { createUnitCardLayer } from './strabo-unit-card-layer.js';
import { applyGraphDiff } from './strabo-graph-sync.js';
import { buildCoChangeElements } from './strabo-core.js';
import { createEdgeFocus } from './strabo-edge-focus.js';
import { createEdgeHighlight } from './strabo-edge-highlight.js';
import {
  applyCoChange,
  applyEdgeKind,
  applyEdgeLod,
  applyTier,
  applyTierDirections,
  dimOutside,
  filterNodes,
  overlayNodes,
  ringCrossRepo,
} from './strabo-lenses.js';
import { stylesheet } from './strabo-stylesheet.js';
import { retintBackground } from './strabo-renderer-preference.js';
import { viewportPerfFor } from './strabo-perf.js';
import { buildNodeGrid, gridHit } from './strabo-spatial.js';
import {
  applyLabelBudget,
  freezeLabels,
  rescaleLabels,
  setLabelsForceAll as setLabelsForceAllState,
  setLabelsVisible as setLabelsVisibleState,
} from './strabo-labels.js';

export { labelFontSize } from './strabo-labels.js';

export function createView(container) {
  const islands = createIslandLayer(container, {
    onDragMove: shiftIsland,
    onDragEnd: endIslandDrag,
    isOverNodeAt: isOverNode,
    isHoveringNode: () => hoveredNode,
  });
  const cy = createCytoscape(container);
  const gpu = Boolean(cy.renderer()?.webgl);
  const cards = createUnitCardLayer(container, cy, openCard);
  const edgeFocus = createEdgeFocus(cy);
  const edgeHighlight = createEdgeHighlight(cy);
  let lastModel = null;
  // The server's model, unshifted, and the same model with the operator's island moves
  // replayed over it. Kept apart so resetting the layout needs no rescan and so a fresh
  // scan always lays the map out where the layout put it before the moves are replayed.
  let baseModel = null;
  let islandModel = null;
  // The island displacement per directory, in model units: the source of truth for every
  // re-render, and what `onIslandLayout` reports for persistence.
  let offsetsByDirectory = {};
  // directory → its member node ids, rebuilt whenever the rendered model changes.
  let directoryMembers = new Map();
  // Whether the pointer is on a node, tracked from Cytoscape's own hover so the per-move
  // cursor test stays O(1) rather than scanning every node on every pointer move.
  let hoveredNode = false;
  const layoutHandlers = [];
  // Model-coordinate bounds, recomputed only when the node set changes; pan and zoom
  // just re-project them.
  let islandVisible = null;
  // The element set from the last render, so a re-render can update only what changed.
  let renderedElements = { nodes: [], edges: [] };
  // A model-space grid of the drawn node boxes, for the island layer's press hit-test. Kept
  // out of `isOverNode`'s per-press work, which would otherwise scan every node.
  let nodeGrid = null;
  // The edge kind being read ('imports' | 'calls'); reapplied after every render because an
  // incremental diff clears the classes the lens put on the edges.
  let edgeKind = 'imports';
  // The last `/analysis/co-change` report and whether its lens is on. The report is merged
  // into the rendered model as extra dashed edges; the lens only shows or hides them.
  let coChangeReport = null;
  let coChangeOn = false;

  /** Rebuild the rendered model, replaying the operator's island moves over `baseModel`. */
  function renderModel() {
    if (!baseModel) {
      return;
    }
    islandModel = applyIslandOffsets(baseModel, offsetsByDirectory);
    // Co-change edges are drawn only when the coupling lens is on, so the default map pays
    // for nothing. They end at nodes already in the model; a stale report for another
    // repository finds no node and contributes no edge.
    if (coChangeOn && coChangeReport) {
      islandModel = {
        ...islandModel,
        edges: [...islandModel.edges, ...buildCoChangeElements(islandModel, coChangeReport)],
      };
    }
    lastModel = islandModel;
    directoryMembers = membersByDirectory(islandModel);
    renderedElements = applyGraphDiff(cy, islandModel, renderedElements);
    // The element count is only known now, so arm the renderer's viewport fast paths here.
    // Below the size gate they stay off: the scene walk is cheap and the tradeoff (a soft
    // frame mid-gesture) only costs looks.
    applyViewportPerf(
      cy,
      viewportPerfFor(renderedElements.nodes.length, renderedElements.edges.length),
    );
    islandVisible = null;
    rebuildNodeGrid();
    repaintIslands();
    cards.apply(islandModel);
    edgeFocus.apply();
    edgeHighlight.rebuild();
    applyEdgeKind(cy, edgeKind);
    applyCoChange(cy, coChangeOn);
    // A render forces the label and edge-LOD pass; drop any pending settle and un-freeze.
    clearTimeout(labelTimer);
    labelTimer = 0;
    labelsFrozen = false;
    recomputeLabels();
    // Removal doesn't fire unselect events, so the old node ids would otherwise linger
    // in whatever last read the group — tell listeners the slate is clean.
    notifyGroup();
  }

  /**
   * Whether a device-space point lands on a visible node, so Cytoscape keeps that press.
   *
   * The pointer is projected into model space (the inverse of `projectIsland`) and tested
   * against the pre-built grid, rather than walking every node's rendered box on each press.
   */
  function isOverNode(clientX, clientY) {
    if (!nodeGrid) {
      return false;
    }
    const bounds = container.getBoundingClientRect();
    const pan = cy.pan();
    const zoom = cy.zoom() || 1;
    const x = (clientX - bounds.left - pan.x) / zoom;
    const y = (clientY - bounds.top - pan.y) / zoom;
    return gridHit(nodeGrid, x, y);
  }

  /** Rebuild the press hit-test grid from the rendered model and its current visibility. */
  function rebuildNodeGrid() {
    nodeGrid = buildNodeGrid(islandModel?.nodes ?? [], islandModel?.positions ?? [], {
      visible: islandVisible,
    });
  }

  /** Every directory's member ids, so a drag can move exactly one group's nodes. */
  function membersByDirectory(model) {
    const map = new Map();
    if (!islandsApply(model)) {
      return map;
    }
    for (const node of model.nodes ?? []) {
      const directory = node.directory ?? '.';
      const list = map.get(directory);
      if (list) {
        list.push(node.id);
      } else {
        map.set(directory, [node.id]);
      }
    }
    return map;
  }

  /** Move one directory's nodes by a model-space delta; called on every drag frame. */
  function shiftIsland(directory, dx, dy) {
    if (!directory || !islandModel || !islandsApply(islandModel)) {
      return;
    }
    offsetsByDirectory = shiftIslandOffset(offsetsByDirectory, directory, dx, dy);
    const ids = directoryMembers.get(directory) ?? [];
    const members = new Set(ids);
    cy.batch(() => {
      for (const id of ids) {
        const element = cy.getElementById(id);
        if (element.empty()) {
          continue;
        }
        const position = element.position();
        element.position({ x: position.x + dx, y: position.y + dy });
      }
    });
    // The plates are drawn from the model, not from live node positions, so it has to be
    // shifted in step or the plate would trail its nodes during the drag.
    islandModel = {
      ...islandModel,
      positions: (islandModel.positions ?? []).map((position) =>
        members.has(position.id)
          ? { ...position, x: position.x + dx, y: position.y + dy }
          : position,
      ),
    };
    lastModel = islandModel;
    repaintIslands();
  }

  /** The selection a default background tap would clear, since a plate press claims the tap. */
  function clearBackgroundSelection() {
    cy.elements(':selected').unselect();
    edgeHighlight.select(null);
    for (const handler of edgeHandlers) {
      handler(null);
    }
  }

  /** Persist a finished drag; a press that never moved is the click the plate intercepted. */
  function endIslandDrag(directory, moved) {
    if (!directory) {
      return;
    }
    if (!moved) {
      clearBackgroundSelection();
      return;
    }
    const snapshot = {};
    for (const [key, value] of Object.entries(offsetsByDirectory)) {
      snapshot[key] = { ...value };
    }
    // The drag moved nodes in the model, so the press grid now points at where they were.
    rebuildNodeGrid();
    for (const handler of layoutHandlers) {
      handler(snapshot);
    }
  }

  /** Replace the stored moves; a repository switch passes its own, a reset passes `{}`. */
  function setIslandOffsets(offsets) {
    offsetsByDirectory = normalizeIslandOffsets(offsets);
    renderModel();
  }

  /** A defensive copy of the stored moves, so a caller cannot mutate them in place. */
  function islandOffsets() {
    const snapshot = {};
    for (const [key, value] of Object.entries(offsetsByDirectory)) {
      snapshot[key] = { ...value };
    }
    return snapshot;
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

  // Cytoscape does not observe container size itself. The breadcrumb, diagnostics panel,
  // and inspector all change layout after the graph is created, so keep it in sync or
  // rendered coordinates drift from the DOM and hit-testing misses.
  const observer = new ResizeObserver(() => {
    cy.resize();
    scheduleViewportRepaint();
  });
  observer.observe(container);

  // Islands are drawn in the same transform as the nodes, so every viewport change has to
  // carry them along or the plates slide off the regions they name. A wheel burst and a
  // trackpad pan each fire several `pan`/`zoom` events per frame, so collapse them to one
  // repaint per frame instead of projecting the plates and cards once per event.
  let viewportFrame = 0;
  function scheduleViewportRepaint() {
    if (viewportFrame) {
      return;
    }
    viewportFrame = requestAnimationFrame(() => {
      viewportFrame = 0;
      repaintIslands();
      cards.repaint();
    });
  }
  cy.on('pan zoom resize', scheduleViewportRepaint);

  // A trackpad pinch or a momentum wheel fires several `zoom` events inside one frame, and
  // the label work is the expensive half of the handler — `rescaleLabels` restyles every
  // element, the per-element walk the renderer cannot absorb. So the restyle is deferred
  // until the gesture rests: labels are hidden for the duration (their `font-size` is a
  // model value, so without a restyle they would scale with the map), and one recompute runs
  // once the events stop. Edge level of detail follows the same timing, since toggling a
  // class on every edge is per-element work too.
  const LABEL_SETTLE_MS = 140;
  let labelTimer = 0;
  let labelsFrozen = false;

  /** The one restyle a settled gesture pays for: labels plus edge level of detail. */
  function recomputeLabels() {
    rescaleLabels(cy);
    applyLabelBudget(cy, true);
    applyEdgeLod(cy, { edgeCount: renderedElements.edges.length, zoom: cy.zoom() });
  }

  function scheduleLabelRecompute() {
    if (!labelsFrozen) {
      labelsFrozen = freezeLabels(cy);
    }
    clearTimeout(labelTimer);
    labelTimer = setTimeout(() => {
      labelTimer = 0;
      labelsFrozen = false;
      recomputeLabels();
    }, LABEL_SETTLE_MS);
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
    hoveredNode = true;
    edgeHighlight.fade(event.target);
    for (const handler of hoverHandlers) handler(event.target.id(), event.originalEvent);
  });
  cy.on('mouseout', 'node', () => {
    hoveredNode = false;
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
      clearTimeout(labelTimer);
      labelTimer = 0;
      labelsFrozen = false;
      setLabelsVisibleState(cy, visible);
    },
    /**
     * Force a file name under every drawn node, not only hubs, selections, and the zoomed-in
     * view. The collision budget still applies, so only the boxes that fit are drawn.
     */
    setLabelsForceAll(visible) {
      setLabelsForceAllState(cy, visible);
    },
    render(model) {
      baseModel = model;
      renderModel();
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
    /**
     * Read import coupling or recorded function calls: `'imports'` or `'calls'`.
     *
     * A call edge parallels an import edge, so this swaps which relationship the map shows
     * rather than adding reachability.
     */
    setEdgeKind(mode) {
      edgeKind = mode === 'calls' ? 'calls' : 'imports';
      applyEdgeKind(cy, edgeKind);
    },
    /**
     * Draw the co-change coupling edges from an `/analysis/co-change` report.
     *
     * The report is merged into the model as dashed edges and the lens is applied; pass
     * `null` or `{ on: false }` to hide them. This is a re-render, not a rescan: the report
     * is fetched separately so the default map never pays for a history pass.
     */
    setCoChange(report, on = true) {
      coChangeReport = report;
      coChangeOn = on === true && report !== null;
      renderModel();
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
      rebuildNodeGrid();
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
      if (islandModel) {
        islandModel = { ...islandModel, unitCards };
        lastModel = islandModel;
        cards.apply(islandModel);
      }
    },
    /** Replace the persisted island moves for the current repository (pass `{}` to reset). */
    setIslandOffsets(offsets) {
      setIslandOffsets(offsets);
    },
    /** A copy of the current island moves, keyed by directory. */
    islandOffsets() {
      return islandOffsets();
    },
    /** Drop every move and lay the map out where the computed layout put it. */
    resetIslandOffsets() {
      setIslandOffsets({});
    },
    /** Subscribe to a finished island drag, receiving the full offsets map to persist. */
    onIslandLayout(handler) {
      layoutHandlers.push(handler);
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
    /** The painted plate boxes from the last frame, in device space, for hit-test callers. */
    islandBoxes() {
      return islands.boxes();
    },
  };
}

