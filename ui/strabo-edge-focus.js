/**
 * In-unit edge focus (L16).
 *
 * Before a file is chosen a unit's internal wiring is not drawn; once one is chosen only
 * its import edges to and from files in the same unit show. Edges that cross units are
 * left alone.
 */

export function createEdgeFocus(cy) {
  let focusedFile = null;

  /** Show only the focused file's in-unit edges; outside links stay visible. */
  function apply() {
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

  return {
    apply,
    setFile(fileId) {
      focusedFile = fileId ?? null;
      apply();
    },
  };
}
