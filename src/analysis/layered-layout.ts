import type { Graph } from '../types.ts';
import type { ViewPosition } from '../types/view.ts';

/** Horizontal room per node: wide enough for a directory label under a full-size node. */
const CELL_X = 150;
/** Vertical room per layer, so arrows between layers stay readable. */
const CELL_Y = 150;
/** A layer wider than this wraps onto extra rows instead of stretching the map sideways. */
const MAX_PER_ROW = 8;
/** How far every other node on a row drops when nodes on that row import each other. */
const STAGGER = CELL_Y * 0.3;
/** Barycentre sweeps; a few passes settle the order of a directory-sized graph. */
const SWEEPS = 4;
/** Width over height the rows aim for, so a deep chain does not draw as a thin column. */
const ASPECT = 1.6;
/** Fewer rows than this and the direction of the flow stops reading. */
const MIN_ROWS = 4;

/**
 * Lay a small aggregate graph out in dependency layers: importers above what they import,
 * so edges point down and the shared foundations collect at the bottom.
 *
 * A grid that ignores edges sends them across each other in every direction; layering makes
 * direction readable at a glance. Directories often import each other in cycles, which have
 * no top-to-bottom order, so a small set of edges is set aside first (Eades–Lin–Smyth) and
 * those are the ones drawn pointing up: the edges that close a cycle. A deep chain of layers
 * is merged into rows that keep the map's proportions. Within a row, nodes
 * are ordered by the average position of their neighbours to cut crossings. Nodes with no
 * edges stand in a column to the right, apart from the flow (and clear of the canvas's
 * bottom-centre hint). Deterministic: the same graph always lays out the same way.
 */
