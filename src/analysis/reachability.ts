/**
 * Transitive reachability over a directed graph (Phase 18 P2).
 *
 * The baseline in `analysis.ts` runs one depth-first traversal per node, which is
 * O(N·(N+E)) — about 10^9 steps at 10k files and 50k edges. This module condenses the graph
 * into strongly connected components (Tarjan, iterative), then computes reachability as
 * `Uint32Array` bitsets in reverse topological order, so a cycle's members share one set and
 * each component's set is built once. When the bitset allocation (components² / 8 bytes per
 * direction) would exceed the memory budget, the caller keeps the DFS baseline instead.
 *
 * The result is identical to the DFS by construction: a node reaches exactly the union of the
 * nodes its component reaches, and the component itself. Equivalence is asserted against the
 * DFS in the unit tests.
 */

/**
 * The work the DFS baseline would do, relative to the bitset path, above which bitsets win.
 *
 * DFS costs about `N × avgReachable`; bitsets cost about `components × components / 32` (each
 * component's set is a `components`-bit vector, and every component builds one). A shallow,
 * mostly-acyclic repository has a small `avgReachable` and a DFS is far cheaper — the Phase 18
 * P7 measurement on a 20k-file synthetic corpus found DFS 125ms against bitsets 451ms, a
 * regression. Bitsets pay only when reachable sets are wide relative to the component count,
 * so the estimate below gates them: an edge-dense graph (a cycle-heavy or fan-out-heavy
 * repository) crosses it, a tree does not.
 */
const BITSET_WORK_RATIO = 0.25;

/** Below this many nodes the DFS is always cheap enough; never allocate bitsets for it. */
const BITSET_MIN_NODES = 2000;

/**
 * The memory budget for one direction's bitsets, in bytes. Two directions are held at once,
 * so the real footprint is about twice this. 64 MiB per direction allows ~23k components
 * (23k² / 8 ≈ 66 MB); past that the DFS fallback runs rather than risking an allocation spike.
 */
export const BITSET_MEMORY_BUDGET_BYTES = 64 * 1024 * 1024;

export interface CondensedGraph {
  /** Component index per node id. */
  componentOf: Map<string, number>;
  /** Members of each component, in a stable (sorted) order. */
  members: string[][];
  /** Component-level forward adjacency: unique target components per component, sorted. */
  forward: number[][];
  /** Component-level backward adjacency: unique source components per component, sorted. */
  backward: number[][];
  /** Components in reverse topological order (a component before the ones it reaches). */
  order: number[];
}

export interface ReachabilityOptions {
  /** Run the bitset path even on a small graph; tests use this for an equivalence check. */
  force?: boolean;
}

/**
 * The per-node transitive reach counts, or null when the graph is too large for the bitsets.
 *
 * `adjacency` is the direction to follow: its forward map counts transitive dependencies, its
 * backward map counts transitive dependents. The count excludes the node itself, matching
 * {@link reachableSize} in `analysis.ts` (a self-loop is not a dependency).
 */
export function componentReachability(
  nodes: readonly string[],
  adjacency: Map<string, string[]>,
  options: ReachabilityOptions = {},
): Map<string, number> | null {
  const condensed = condense(nodes, adjacency);
  const componentCount = condensed.members.length;
  // The bitset allocation is words-per-row × rows × 4 bytes; bail to the DFS when too big.
  const words = Math.ceil(componentCount / 32);
  const bytes = componentCount * words * 4;
  if (bytes > BITSET_MEMORY_BUDGET_BYTES) {
    return null;
  }
  if (!options.force) {
    if (nodes.length < BITSET_MIN_NODES) {
      return null;
    }
    // Estimate both costs. Bitsets build one `componentCount`-bit set per component:
    // `componentCount × words` machine words. The DFS walks one reachable set per node, so its
    // cost is the summed reachable-set size, estimated by sampling a bounded number of nodes.
    // Bitsets win only when the DFS estimate is the larger of the two.
    const bitsetWork = componentCount * words;
    const sampledReach = averageReachSample(nodes, condensed);
    const dfsWork = sampledReach * nodes.length;
    if (dfsWork < bitsetWork / BITSET_WORK_RATIO) {
      return null;
    }
  }

  // `reach[c]` is the set of components reachable from c, including c itself. Components are
  // processed in reverse topological order, so every successor's set is already final.
  const reach: Uint32Array[] = new Array(componentCount);
  for (const component of condensed.order) {
    const set = new Uint32Array(words);
    set[component >>> 5]! |= 1 << (component & 31);
    for (const next of condensed.forward[component]!) {
      const nextSet = reach[next];
      if (!nextSet) {
        continue;
      }
      for (let word = 0; word < words; word += 1) {
        set[word]! |= nextSet[word]!;
      }
    }
    reach[component] = set;
  }

  // How many distinct nodes each component holds, so a set's bit count can be turned into a
  // node count without walking every member.
  const componentNodeCount = condensed.members.map((group) => group.length);

  const counts = new Map<string, number>();
  for (const node of nodes) {
    const component = condensed.componentOf.get(node);
    if (component === undefined) {
      counts.set(node, 0);
      continue;
    }
    const set = reach[component]!;
    let nodesReached = 0;
    for (let word = 0; word < words; word += 1) {
      let bits = set[word]!;
      while (bits !== 0) {
        const lowest = bits & -bits;
        const index = 31 - Math.clz32(lowest);
        nodesReached += componentNodeCount[(word << 5) + index] ?? 0;
        bits ^= lowest;
      }
    }
    // Exclude the node itself, matching `reachableSize`: a node does not depend on itself, but
    // another member of its cycle is a distinct node the traversal counts.
    counts.set(node, nodesReached - 1);
  }
  return counts;
}

