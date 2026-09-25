/**
 * Element diffing for the Strabo graph, so a re-render touches only what changed.
 *
 * Pure functions only: no DOM, no Cytoscape, no fetch.
 */

/**
 * Diff two element lists by their data id so a re-render touches only what changed.
 *
 * `added` carries the new definitions, `updated` carries `{ before, after }` pairs (the
 * caller needs `before` to swap the old classes without dropping the ones applied since the
 * last render), and `removed` is the list of ids that are gone. Two elements are "equal"
 * when their builder output matches: classes, data, and position.
 */
export function diffElements(previous = [], next = []) {
  const before = new Map(previous.map((element) => [element.data.id, element]));
  const added = [];
  const updated = [];
  for (const element of next) {
    const id = element.data.id;
    const prior = before.get(id);
    if (!prior) {
      added.push(element);
      continue;
    }
    before.delete(id);
    if (elementSignature(prior) !== elementSignature(element)) {
      updated.push({ before: prior, after: element });
    }
  }
  return { added, removed: [...before.keys()], updated };
}

/** Diff a `{ nodes, edges }` pair from {@link buildElements}. */
export function diffGraph(previous = { nodes: [], edges: [] }, next = { nodes: [], edges: [] }) {
  return {
    nodes: diffElements(previous.nodes, next.nodes),
    edges: diffElements(previous.edges, next.edges),
  };
}

function elementSignature(element) {
  return JSON.stringify({
    classes: element.classes ?? '',
    data: element.data,
    position: element.position ?? null,
  });
}
