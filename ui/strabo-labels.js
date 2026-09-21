/**
 * Node-label sizing and the semantic-zoom budget.
 *
 * Labels are the one encoding that has to fight Cytoscape's zoom: a style length is
 * multiplied by the zoom, so a constant `font-size` would scale with the map. Everything
 * about holding labels at a device size, and about which nodes earn one, lives here.
 */

/**
 * A node label holds one device size at every zoom.
 *
 * The stylesheet returns the model-unit font that renders at the target device size, and a
 * zoom change re-evaluates it. Kept at 11px: the size the UI type scale already uses for
 * secondary text.
 */
export const LABEL_DEVICE_PX = 11;
export const HUB_LABEL_DEVICE_PX = 12;

/** Model-unit font that renders at `devicePx` at the given zoom. */
export function labelFontSize(zoom, devicePx = LABEL_DEVICE_PX) {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return devicePx / safeZoom;
}

/** Zoom level at which ordinary nodes earn a label. */
const LABEL_DETAIL_ZOOM = 0.65;

/** When false, the settings panel asked for a label-free map. */
let labelsVisible = true;

/** Show or hide every node label. Islands draw their own layer and are unaffected. */
export function setLabelsVisible(cy, visible) {
  labelsVisible = Boolean(visible);
  applyLabelBudget(cy, true);
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
export function rescaleLabels(cy) {
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
export function applyLabelBudget(cy, force = false) {
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
