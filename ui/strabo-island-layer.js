/**
 * The SVG plane the directory plates are drawn on.
 *
 * Kept apart from `strabo-view.js` because it is a self-contained DOM layer: it owns its
 * own SVG elements, its own hover caption, and its own hit-testing, and needs only the
 * geometry helpers from `strabo-core.js`.
 */

import {
  LABEL_INSET,
  fitLabel,
  islandHit,
  islandLabelFits,
  islandTooltipText,
  projectIsland,
} from './strabo-core.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Baseline offset above a plate's top edge, and the viewport margin it needs to sit there. */
const LABEL_BASELINE_GAP = 6;
const LABEL_MIN_TOP = 12;

/**
 * Build the island layer inside `container`.
 *
 * It goes inside the Cytoscape container, ahead of the canvases Cytoscape appends, so it
 * paints over the container's own background but under every node and edge. That order
 * also survives the opt-in WebGL renderer, which sets an opaque inline background colour
 * on the container: a layer outside the container would disappear behind it.
 *
 * Plates are decoration for a structure the nodes already carry, so the layer is
 * `aria-hidden` and never takes pointer events — clicking "an island" means clicking the
 * canvas beneath it, which is what clears the selection.
 */
export function createIslandLayer(container) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('island-layer');
  svg.setAttribute('aria-hidden', 'true');
  const plates = document.createElementNS(SVG_NS, 'g');
  const labels = document.createElementNS(SVG_NS, 'g');
  svg.append(plates, labels);
  container.prepend(svg);

  // The hover caption is the one interactive affordance of an otherwise inert layer. It
  // lives outside the SVG so it is not clipped by the layer's `overflow: hidden`, and it is
  // driven by hit-testing the painted boxes rather than by pointer events on the plates —
  // the layer must keep passing clicks through to the canvas so a click on "an island"
  // still clears the selection.
  const tooltip = document.createElement('div');
  tooltip.className = 'island-tooltip';
  tooltip.hidden = true;
  container.appendChild(tooltip);

  let boxes = [];

  function hideTooltip() {
    if (!tooltip.hidden) {
      tooltip.hidden = true;
    }
  }

  container.addEventListener('pointermove', (event) => {
    const bounds = container.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const hit = islandHit(boxes, x, y);
    if (!hit) {
      hideTooltip();
      return;
    }
    tooltip.textContent = islandTooltipText(hit);
    tooltip.hidden = false;
    tooltip.style.left = `${x + 14}px`;
    tooltip.style.top = `${y + 14}px`;
  });
  container.addEventListener('pointerleave', hideTooltip);

  return {
    /** Draw `islands` (model coordinates) under the given viewport transform. */
    paint(islands, viewport) {
      // A pan, zoom, or resize moves the plates out from under any caption, so the next
      // pointermove recomputes it.
      hideTooltip();
      // Reuse elements across frames: a pan repaints every island, and replacing the DOM
      // each time would churn a node per directory per frame.
      sync(plates, 'rect', islands.length);
      sync(labels, 'text', islands.length);

      boxes = [];
      islands.forEach((island, index) => {
        const box = projectIsland(island, viewport);
        const rect = plates.childNodes[index];
        rect.setAttribute('x', String(box.x));
        rect.setAttribute('y', String(box.y));
        rect.setAttribute('width', String(Math.max(0, box.width)));
        rect.setAttribute('height', String(Math.max(0, box.height)));
        rect.setAttribute('class', 'island-plate');

        const label = labels.childNodes[index];
        // The label is chrome, not part of the map, so it holds one device size at every
        // zoom instead of growing with the plate, and is trimmed to what the plate can
        // hold rather than overflowing into the next island.
        const text = islandLabelFits(box) ? fitLabel(island.label, box.width) : '';
        label.setAttribute('class', text ? 'island-label' : 'island-label is-hidden');
        label.setAttribute('x', String(box.x + LABEL_INSET));
        // Above the plate, in the gap the layout already leaves between islands: the
        // layer paints under the nodes, so a label inside the plate would be half-hidden
        // behind the first row of them. Near the top edge there is no gap, so it falls
        // back inside, where the padding still clears the nodes.
        const above = box.y - LABEL_BASELINE_GAP;
        label.setAttribute('y', String(above >= LABEL_MIN_TOP ? above : box.y + 16));
        if (label.textContent !== text) {
          label.textContent = text;
        }
        boxes.push({
          ...box,
          directory: island.directory,
          label: island.label,
          count: island.count,
          trimmed: text !== island.label,
        });
      });
    },
  };
}

/** Grow or shrink `parent` to exactly `count` children of `tag`. */
function sync(parent, tag, count) {
  while (parent.childNodes.length > count) {
    parent.removeChild(parent.lastChild);
  }
  while (parent.childNodes.length < count) {
    parent.appendChild(document.createElementNS(SVG_NS, tag));
  }
}
