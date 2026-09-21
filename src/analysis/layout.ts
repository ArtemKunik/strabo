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

/** Horizontal pitch between dependency ranks: a unit card is 210px wide at its widest. */
const SYSTEM_COLUMN = 320;
/** Vertical pitch between units in a rank: leaves room for the card anchored below each node. */
const SYSTEM_ROW = 300;
/** Cap a rank's height, then wrap into another sub-column, so a wide rank stays readable. */
const SYSTEM_MAX_ROWS = 6;

/**
 * Order build units left-to-right by dependency depth (L20).
 *
 * A unit sits one rank to the right of everything it imports, so the map reads as a build
 * order: foundations on the left, the units that pull them in on the right. A rank taller
 * than `SYSTEM_MAX_ROWS` wraps into extra sub-columns instead of one endless strip, so a
 * wide, shallow graph (many independent units) still packs into a roughly rectangular map.
 * A unit that imports something unknown, and any edge in a cycle, contributes no rank, so
 * the walk always terminates and every unit is placed exactly once.
 */
export function buildSystemPositions(
  units: ReadonlyArray<{ id: string }>,
  edges: ReadonlyArray<{ source: string; target: string }>,
): ViewPosition[] {
  const dependencies = new Map<string, string[]>();
  for (const unit of units) {
    dependencies.set(unit.id, []);
  }
  for (const edge of edges) {
    const list = dependencies.get(edge.source);
    if (list && dependencies.has(edge.target)) {
      list.push(edge.target);
    }
  }

  const ranks = new Map<string, number>();
  const visiting = new Set<string>();
  function rankOf(id: string): number {
    const known = ranks.get(id);
    if (known !== undefined) {
      return known;
    }
    if (visiting.has(id)) {
      return 0;
    }
    visiting.add(id);
    let rank = 0;
    for (const dependency of dependencies.get(id) ?? []) {
      rank = Math.max(rank, rankOf(dependency) + 1);
    }
    visiting.delete(id);
    ranks.set(id, rank);
    return rank;
  }

  const byRank = new Map<number, string[]>();
  for (const unit of units) {
    const rank = rankOf(unit.id);
    const list = byRank.get(rank);
    if (list) {
      list.push(unit.id);
    } else {
      byRank.set(rank, [unit.id]);
    }
  }

  const positions: ViewPosition[] = [];
  let cursorX = 0;
  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const members = (byRank.get(rank) as string[]).sort((a, b) => a.localeCompare(b));
    const subColumns = Math.max(1, Math.ceil(members.length / SYSTEM_MAX_ROWS));
    members.forEach((id, index) => {
      const subColumn = Math.floor(index / SYSTEM_MAX_ROWS);
      const row = index % SYSTEM_MAX_ROWS;
      const rows = Math.min(SYSTEM_MAX_ROWS, members.length - subColumn * SYSTEM_MAX_ROWS);
      positions.push({
        id,
        x: cursorX + subColumn * SYSTEM_COLUMN,
        y: (row - (rows - 1) / 2) * SYSTEM_ROW,
      });
    });
    cursorX += subColumns * SYSTEM_COLUMN + GAP;
  }

  positions.sort((a, b) => a.id.localeCompare(b.id));
  return positions;
}