/** How many nodes one component reaches, counting every member of each reachable component. */
function reachableNodeCount(component: number, condensed: CondensedGraph): number {
  const seen = new Set<number>();
  const stack = [component];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next)) {
      continue;
    }
    seen.add(next);
    for (const target of condensed.forward[next]!) {
      if (!seen.has(target)) {
        stack.push(target);
      }
    }
  }
  let total = 0;
  for (const reached of seen) {
    total += condensed.members[reached]?.length ?? 0;
  }
  return total;
}

/**
 * The average node-reach over a bounded sample of nodes, for the bitset-vs-DFS gate.
 *
 * Sampling up to 64 evenly-spaced nodes keeps the estimate cheap on a large graph while still
 * distinguishing a shallow tree (tiny reach) from a dense or cyclic graph (wide reach).
 */
function averageReachSample(nodes: readonly string[], condensed: CondensedGraph): number {
  const sample = Math.min(nodes.length, 64);
  const step = Math.max(1, Math.floor(nodes.length / sample));
  let total = 0;
  let counted = 0;
  for (let index = 0; index < nodes.length; index += step) {
    const component = condensed.componentOf.get(nodes[index]!);
    if (component === undefined) {
      continue;
    }
    total += reachableNodeCount(component, condensed);
    counted += 1;
  }
  return counted > 0 ? total / counted : 0;
}

/** Popcount of a 32-bit word. */
function popcount(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * Condense a directed graph into strongly connected components with an iterative Tarjan.
 *
 * Iterative because a deep chain of 50k files would overflow the call stack. Component ids are
 * assigned in `nodes` order for determinism, and members are sorted, so two runs on the same
 * graph produce byte-identical output.
 */
export function condense(nodes: readonly string[], adjacency: Map<string, string[]>): CondensedGraph {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const componentOf = new Map<string, number>();
  const members: string[][] = [];
  let nextIndex = 0;

  // Each frame remembers where in its neighbour list it is, so the traversal resumes there.
  interface Frame {
    node: string;
    neighbours: string[];
    offset: number;
  }

  for (const start of nodes) {
    if (index.has(start)) {
      continue;
    }
    const frames: Frame[] = [{ node: start, neighbours: adjacency.get(start) ?? [], offset: 0 }];
    index.set(start, nextIndex);
    low.set(start, nextIndex);
    nextIndex += 1;
    stack.push(start);
    onStack.add(start);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      if (frame.offset < frame.neighbours.length) {
        const neighbour = frame.neighbours[frame.offset]!;
        frame.offset += 1;
        if (!index.has(neighbour)) {
          index.set(neighbour, nextIndex);
          low.set(neighbour, nextIndex);
          nextIndex += 1;
          stack.push(neighbour);
          onStack.add(neighbour);
          frames.push({ node: neighbour, neighbours: adjacency.get(neighbour) ?? [], offset: 0 });
        } else if (onStack.has(neighbour)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(neighbour)!));
        }
        continue;
      }
      // Every neighbour is visited: this frame is finished.
      frames.pop();
      const finishedLow = low.get(frame.node)!;
      if (frames.length > 0) {
        const parent = frames[frames.length - 1]!.node;
        low.set(parent, Math.min(low.get(parent)!, finishedLow));
      }
      if (finishedLow === index.get(frame.node)) {
        const group: string[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          componentOf.set(member, members.length);
          group.push(member);
          if (member === frame.node) {
            break;
          }
        }
        group.sort();
        members.push(group);
      }
    }
  }

  const componentCount = members.length;
  const forwardSets: Array<Set<number>> = Array.from({ length: componentCount }, () => new Set<number>());
  const backwardSets: Array<Set<number>> = Array.from({ length: componentCount }, () => new Set<number>());
  for (const [source, targets] of adjacency) {
    const from = componentOf.get(source);
    if (from === undefined) {
      continue;
    }
    for (const target of targets) {
      const to = componentOf.get(target);
      if (to === undefined || to === from) {
        continue;
      }
      forwardSets[from]!.add(to);
      backwardSets[to]!.add(from);
    }
  }
  const forward = forwardSets.map((set) => [...set].sort((a, b) => a - b));
  const backward = backwardSets.map((set) => [...set].sort((a, b) => a - b));

  // Reverse topological order: a component appears after all components it reaches. Tarjan
  // already emits components in reverse topological order, so `0..n-1` is that order.
  const order = Array.from({ length: componentCount }, (_, component) => component);
  return { componentOf, members, forward, backward, order };
}

/** Reachability counts by node id for one direction, or null when the bitset path is unsafe. */
export function transitiveReach(
  nodes: readonly string[],
  adjacency: Map<string, string[]>,
  options: ReachabilityOptions = {},
): Map<string, number> | null {
  return componentReachability(nodes, adjacency, options);
}
