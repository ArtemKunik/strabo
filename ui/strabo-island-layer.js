/**
 * The SVG plane the directory plates are drawn on.
 *
 * Kept apart from `strabo-view.js` because it is a self-contained DOM layer: it owns its
 * own SVG elements, its own hover caption, its own hit-testing, and the pointer handling
 * that lets a directory plate be dragged, and needs only the geometry helpers from
 * `strabo-core.js`.
 */

import {
  LABEL_BASELINE_GAP,
  LABEL_INSET,
  fitLabel,
  islandHit,
  islandHitAny,
  islandLabelFits,
  islandTooltipText,
  labelsThatFit,
  projectIsland,
  uniformIslandShift,
} from './strabo-core.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The viewport margin a label needs to sit above a plate's top edge. */
const LABEL_MIN_TOP = 12;

/**
 * Build the island layer inside `container`.
 *
 * It goes inside the Cytoscape container, ahead of the canvases Cytoscape appends, so it
 * paints over the container's own background but under every node and edge. That order
 * also survives the opt-in WebGL renderer, which sets an opaque inline background colour
 * on the container: a layer outside the container would disappear behind it.
 *
 * The SVG is `aria-hidden` and `pointer-events: none`. A press outside every plate still
 * reaches the canvas beneath and clears the selection. Dragging is read at the container
 * instead: `pointerdown` in the capture phase hit-tests the painted plates and claims a
 * press that lands on one, so it neither pans the map nor selects a file. A press over a
 * node is left to Cytoscape, so files keep their own select and drag. `handlers.onDragMove`
 * `(directory, dx, dy)` receives the move in model units (screen pixels divided by the live
 * zoom); `handlers.onDragEnd(directory, moved)` fires once on release, and a press that
 * never moved is the click the plate claimed — the caller clears the selection it stands for.
 */
