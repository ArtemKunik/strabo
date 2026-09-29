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
/** Clear space on every other side, and room for the directory plates' frame and title. */
const EDGE_CLEARANCE = 40;
const PLATE_MARGIN = 26 + 22;
/** Fitting never magnifies a small map past this: a three-card stack stays card-sized. */
const MAX_FIT_ZOOM = 1.6;

/**
 * How far open floating windows cover the canvas from its left and right edges.
 *
 * A window docked against one side (starting in that side's third, and tall enough to hide
 * a band of the map) takes that side's strip away; one floating mid-canvas or a short strip
 * like the legend does not, since shrinking the whole map around it would cost more.
 */
function sideInsets(cy) {
  const container = cy.container?.();
  if (!container?.getBoundingClientRect || typeof document === 'undefined') {
    return { left: 0, right: 0 };
  }
  const canvas = container.getBoundingClientRect();
  let left = 0;
  let right = 0;
  for (const win of document.querySelectorAll('.float-window:not([hidden])')) {
    if (win.classList.contains('is-collapsed')) continue;
    const box = win.getBoundingClientRect();
    const top = Math.max(box.top, canvas.top);
    const bottom = Math.min(box.bottom, canvas.bottom);
    if (box.width === 0 || bottom - top < canvas.height * 0.3 || box.width > canvas.width * 0.5) continue;
    if (box.left - canvas.left < canvas.width / 3) left = Math.max(left, box.right - canvas.left);
    else if (canvas.right - box.right < canvas.width / 3) right = Math.max(right, canvas.right - box.left);
  }
  return { left: Math.max(0, left), right: Math.max(0, right) };
}

/**
 * Fit the whole map into the part of the canvas nothing covers.
 *
 * The toolbar and any side-docked floating window are carved out first, and the plates'
 * frame and title are counted in, so no card lands under a panel or outside its plate.
 */
export function fit(cy) {
  const elements = cy.elements(':visible');
  if (elements.empty()) {
    cy.fit(undefined, EDGE_CLEARANCE);
    return;
  }
  const insets = sideInsets(cy);
  const box = elements.boundingBox();
  const x1 = box.x1 - PLATE_MARGIN;
  const y1 = box.y1 - PLATE_MARGIN;
  const width = box.x2 - box.x1 + 2 * PLATE_MARGIN;
  const height = box.y2 - box.y1 + 2 * PLATE_MARGIN;
  const areaLeft = insets.left + EDGE_CLEARANCE;
  const areaWidth = Math.max(80, cy.width() - areaLeft - insets.right - EDGE_CLEARANCE);
  const areaHeight = Math.max(80, cy.height() - TOP_CLEARANCE - EDGE_CLEARANCE);
  const zoom = Math.max(
    cy.minZoom(),
    Math.min(cy.maxZoom(), MAX_FIT_ZOOM, areaWidth / Math.max(1, width), areaHeight / Math.max(1, height)),
  );
  const pan = {
    x: areaLeft + (areaWidth - width * zoom) / 2 - x1 * zoom,
    y: TOP_CLEARANCE + (areaHeight - height * zoom) / 2 - y1 * zoom,
  };
  cy.viewport({ zoom, pan });
  cy.scratch('_straboFit', { zoom, x: pan.x, y: pan.y });
}

/**
 * Fit again, but only while the map still sits where the last fit left it.
 *
 * A floating window opening or closing changes the free area, so a fitted map should follow
 * it; once the operator has panned or zoomed, the viewport is theirs and is left alone.
 */
export function refitIfUntouched(cy) {
  const last = cy.scratch('_straboFit');
  if (!last) {
    return;
  }
  const pan = cy.pan();
  const zoom = cy.zoom();
  if (Math.abs(zoom - last.zoom) > 1e-3 || Math.abs(pan.x - last.x) > 1 || Math.abs(pan.y - last.y) > 1) {
    return;
  }
  fit(cy);
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
