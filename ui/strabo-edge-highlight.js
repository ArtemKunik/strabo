/**
 * Edge hover fade and edge selection.
 *
 * `dimmed` (selection focus) is deliberately a step stronger than `edge-faded`, so a
 * hover never lifts an edge the selection put back.
 *
 * The fade is the one part of a hover that touches many edges at once, so it works from an
 * incidence index built once per render rather than asking every edge for its endpoints on
 * every mouseover. Moving from one node to another only un-fades the new node's edges and
 * fades the old node's, which is proportional to those two degrees, not to the whole graph.
 */

export function createEdgeHighlight(cy) {
  /** node id → Set of incident edge ids, rebuilt on every render. */
  let incident = new Map();
  /** Every edge id, in draw order; the fallback set when a hover starts from the canvas. */
  let allEdgeIds = [];
  /** The node the fade is currently keyed to, or null when the pointer is off every node. */
  let hoveredId = null;
  /** Edge ids currently carrying `edge-faded`, so a change touches only the difference. */
  let faded = new Set();

  function index(nodeId, edgeId) {
    const set = incident.get(nodeId);
    if (set) {
      set.add(edgeId);
    } else {
      incident.set(nodeId, new Set([edgeId]));
    }
  }

  /** Rebuild the incidence index after the element set changed; drops any stale fade. */
  function rebuild() {
    incident = new Map();
    allEdgeIds = [];
    cy.edges().forEach((edge) => {
      const id = edge.id();
      allEdgeIds.push(id);
      index(edge.data('source'), id);
      index(edge.data('target'), id);
    });
    hoveredId = null;
    faded = new Set();
  }

  /**
   * Fade every edge that is not incident to the hovered node.
   *
   * At 454 edges the base layer draws every relationship at one weight, so nothing stands
   * out under the pointer. Pass null to clear. Moving node-to-node edits only the symmetric
   * difference of the two incident sets; entering from the canvas fades the rest once.
   */
  function fade(node) {
    const nextId = node && node.nonempty() ? node.id() : null;
    if (nextId === hoveredId) {
      return;
    }
    const previous = new Set(incident.get(hoveredId) ?? []);
    hoveredId = nextId;
    if (nextId === null) {
      if (faded.size > 0) {
        cy.batch(() => {
          for (const id of faded) cy.getElementById(id).removeClass('edge-faded');
          faded = new Set();
        });
      }
      return;
    }
    const next = new Set(incident.get(nextId) ?? []);
    cy.batch(() => {
      if (faded.size === 0) {
        for (const id of allEdgeIds) {
          if (!next.has(id)) {
            cy.getElementById(id).addClass('edge-faded');
            faded.add(id);
          }
        }
        return;
      }
      for (const id of previous) {
        if (!next.has(id) && !faded.has(id)) {
          cy.getElementById(id).addClass('edge-faded');
          faded.add(id);
        }
      }
      for (const id of next) {
        if (faded.delete(id)) {
          cy.getElementById(id).removeClass('edge-faded');
        }
      }
    });
  }

  /** Highlight one edge, or clear when null. The selected edge is always classed. */
  function select(edgeId) {
    cy.edges().removeClass('edge-selected');
    if (edgeId) {
      const edge = cy.getElementById(edgeId);
      if (edge.nonempty()) {
        edge.addClass('edge-selected');
      }
    }
  }

  return { fade, select, rebuild };
}
