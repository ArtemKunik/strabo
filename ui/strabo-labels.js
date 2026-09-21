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
 * walk otherwise; callers that change the nodes themselves pass `force`. The zoom-out
 * collision pass (`chooseLabels`) does depend on the exact zoom, so it re-runs on a ~2% change.
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
  const zoom = cy.zoom();
  const detailed = zoom > LABEL_DETAIL_ZOOM;
  // Collisions depend on the zoom itself, not just which side of the threshold it is on, so
  // a zoom that moved by more than ~2% re-runs the pass. A pan never changes it.
  const lastZoom = cy.scratch('_straboLabelBudgetZoom');
  const zoomed = typeof lastZoom !== 'number' || Math.abs(zoom - lastZoom) >= lastZoom * 0.02;
  if (!force && !zoomed && detailed === cy.scratch('_straboLabelDetail')) {
    return;
  }
  cy.scratch('_straboLabelDetail', detailed);
  cy.scratch('_straboLabelBudgetZoom', zoom);
  const wanted = cy
    .nodes()
    // A unit or shelf draws no canvas label and a filtered-out node is not drawn at all:
    // neither may take label room from a node that is.
    .filter((node) => node.visible() && node.data('kind') !== 'unit' && node.data('kind') !== 'shelf')
    .filter((node) => detailed || node.data('hub') || node.selected())
    .toArray();
  const shown = chooseLabels(wanted, zoom);
  cy.batch(() => {
    cy.nodes().forEach((node) => {
      node.toggleClass('label-hidden', !shown.has(node.id()));
    });
  });
}

/** Rendered label height, and the gap between a node and its label (matches the stylesheet). */
const LABEL_BOX_HEIGHT = 15;
const LABEL_NODE_GAP = 4;
/** Advance width per glyph at the label's device size (the label face is proportional). */
const LABEL_GLYPH_PX = 0.6;

/**
 * Pick the labels that can be drawn without landing on one another.
 *
 * A label holds one device size while the nodes shrink with zoom, so a zoomed-out map
 * puts far more labels in a region than it has room for: every hub's name stacks over its
 * neighbour's. Candidates are walked most-important first — selected, then the larger
 * node — and one is kept only if its box clears every label already kept. A selected node
 * always keeps its label, so what the user is reading is never the casualty.
 */
export function chooseLabels(nodes, zoom) {
  const ranked = nodes
    .map((node) => {
      const hub = Boolean(node.data('hub'));
      const devicePx = hub ? HUB_LABEL_DEVICE_PX : LABEL_DEVICE_PX;
      const center = node.renderedPosition();
      const radius = ((node.data('diameter') ?? 0) * zoom) / 2;
      const text = String(node.data('label') ?? '');
      const width = text.length * devicePx * LABEL_GLYPH_PX;
      return {
        id: node.id(),
        selected: node.selected(),
        weight: node.data('diameter') ?? 0,
        rect: {
          x: center.x - width / 2,
          y: center.y + radius + LABEL_NODE_GAP,
          width,
          height: LABEL_BOX_HEIGHT,
        },
      };
    })
    .sort((a, b) => Number(b.selected) - Number(a.selected) || b.weight - a.weight || a.id.localeCompare(b.id));

  const bucket = 96;
  const grid = new Map();
  const shown = new Set();
  for (const candidate of ranked) {
    const { rect } = candidate;
    const cells = [];
    for (let cx = Math.floor(rect.x / bucket); cx <= Math.floor((rect.x + rect.width) / bucket); cx += 1) {
      for (let cy = Math.floor(rect.y / bucket); cy <= Math.floor((rect.y + rect.height) / bucket); cy += 1) {
        cells.push(`${cx},${cy}`);
      }
    }
    const clear = !cells.some((key) =>
      (grid.get(key) ?? []).some(
        (other) =>
          rect.x < other.x + other.width &&
          other.x < rect.x + rect.width &&
          rect.y < other.y + other.height &&
          other.y < rect.y + rect.height,
      ),
    );
    if (!clear && !candidate.selected) {
      continue;
    }
    shown.add(candidate.id);
    for (const key of cells) {
      const list = grid.get(key);
      if (list) list.push(rect);
      else grid.set(key, [rect]);
    }
  }
  return shown;
}
