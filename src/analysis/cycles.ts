import type { Graph } from '../types.ts';
import { buildAdjacency } from './analysis.ts';

export interface CycleGroup {
  id: string;
  members: string[];
}

interface DfsFrame {
  node: string;
  neighbors: readonly string[];
  edgeIndex: number;
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

  for (const startNode of graph.nodes) {
    if (indices.has(startNode.id)) {
      continue;
    }

    const callStack: DfsFrame[] = [];

    indices.set(startNode.id, index);
    low.set(startNode.id, index);
    index += 1;
    stack.push(startNode.id);
    onStack.add(startNode.id);

    callStack.push({
      node: startNode.id,
      neighbors: forward.get(startNode.id) ?? [],
      edgeIndex: 0,
    });

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1] as DfsFrame;
      const { node, neighbors } = frame;

      if (frame.edgeIndex < neighbors.length) {
        const next = neighbors[frame.edgeIndex] as string;
        frame.edgeIndex += 1;

        if (!indices.has(next)) {
          indices.set(next, index);
          low.set(next, index);
          index += 1;
          stack.push(next);
          onStack.add(next);

          callStack.push({
            node: next,
            neighbors: forward.get(next) ?? [],
            edgeIndex: 0,
          });
        } else if (onStack.has(next)) {
          low.set(node, Math.min(low.get(node) as number, indices.get(next) as number));
        }
      } else {
        callStack.pop();

        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1] as DfsFrame;
          low.set(parent.node, Math.min(low.get(parent.node) as number, low.get(node) as number));
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
      }
    }
  }

  return groups.sort((a, b) => a.id.localeCompare(b.id));
}
