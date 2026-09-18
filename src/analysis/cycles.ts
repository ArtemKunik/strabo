import type { Graph } from '../types.ts';
import { buildAdjacency } from './analysis.ts';

export interface CycleGroup {
  id: string;
  members: string[];
}

/** Detect cycles in the resolved dependency graph (Tarjan's strongly connected components). */
export function computeCycles(graph: Graph): CycleGroup[] {
  const { forward } = buildAdjacency(graph);
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: CycleGroup[] = [];

  const visit = (node: string): void => {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of forward.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node) as number, low.get(next) as number));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) as number, indices.get(next) as number));
      }
    }

    if (low.get(node) === indices.get(node)) {
      const members: string[] = [];
      let current: string;
      do {
        current = stack.pop() as string;
        onStack.delete(current);
        members.push(current);
      } while (current !== node);
      if (members.length > 1) {
        members.sort();
        groups.push({ id: members[0] as string, members });
      }
    }
  };

  for (const node of graph.nodes) {
    if (!indices.has(node.id)) {
      visit(node.id);
    }
  }

  return groups.sort((a, b) => a.id.localeCompare(b.id));
}
