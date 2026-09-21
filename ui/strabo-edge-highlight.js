/**
 * Edge hover fade and edge selection.
 *
 * `dimmed` (selection focus) is deliberately a step stronger than `edge-faded`, so a
 * hover never lifts an edge the selection put back.
 */

export function createEdgeHighlight(cy) {
  /**
   * Fade every edge that is not incident to the hovered node.
   *
   * At 454 edges the base layer draws every relationship at one weight, so nothing stands
   * out under the pointer. Pass null to clear.
   */
  function fade(node) {
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

  return { fade, select };
}