export function createIslandLayer(container, handlers = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('island-layer');
  svg.setAttribute('aria-hidden', 'true');
  const plates = document.createElementNS(SVG_NS, 'g');
  const labels = document.createElementNS(SVG_NS, 'g');
  svg.append(plates, labels);
  container.prepend(svg);

  // The hover caption names a plate whose label was trimmed; it lives outside the SVG so it
  // is not clipped by the layer's `overflow: hidden`, and is driven by hit-testing the
  // painted boxes rather than by pointer events on the plates. It takes no pointer events
  // itself, so it never stands between the pointer and a drag.
  const tooltip = document.createElement('div');
  tooltip.className = 'island-tooltip';
  tooltip.hidden = true;
  container.appendChild(tooltip);

  let boxes = [];
  // The last viewport painted, so a screen-pixel drag can be converted to model units.
  let lastViewport = { pan: { x: 0, y: 0 }, zoom: 1 };
  // The translation applied to the plate/label groups since the last full paint. A pan is
  // absorbed here instead of rewriting every plate, and reset whenever the geometry changes.
  let layerShift = { x: 0, y: 0 };
  // The plate being dragged; null when the pointer is only hovering.
  let drag = null;

  function hideTooltip() {
    if (!tooltip.hidden) {
      tooltip.hidden = true;
    }
  }

  /** A pointer's position inside `container`, in device pixels. */
  function pointerIn(event) {
    const bounds = container.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function setDragging(active) {
    container.classList.toggle('island-dragging', active);
  }

  container.addEventListener('pointermove', (event) => {
    if (drag) {
      // The window handler owns the drag; this one only runs the hover caption.
      return;
    }
    const { x, y } = pointerIn(event);
    const over = islandHitAny(boxes, x, y);
    // A node sitting on a plate keeps its own press (select, drag one file), so the grab
    // cursor and the drag never claim a point a node owns. Cytoscape's hover is read for
    // the cursor so this stays O(1) on every move; the press below hit-tests exactly.
    const overNode = Boolean(over) && Boolean(handlers.isHoveringNode?.());
    container.classList.toggle('island-grab', Boolean(over) && !overNode);
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

  // Capture phase: a press on a plate is claimed here, before Cytoscape's own listeners on
  // the canvas beneath can start a pan or a box-select. `preventDefault` also suppresses the
  // compatibility mouse events Cytoscape listens for.
  container.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== undefined && event.button !== 0) {
        return;
      }
      const { x, y } = pointerIn(event);
      const hit = islandHitAny(boxes, x, y);
      if (!hit || handlers.isOverNodeAt?.(event.clientX, event.clientY)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      drag = {
        directory: hit.directory,
        clientX: event.clientX,
        clientY: event.clientY,
        moved: false,
      };
      hideTooltip();
      container.classList.remove('island-grab');
      setDragging(true);
    },
    true,
  );

  window.addEventListener('pointermove', (event) => {
    if (!drag) {
      return;
    }
    const dx = event.clientX - drag.clientX;
    const dy = event.clientY - drag.clientY;
    if (dx === 0 && dy === 0) {
      return;
    }
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    drag.moved = true;
    const zoom = lastViewport.zoom || 1;
    handlers.onDragMove?.(drag.directory, dx / zoom, dy / zoom);
  });

  window.addEventListener('pointerup', () => {
    if (!drag) {
      return;
    }
    const finished = drag;
    drag = null;
    setDragging(false);
    handlers.onDragEnd?.(finished.directory, finished.moved);
  });

  container.addEventListener('pointerleave', () => {
    if (!drag) {
      hideTooltip();
      container.classList.remove('island-grab');
    }
  });

  return {
    /** The plate boxes from the last paint, in device space. `directory` names each one. */
    boxes() {
      return boxes.map((box) => ({ ...box }));
    },
    /** Draw `islands` (model coordinates) under the given viewport transform. */
    paint(islands, viewport) {
      // A pan, zoom, or resize moves the plates out from under any caption, so the next
      // pointermove recomputes it.
      hideTooltip();
      lastViewport = viewport;
      const projected = islands.map((island) => projectIsland(island, viewport));

      // A pure pan moves every plate the same way without resizing it, so the label fit
      // is unchanged: translate the whole layer and skip the per-plate DOM writes and the
      // collision pass. Zoom, resize, a mode change, or a filter falls through to a full
      // paint below.
      const shift = uniformIslandShift(boxes, islands, projected);
      if (shift) {
        boxes = projected.map((box, index) => ({
          ...box,
          directory: boxes[index].directory,
          label: boxes[index].label,
          count: boxes[index].count,
          trimmed: boxes[index].trimmed,
        }));
        if (shift.dx !== 0 || shift.dy !== 0) {
          layerShift = { x: layerShift.x + shift.dx, y: layerShift.y + shift.dy };
          const transform = `translate(${layerShift.x} ${layerShift.y})`;
          plates.setAttribute('transform', transform);
          labels.setAttribute('transform', transform);
        }
        return;
      }

      // Full paint: drop any accumulated translation and write absolute geometry instead.
      plates.removeAttribute('transform');
      labels.removeAttribute('transform');
      layerShift = { x: 0, y: 0 };
      // Reuse elements across frames: a pan repaints every island, and replacing the DOM
      // each time would churn a node per directory per frame.
      sync(plates, 'rect', islands.length);
      sync(labels, 'text', islands.length);

      // The label is chrome, not part of the map, so it holds one device size at every
      // zoom instead of growing with the plate, and is trimmed to what the plate can
      // hold rather than overflowing into the next island. Zoomed out there is no gap
      // left for it either, so a title that would land on a neighbouring plate or title
      // is dropped (the hover caption still names the plate).
      const candidates = projected.map((box, index) =>
        islandLabelFits(box) ? fitLabel(islands[index].label, box.width) : '',
      );
      const fits = labelsThatFit(projected, candidates);

      boxes = [];
      islands.forEach((island, index) => {
        const box = projected[index];
        const rect = plates.childNodes[index];
        rect.setAttribute('x', String(box.x));
        rect.setAttribute('y', String(box.y));
        rect.setAttribute('width', String(Math.max(0, box.width)));
        rect.setAttribute('height', String(Math.max(0, box.height)));
        rect.setAttribute('class', 'island-plate');

        const label = labels.childNodes[index];
        const text = fits[index] ? candidates[index] : '';
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
