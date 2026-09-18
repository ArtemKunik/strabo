/**
 * Viewport operations for Strabo.
 *
 * Positions are precomputed server-side, so no browser force simulation runs while the
 * user pans or zooms.
 */

export function fit(cy) {
  cy.fit(undefined, 40);
}

export function focus(cy, idOrPrefix) {
  const node = cy.getElementById(idOrPrefix);
  if (node && node.nonempty()) {
    cy.animate({ center: { eles: node }, zoom: 1.4 }, { duration: 200 });
    return;
  }
  const matches = cy.nodes().filter((candidate) => candidate.id().startsWith(idOrPrefix));
  if (matches.nonempty()) {
    cy.fit(matches, 60);
  }
}

export function zoomIn(cy) {
  cy.zoom({ level: cy.zoom() * 1.2, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
}

export function zoomOut(cy) {
  cy.zoom({ level: cy.zoom() / 1.2, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
}
