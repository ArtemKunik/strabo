import type { Graph, ViewPosition } from '../types.ts';
import { computeGraphMetrics } from './analysis.ts';

/** Grid spacing between node centres. Must exceed the largest node diameter (62). */
const CELL = 96;
/** Extra space between directory islands. */
const GAP = 48;
/** Target width/height ratio for the packed map. */
const ASPECT = 1.6;

interface Island {
  members: string[];
  columns: number;
  rows: number;
  width: number;
  height: number;
}

/**
 * Group nodes by directory, place important members in centre-out grid slots, then
 * shelf-pack directory islands toward a 1.6-wide aspect ratio.
 *
 * Islands are packed into rows rather than one tall column, so the whole map stays
 * roughly rectangular and `fit()` produces a readable overview instead of a hairline
 * strip. Stable ordering and precomputed coordinates prevent reloads from reshuffling.
 */
export function buildPositions(graph: Graph): ViewPosition[] {
  const metrics = computeGraphMetrics(graph);
  const byDirectory = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const list = byDirectory.get(node.directory);
    if (list) {
      list.push(node.id);
    } else {
      byDirectory.set(node.directory, [node.id]);
    }
  }

  const islands: Island[] = [...byDirectory.keys()].sort().map((directory) => {
    const members = (byDirectory.get(directory) as string[]).sort((a, b) => {
      const dependentsA = metrics.transitiveDependents.get(a) ?? 0;
      const dependentsB = metrics.transitiveDependents.get(b) ?? 0;
      if (dependentsB !== dependentsA) return dependentsB - dependentsA;
      return a.localeCompare(b);
    });
    const columns = Math.max(1, Math.ceil(Math.sqrt(members.length * ASPECT)));
    const rows = Math.ceil(members.length / columns);
    return { members, columns, rows, width: columns * CELL, height: rows * CELL };
  });

  const totalArea = islands.reduce((sum, island) => sum + island.width * island.height, 0);
  const targetWidth = Math.max(CELL, Math.sqrt(totalArea * ASPECT));

  // Pack tallest islands first so rows do not inherit a tall neighbour's height.
  const packed = [...islands].sort(
    (a, b) => b.height - a.height || b.width - a.width || a.members[0]?.localeCompare(b.members[0] ?? '') || 0,
  );

  const positions: ViewPosition[] = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;

  for (const island of packed) {
    if (cursorX > 0 && cursorX + island.width > targetWidth) {
      cursorX = 0;
      cursorY += rowHeight + GAP;
      rowHeight = 0;
    }
    island.members.forEach((id, index) => {
      const column = index % island.columns;
      const row = Math.floor(index / island.columns);
      positions.push({ id, x: cursorX + column * CELL, y: cursorY + row * CELL });
    });
    cursorX += island.width + GAP;
    rowHeight = Math.max(rowHeight, island.height);
  }

  positions.sort((a, b) => a.id.localeCompare(b.id));
  return positions;
}
