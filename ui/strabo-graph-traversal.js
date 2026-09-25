/**
 * Traversal over the Strabo graph model: adjacency, neighbourhood, directed path, and the
 * path filter.
 *
 * Pure functions only: no DOM, no Cytoscape, no fetch.
 */

export function adjacency(model) {
  const forward = new Map();
  const backward = new Map();
  const push = (map, key, value) => {
    const list = map.get(key);
    if (list) {
      list.push(value);
    } else {
      map.set(key, [value]);
    }
  };
  for (const edge of model.edges ?? []) {
    push(forward, edge.source, edge.target);
    push(backward, edge.target, edge.source);
  }
  return { forward, backward };
}

/** The selected node plus its immediate neighbours, in either direction. */
export function neighbourhood(model, id, depth = 1) {
  const { forward, backward } = adjacency(model);
  const seen = new Set([id]);
  let frontier = [id];
  for (let step = 0; step < depth; step += 1) {
    const next = [];
    for (const current of frontier) {
      for (const neighbour of [...(forward.get(current) ?? []), ...(backward.get(current) ?? [])]) {
        if (!seen.has(neighbour)) {
          seen.add(neighbour);
          next.push(neighbour);
        }
      }
    }
    frontier = next;
  }
  return [...seen];
}

/** Directed path, breadth-first. Returns null to report no path explicitly. */
export function findPath(model, from, to, maxHops = 12) {
  const { forward } = adjacency(model);
  const queue = [{ id: from, path: [from] }];
  const visited = new Set([from]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current.id === to) {
      return current.path;
    }
    if (current.path.length > maxHops) {
      continue;
    }
    for (const neighbour of forward.get(current.id) ?? []) {
      if (visited.has(neighbour)) {
        continue;
      }
      visited.add(neighbour);
      queue.push({ id: neighbour, path: [...current.path, neighbour] });
    }
  }
  return null;
}

/** Case-insensitive substring filter over node ids. Hidden nodes must not eat label budget. */
export function filterNodes(model, text) {
  const needle = text.trim().toLowerCase();
  if (!needle) {
    return model.nodes.map((node) => node.id);
  }
  return model.nodes.filter((node) => node.id.toLowerCase().includes(needle)).map((node) => node.id);
}
