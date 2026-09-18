import type { Graph, GraphEdge } from '../types.ts';

export interface Adjacency {
  forward: Map<string, string[]>;
  backward: Map<string, string[]>;
}

/** Build forward (source -> targets) and backward (target -> sources) adjacency maps. */
export function buildAdjacency(graph: Graph): Adjacency {
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  for (const node of graph.nodes) {
    forward.set(node.id, []);
    backward.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (edge.source === edge.target) {
      continue;
    }
    forward.get(edge.source)?.push(edge.target);
    backward.get(edge.target)?.push(edge.source);
  }
  for (const list of forward.values()) {
    list.sort();
  }
  for (const list of backward.values()) {
    list.sort();
  }
  return { forward, backward };
}

export interface GraphMetrics {
  fanIn: Map<string, number>;
  fanOut: Map<string, number>;
  transitiveDependents: Map<string, number>;
  transitiveDependencies: Map<string, number>;
}

/**
 * Direct fan-in/fan-out plus transitive dependencies and dependents.
 *
 * The concept calls for an SCC-reachability algorithm when the bitset allocation is
 * safe, otherwise a cycle-safe breadth-first traversal. The BFS below is the safe
 * baseline; the optimised path is tracked as a follow-up.
 */
export function computeGraphMetrics(graph: Graph, adjacency?: Adjacency): GraphMetrics {
  const { forward, backward } = adjacency ?? buildAdjacency(graph);
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  for (const node of graph.nodes) {
    fanIn.set(node.id, new Set(backward.get(node.id) ?? []).size);
    fanOut.set(node.id, new Set(forward.get(node.id) ?? []).size);
  }

  const transitiveDependents = new Map<string, number>();
  const transitiveDependencies = new Map<string, number>();
  for (const node of graph.nodes) {
    transitiveDependents.set(node.id, reachableSize(node.id, backward));
    transitiveDependencies.set(node.id, reachableSize(node.id, forward));
  }
  return { fanIn, fanOut, transitiveDependents, transitiveDependencies };
}

function reachableSize(start: string, adjacency: Map<string, string[]>): number {
  const seen = new Set<string>();
  const stack = [...(adjacency.get(start) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (next === start || seen.has(next)) {
      continue;
    }
    seen.add(next);
    for (const neighbour of adjacency.get(next) ?? []) {
      if (!seen.has(neighbour)) {
        stack.push(neighbour);
      }
    }
  }
  return seen.size;
}

/**
 * Rank hubs by transitive dependents, direct fan-in, then node ID, and return a
 * bounded label shortlist. Dependents are treated as change blast radius.
 */
export function rankHubs(metrics: GraphMetrics, limit = 25): string[] {
  return [...metrics.transitiveDependents.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const fanInA = metrics.fanIn.get(a[0]) ?? 0;
      const fanInB = metrics.fanIn.get(b[0]) ?? 0;
      if (fanInB !== fanInA) return fanInB - fanInA;
      return a[0].localeCompare(b[0]);
    })
    .slice(0, limit)
    .map(([id]) => id);
}

/** Find directed paths between two nodes, breadth-first, bounded by `maxHops`. */
export function findDirectedPath(
  graph: Graph,
  from: string,
  to: string,
  maxHops = 12,
): string[] | null {
  const { forward } = buildAdjacency(graph);
  const queue: Array<{ id: string; path: string[] }> = [{ id: from, path: [from] }];
  const visited = new Set<string>([from]);
  while (queue.length > 0) {
    const current = queue.shift() as { id: string; path: string[] };
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

/** Highlight neighbours of a node, bounded by `depth`. */
export function neighbourhood(graph: Graph, id: string, depth = 1): string[] {
  const { forward, backward } = buildAdjacency(graph);
  const seen = new Set<string>([id]);
  let frontier = [id];
  for (let step = 0; step < depth; step += 1) {
    const next: string[] = [];
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

export function edgesOf(graph: Graph): GraphEdge[] {
  return graph.edges;
}
