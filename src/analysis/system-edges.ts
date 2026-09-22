import type { Graph } from '../types.ts';
import type { SystemEdge } from './system-types.ts';
import type { SystemUnit } from './units.ts';

export function aggregateEdges(
  graph: Graph,
  assignment: Map<string, string>,
  unitById: Map<string, SystemUnit>,
  componentFiles: Map<string, string[]>,
): SystemEdge[] {
  const components = new Set<string>();
  for (const files of componentFiles.values()) {
    for (const file of files) {
      components.add(file);
    }
  }
  const byPair = new Map<string, SystemEdge>();
  for (const edge of graph.edges) {
    // A call edge always parallels an import edge for the same pair, so counting both would
    // double the unit weight. The unit view stays import coupling; calls are a file-level lens.
    if (edge.kind === 'call') {
      continue;
    }
    if (!components.has(edge.source) || !components.has(edge.target)) {
      continue;
    }
    const source = assignment.get(edge.source) ?? '.';
    const target = assignment.get(edge.target) ?? '.';
    if (source === target || !unitById.has(source) || !unitById.has(target)) {
      continue;
    }
    const key = `${source}\u0000${target}`;
    const existing = byPair.get(key);
    if (existing) {
      existing.weight += 1;
      if (existing.samples.length < 3) {
        existing.samples.push(edge.evidence.specifier);
      }
    } else {
      byPair.set(key, {
        source,
        target,
        kind: 'import',
        weight: 1,
        samples: [edge.evidence.specifier],
      });
    }
  }
  return [...byPair.values()].sort(
    (a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
  );
}