export function buildLayeredPositions(graph: Graph): ViewPosition[] {
  const ids = graph.nodes.map((node) => node.id).sort();
  const known = new Set(ids);
  const out = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  const into = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  for (const edge of graph.edges) {
    if (edge.source === edge.target || !known.has(edge.source) || !known.has(edge.target)) continue;
    out.get(edge.source)!.add(edge.target);
    into.get(edge.target)!.add(edge.source);
  }

  const isolated = ids.filter((id) => out.get(id)!.size === 0 && into.get(id)!.size === 0);
  const connected = ids.filter((id) => !isolated.includes(id));
  const layerOf = longestPathLayers(acyclicOrder(connected, out, into), out);

  const ranked: string[][] = [];
  for (const id of connected) {
    const layer = layerOf.get(id)!;
    (ranked[layer] ??= []).push(id);
  }
  const layers = mergeIntoRows(ranked.filter((layer) => layer && layer.length > 0), connected.length);
  orderByBarycentre(layers, out, into);

  const positions: ViewPosition[] = [];
  let row = 0;
  for (const layer of layers) {
    // Wrap a wide row into even parts (9 as 5 + 4, not 8 + 1), so no node is left alone on
    // a row that would read as a layer of its own.
    const parts = Math.ceil(layer.length / MAX_PER_ROW);
    const perPart = Math.ceil(layer.length / parts);
    for (let start = 0; start < layer.length; start += perPart) {
      const slice = layer.slice(start, start + perPart);
      // Edges between nodes on one row would lie on top of each other along it; a zigzag
      // gives each its own line. A row with no such edges stays straight.
      const members = new Set(slice);
      const stagger = slice.some((id) => [...out.get(id)!].some((target) => members.has(target))) ? STAGGER : 0;
      // Centre each row on x = 0 so a narrow layer sits under the middle of a wide one.
      const offset = ((slice.length - 1) * CELL_X) / 2;
      slice.forEach((id, index) =>
        positions.push({ id, x: index * CELL_X - offset, y: row * CELL_Y + (index % 2) * stagger }),
      );
      row += 1;
    }
  }
  const right = positions.reduce((max, position) => Math.max(max, position.x), -CELL_X);
  isolated.forEach((id, index) => positions.push({ id, x: right + CELL_X * 1.5, y: index * CELL_Y }));
  return positions.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * A linear order in which few edges point backwards (the Eades–Lin–Smyth greedy heuristic):
 * peel sinks onto the end and sources onto the front; when neither is left, move the node
 * with the most outgoing over incoming edges to the front. An edge running backwards in
 * this order is one that closes a cycle.
 */
function acyclicOrder(
  ids: readonly string[],
  out: ReadonlyMap<string, Set<string>>,
  into: ReadonlyMap<string, Set<string>>,
): string[] {
  const remaining = new Set(ids);
  const outDegree = new Map(ids.map((id) => [id, out.get(id)!.size]));
  const inDegree = new Map(ids.map((id) => [id, into.get(id)!.size]));
  const front: string[] = [];
  const back: string[] = [];
  const remove = (id: string) => {
    remaining.delete(id);
    for (const target of out.get(id)!) if (remaining.has(target)) inDegree.set(target, inDegree.get(target)! - 1);
    for (const source of into.get(id)!) if (remaining.has(source)) outDegree.set(source, outDegree.get(source)! - 1);
  };

  while (remaining.size > 0) {
    let peeled = true;
    while (peeled) {
      peeled = false;
      for (const id of [...remaining]) {
        if (!remaining.has(id)) continue;
        if (outDegree.get(id) === 0) {
          back.unshift(id);
          remove(id);
          peeled = true;
        } else if (inDegree.get(id) === 0) {
          front.push(id);
          remove(id);
          peeled = true;
        }
      }
    }
    if (remaining.size === 0) break;
    // `remaining` keeps the sorted insertion order, so ties go to the first id.
    let best = '';
    let bestScore = -Infinity;
    for (const id of remaining) {
      const score = outDegree.get(id)! - inDegree.get(id)!;
      if (score > bestScore) {
        best = id;
        bestScore = score;
      }
    }
    front.push(best);
    remove(best);
  }
  return [...front, ...back];
}

/**
 * Group consecutive layers into about √(n / ASPECT) rows of similar size.
 *
 * A densely cross-linked set of directories gives a long chain of one-node layers; drawn as
 * is, the map zooms out until labels vanish and every long edge runs down the same spine.
 * Merging neighbouring layers keeps the top-to-bottom order and the overall proportions,
 * at the cost of some edges running sideways within a row.
 */
function mergeIntoRows(layers: string[][], count: number): string[][] {
  const rows = Math.max(MIN_ROWS, Math.round(Math.sqrt(count / ASPECT)));
  if (layers.length <= rows) return layers;
  const target = count / rows;
  const merged: string[][] = [];
  let current: string[] = [];
  let placed = 0;
  layers.forEach((layer, index) => {
    current.push(...layer);
    placed += layer.length;
    const layersLeft = layers.length - index - 1;
    const rowsLeft = rows - merged.length - 1;
    // Close the row once it reaches its share, or when the remaining layers are only just
    // enough to give each remaining row one.
    if ((placed >= target * (merged.length + 1) || layersLeft <= rowsLeft) && rowsLeft > 0) {
      merged.push(current);
      current = [];
    }
  });
  if (current.length > 0) merged.push(current);
  return merged;
}

/** Each node's layer: the longest chain of forward edges (in `order`) leading down to it. */
function longestPathLayers(order: readonly string[], out: ReadonlyMap<string, Set<string>>): Map<string, number> {
  const position = new Map(order.map((id, index) => [id, index]));
  const layer = new Map(order.map((id) => [id, 0]));
  for (const id of order) {
    for (const target of out.get(id) ?? []) {
      if (position.get(target)! > position.get(id)!) {
        layer.set(target, Math.max(layer.get(target)!, layer.get(id)! + 1));
      }
    }
  }
  return layer;
}

/** Reorder each layer by the mean position of its neighbours in the adjacent layer, sweeping down then up. */
function orderByBarycentre(
  layers: string[][],
  out: ReadonlyMap<string, Set<string>>,
  into: ReadonlyMap<string, Set<string>>,
): void {
  const reorder = (layer: string[], reference: string[], neighbours: ReadonlyMap<string, Set<string>>) => {
    const slot = new Map(reference.map((id, position) => [id, position]));
    const score = new Map<string, number>();
    layer.forEach((id, position) => {
      const placed = [...(neighbours.get(id) ?? [])].filter((other) => slot.has(other)).map((other) => slot.get(other)!);
      score.set(id, placed.length > 0 ? placed.reduce((sum, value) => sum + value, 0) / placed.length : position);
    });
    layer.sort((a, b) => score.get(a)! - score.get(b)! || a.localeCompare(b));
  };
  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    for (let layer = 1; layer < layers.length; layer += 1) {
      const current = layers[layer];
      const above = layers[layer - 1];
      if (current && above) reorder(current, above, into);
    }
    for (let layer = layers.length - 2; layer >= 0; layer -= 1) {
      const current = layers[layer];
      const below = layers[layer + 1];
      if (current && below) reorder(current, below, out);
    }
  }
}
