/**
 * Viewport operations for Strabo.
 *
 * Positions are precomputed server-side, so no browser force simulation runs while the
 * user pans or zooms.
 */

/** True when the reduce-motion setting (or the OS preference) is in force. */
function reducedMotion() {
  return document.documentElement?.dataset?.reduceMotion === '1';
}

/**
 * Rendered pixels the fitted map keeps clear at the top: the canvas toolbar floats there
 * (10px inset plus its ~46px height), so a fitted map would otherwise start under it.
 */
const TOP_CLEARANCE = 64;

export function fit(cy) {
  cy.fit(undefined, 40);
  // Nudge the map down past the toolbar when there is room below; otherwise fit again with
  // the larger padding on every side, which costs a little zoom but hides nothing.
  const box = cy.elements().renderedBoundingBox();
  const shift = TOP_CLEARANCE - box.y1;
  if (!(shift > 0)) {
    return;
  }
  if (box.y2 + shift <= cy.height() - 8) {
    cy.panBy({ x: 0, y: shift });
  } else {
    cy.fit(undefined, TOP_CLEARANCE);
  }
}

export function focus(cy, idOrPrefix) {
  const node = cy.getElementById(idOrPrefix);
  if (node && node.nonempty()) {
    if (reducedMotion()) {
      cy.zoom({ level: 1.4 });
      cy.center(node);
      return;
    }
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
