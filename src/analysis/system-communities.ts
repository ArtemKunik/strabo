import type { Graph } from '../types.ts';
import type { SystemCommunity, SystemLayer } from './system-types.ts';

/** Edges inside one layer, undirected, as an adjacency map. */
function layerAdjacency(layer: SystemLayer, graph: Graph): Map<string, Set<string>> {
  const members = new Set(layer.files);
  const adjacency = new Map<string, Set<string>>(layer.files.map((file) => [file, new Set<string>()]));
  for (const edge of graph.edges) {
    if (edge.source === edge.target || !members.has(edge.source) || !members.has(edge.target)) {
      continue;
    }
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  return adjacency;
}

/**
 * Communities inside a layer, by one greedy modularity pass (the Louvain first phase).
 *
 * The pass is deterministic — members are visited in sorted order and a tie keeps the
 * current community — so the same graph yields the same communities without a cache. A
 * community is snapped to its layer: it never crosses a unit or a layer boundary.
 */
export function detectCommunities(unit: string, layer: SystemLayer, graph: Graph): SystemCommunity[] {
  const adjacency = layerAdjacency(layer, graph);
  const members = layer.files.slice().sort();
  if (members.length < 2) {
    return [];
  }
  const degree = new Map(members.map((file) => [file, adjacency.get(file)?.size ?? 0]));
  const totalEdges = [...degree.values()].reduce((sum, value) => sum + value, 0) / 2;
  if (totalEdges === 0) {
    return [];
  }
  // Each node starts in its own community; a move is taken only when it raises modularity,
  // so a node with no edge to anyone stays a singleton and is not reported.
  const community = new Map<string, number>(members.map((file, index) => [file, index]));
  const communityDegree = new Map<number, number>(
    members.map((file, index) => [index, degree.get(file) ?? 0]),
  );
  const scale = 2 * totalEdges * totalEdges;

  for (let pass = 0; pass < 10; pass += 1) {
    let moved = false;
    for (const file of members) {
      const neighbours = adjacency.get(file) ?? new Set<string>();
      if (neighbours.size === 0) {
        continue;
      }
      const current = community.get(file) as number;
      const ki = degree.get(file) ?? 0;
      const links = new Map<number, number>();
      let selfWeight = 0;
      for (const neighbour of neighbours) {
        const target = community.get(neighbour) as number;
        if (target === current) {
          selfWeight += 1;
        } else {
          links.set(target, (links.get(target) ?? 0) + 1);
        }
      }
      communityDegree.set(current, (communityDegree.get(current) ?? 0) - ki);
      const gain = (target: number, weight: number): number =>
        weight / totalEdges -
        ((communityDegree.get(target) ?? 0) * ki) / scale;
      let best = current;
      let bestGain = gain(current, selfWeight);
      for (const [candidate, weight] of [...links.entries()].sort((a, b) => a[0] - b[0])) {
        const candidateGain = gain(candidate, weight);
        if (candidateGain > bestGain) {
          best = candidate;
          bestGain = candidateGain;
        }
      }
      community.set(file, best);
      communityDegree.set(best, (communityDegree.get(best) ?? 0) + ki);
      if (best !== current) {
        moved = true;
      }
    }
    if (!moved) {
      break;
    }
  }

  const groups = new Map<number, string[]>();
  for (const file of members) {
    const id = community.get(file) as number;
    groups.set(id, [...(groups.get(id) ?? []), file]);
  }

  return [...groups.entries()]
    .filter(([, files]) => files.length > 1)
    .sort((a, b) => a[0] - b[0])
    .map(([id, files]) => {
      let inside = 0;
      let total = 0;
      const set = new Set(files);
      for (const file of files) {
        for (const neighbour of adjacency.get(file) ?? []) {
          total += 1;
          if (set.has(neighbour)) {
            inside += 1;
          }
        }
      }
      const ratio = total === 0 ? 1 : inside / total;
      return {
        id: `${unit}:${layer.name}:${id}`,
        unit,
        layer: layer.name,
        members: files,
        internalRatio: Number(ratio.toFixed(3)),
        why: `community: ${files.length} files, ${Math.round(ratio * 100)}% of edges internal`,
      };
    });
}
