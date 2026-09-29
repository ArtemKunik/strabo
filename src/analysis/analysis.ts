import type { EdgeRelationship, Graph, GraphEdge } from '../types.ts';
import { transitiveReach } from './reachability.ts';

export interface Adjacency {
  forward: Map<string, string[]>;
  backward: Map<string, string[]>;
}

/**
 * Per-graph caches for the two whole-graph derivations several analyses call.
 *
 * The graph object is the key (a `WeakMap`), so a fresh scan gets a fresh cache and an old
 * one is collected; an unchanged graph served from the cache recomputes nothing. The
 * adjacency cache is keyed by its options (there are three variants); the metrics cache is
 * keyed by the adjacency identity, since a caller that passes its own adjacency must not read
 * another one's numbers.
 */
const adjacencyCache = new WeakMap<Graph, Map<string, Adjacency>>();

const metricsCache = new WeakMap<Graph, WeakMap<Adjacency, GraphMetrics>>();

/** A stable key for one adjacency-options combination. */
function adjacencyKey(options: AdjacencyOptions): string {
  return `${options.includeDeclare === true ? 'd' : ''}${options.includeReExports === true ? 'r' : ''}`;
}

/** Drop a graph's memoised adjacency and metrics; tests call this to isolate cases. */
export function clearAnalysisCache(graph: Graph): void {
  adjacencyCache.delete(graph);
  metricsCache.delete(graph);
}

/**
 * The explicit relationship an edge records.
 *
 * Falls back for a graph recorded before the field existed: a `re-export` kind is a re-export,
 * a `declare` `namespace` edge is a Rust module declaration, and any other `declare` edge is a
 * Python package layout edge.
 */
export function relationshipOf(edge: GraphEdge): EdgeRelationship {
  if (edge.relationship) {
    return edge.relationship;
  }
  if (edge.kind === 're-export') {
    return 're-export';
  }
  if (edge.role === 'declare') {
    return edge.kind === 'namespace' ? 'module-declaration' : 'executable-module';
  }
  return 'import';
}

export interface AdjacencyOptions {
  /** Include module-tree declarations (Rust `mod`, Python package layout). Default false. */
  includeDeclare?: boolean;
  /**
   * Include re-export edges even when they are drawn as `declare` (a barrel `index.ts`).
   * Default false, matching direct fan-in/fan-out; impact and blast radius set it.
   */
  includeReExports?: boolean;
}

/**
 * Build forward (source -> targets) and backward (target -> sources) adjacency maps.
 *
 * A `declare` edge (Rust `mod`, a Python `__init__` layout edge, a TypeScript barrel
 * re-export) only describes the module tree, so it is left out of direct adjacency. That
 * keeps fan-in/fan-out from counting a declaration as a dependency. Pass
 * `{ includeReExports: true }` to follow a barrel re-export for impact and blast radius;
 * pass `{ includeDeclare: true }` to count every drawn edge.
 */
export function buildAdjacency(graph: Graph, options: AdjacencyOptions = {}): Adjacency {
  let byKey = adjacencyCache.get(graph);
  if (!byKey) {
    byKey = new Map<string, Adjacency>();
    adjacencyCache.set(graph, byKey);
  }
  const key = adjacencyKey(options);
  const cached = byKey.get(key);
  if (cached) {
    return cached;
  }
  const build = buildAdjacencyUncached(graph, options);
  byKey.set(key, build);
  return build;
}

function buildAdjacencyUncached(graph: Graph, options: AdjacencyOptions): Adjacency {
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
    const relationship = relationshipOf(edge);
    const isDeclaration = relationship === 'module-declaration' || relationship === 'executable-module';
    const followReExport = options.includeReExports === true && relationship === 're-export';
    if (!options.includeDeclare && !followReExport && (edge.role === 'declare' || isDeclaration)) {
      continue;
    }
    forward.get(edge.source)?.push(edge.target);
    backward.get(edge.target)?.push(edge.source);
  }
  // Adjacency is the set of neighbours, not the edge list: a recorded call sits beside its
  // import, and a target may be imported on several lines. Keeping parallel edges would make
  // an edge count (`.length`) read as a file count, so collapse each list to unique ids.
  for (const map of [forward, backward]) {
    for (const [id, list] of map) {
      map.set(id, [...new Set(list)].sort());
    }
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
 * Transitive reach is computed by SCC condensation + bitset reachability (Phase 18 P2) when
 * the allocation is safe, so a cycle's members share one set and each component is built once;
 * otherwise a cycle-safe iterative depth-first traversal runs. The two are equivalent by
 * construction and asserted so in the tests.
 */
export function computeGraphMetrics(graph: Graph, adjacency?: Adjacency): GraphMetrics {
  const resolved = adjacency ?? buildAdjacency(graph);
  let byAdjacency = metricsCache.get(graph);
  if (!byAdjacency) {
    byAdjacency = new WeakMap<Adjacency, GraphMetrics>();
    metricsCache.set(graph, byAdjacency);
  }
  const cached = byAdjacency.get(resolved);
  if (cached) {
    return cached;
  }
  const computed = computeGraphMetricsUncached(graph, resolved);
  byAdjacency.set(resolved, computed);
  return computed;
}

function computeGraphMetricsUncached(graph: Graph, adjacency: Adjacency): GraphMetrics {
  const { forward, backward } = adjacency;
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  for (const node of graph.nodes) {
    fanIn.set(node.id, new Set(backward.get(node.id) ?? []).size);
    fanOut.set(node.id, new Set(forward.get(node.id) ?? []).size);
  }

  const ids = graph.nodes.map((node) => node.id);
  const dependents = transitiveReach(ids, backward);
  const dependencies = transitiveReach(ids, forward);

  const transitiveDependents = new Map<string, number>();
  const transitiveDependencies = new Map<string, number>();
  for (const node of graph.nodes) {
    transitiveDependents.set(
      node.id,
      dependents?.get(node.id) ?? reachableSize(node.id, backward),
    );
    transitiveDependencies.set(
      node.id,
      dependencies?.get(node.id) ?? reachableSize(node.id, forward),
    );
  }
  return { fanIn, fanOut, transitiveDependents, transitiveDependencies };
}

/** Distinct nodes reachable from `start` over one adjacency direction, cycles included. */
export function reachableSize(start: string, adjacency: Map<string, string[]>): number {
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
