/**
 * Apply a model to a live Cytoscape graph, updating only what changed.
 *
 * Edge ids are positional (`e0`…), so a reused id can name a different pair after a node
 * set changes. This treats the edges lost with a removed node as gone and re-adds them
 * rather than letting the "updated" branch look them up and silently drop them.
 */

import { buildElements, diffGraph } from './strabo-core.js';
import { RESET_CLASSES } from './strabo-graph-classes.js';

/** Apply `model` to `cy` and return the element set to pass back in as `prevElements`. */
export function applyGraphDiff(cy, model, prevElements) {
  const elements = buildElements(model);
  const diff = diffGraph(prevElements, elements);
  cy.batch(() => {
    // Clearing the post-build classes first keeps the reused elements as bare as the
    // freshly-added ones were, so no overlay survives a re-render that dropped it.
    cy.elements().unselect().removeClass(RESET_CLASSES.join(' '));
    const removedNodes = new Set(diff.nodes.removed);
    const orphaned = cy.edges().filter(
      (edge) => removedNodes.has(edge.source().id()) || removedNodes.has(edge.target().id()),
    );
    for (const id of diff.edges.removed) cy.getElementById(id).remove();
    orphaned.remove();
    for (const id of diff.nodes.removed) cy.getElementById(id).remove();
    cy.add(diff.nodes.added);
    cy.add(diff.edges.added);
    for (const { before, after } of diff.nodes.updated) {
      const node = cy.getElementById(after.data.id);
      if (node.empty()) continue;
      node.removeClass(before.classes ?? '');
      node.addClass(after.classes ?? '');
      node.data(after.data);
      if (after.position) node.position(after.position);
    }
    for (const { after } of diff.edges.updated) {
      const edge = cy.getElementById(after.data.id);
      if (edge.nonempty()) {
        edge.data(after.data);
      } else {
        cy.add(after);
      }
    }
  });
  return elements;
}
