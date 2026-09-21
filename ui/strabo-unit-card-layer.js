/**
 * The DOM layer that carries the System-view unit cards.
 *
 * The cards (L22) sit above the canvas, anchored under their node. Cytoscape has no DOM
 * nodes of its own, so this layer tracks rendered positions on every viewport change and
 * rebuilds a card only when its data changes.
 */

import { unitCardElement } from './strabo-unit-cards.js';

/**
 * Below this zoom a unit map is a wide overview, so full cards would pile up and bury the
 * edges. The layer flips to a header-only density until the reader zooms back in.
 */
export const COMPACT_ZOOM = 0.7;

/** The card density for a zoom level: a header-only `compact` chip, or the full `card`. */
export function cardDensity(zoom) {
  return zoom < COMPACT_ZOOM ? 'compact' : 'full';
}

export function createUnitCardLayer(container, cy, onOpen) {
  const layer = document.createElement('div');
  layer.className = 'unit-card-layer';
  container.appendChild(layer);
  const elements = new Map();
  const signatures = new Map();

  /** Anchor each card under its node, hiding it when the node is gone or filtered out. */
  function repaint() {
    layer.dataset.density = cardDensity(cy.zoom());
    if (elements.size === 0) {
      return;
    }
    for (const [id, card] of elements) {
      const node = cy.getElementById(id);
      if (node.empty() || !node.visible()) {
        card.hidden = true;
        continue;
      }
      const position = node.renderedPosition();
      const radius = (Number(node.data('diameter')) || 48) / 2;
      card.hidden = false;
      card.style.left = `${position.x}px`;
      card.style.top = `${position.y + radius + 8}px`;
    }
  }

  /** Create, refresh, or drop the L0 unit cards; a card is rebuilt only when its data changed. */
  function apply(model) {
    const cards = model?.system && !model.systemUnit ? model.unitCards ?? [] : [];
    const seen = new Set();
    for (const card of cards) {
      seen.add(card.id);
      const signature = JSON.stringify(card);
      if (signatures.get(card.id) === signature) {
        continue;
      }
      const element = unitCardElement(card, { onOpen });
      const existing = elements.get(card.id);
      if (existing) {
        existing.replaceWith(element);
      } else {
        layer.append(element);
      }
      elements.set(card.id, element);
      signatures.set(card.id, signature);
    }
    for (const [id, element] of [...elements]) {
      if (!seen.has(id)) {
        element.remove();
        elements.delete(id);
        signatures.delete(id);
      }
    }
    repaint();
  }

  return { apply, repaint };
}
