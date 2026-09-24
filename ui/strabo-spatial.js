/**
 * A coarse spatial grid over a view model's node boxes, in model coordinates.
 *
 * The island layer has to know whether a press lands on a node before it claims the press
 * for a directory drag, and doing that by asking every drawn node for its rendered box is
 * O(nodes) on each press. The grid is built once per render instead (and rebuilt when the
 * filter or a drag changes it), so the test examines only the cells a point could fall in.
 *
 * Pure geometry: no DOM, no Cytoscape. Hit-testing projects the pointer into model space
 * with Cytoscape's own `rendered = model * zoom + pan`, the inverse of `projectIsland`.
 */

import { nodeDiameter } from './strabo-graph-sizing.js';

/** Side of one grid cell, in model units. Larger than the largest drawn node. */
export const GRID_CELL = 256;

/**
 * Bucket each visible node by the cell its centre falls in.
 *
 * `visible` is the filter's surviving id set, or null for all. A node without a position is
 * skipped: it is not drawn, so it cannot be hit. `maxRadius` sizes the query's neighbourhood
 * so a node whose centre is in a nearby cell but whose box reaches the point is still found.
 */
export function buildNodeGrid(nodes, positions, options = {}) {
  const visible = options.visible ?? null;
  const cell = options.cell ?? GRID_CELL;
  const byId = new Map((positions ?? []).map((position) => [position.id, position]));
  const cells = new Map();
  let maxRadius = 0;

  for (const node of nodes ?? []) {
    if (visible && !visible.has(node.id)) {
      continue;
    }
    const position = byId.get(node.id);
    if (!position) {
      continue;
    }
    const radius = nodeDiameter(node) / 2;
    if (radius > maxRadius) {
      maxRadius = radius;
    }
    const key = `${Math.floor(position.x / cell)},${Math.floor(position.y / cell)}`;
    const entry = { x: position.x, y: position.y, radius };
    const list = cells.get(key);
    if (list) {
      list.push(entry);
    } else {
      cells.set(key, [entry]);
    }
  }

  return { cells, cell, maxRadius };
}

/** Whether any node box in `grid` contains the model-space point `(x, y)`. */
export function gridHit(grid, x, y) {
  if (!grid || !grid.cells || grid.cells.size === 0) {
    return false;
  }
  const { cells, cell } = grid;
  const span = Math.max(1, Math.ceil(grid.maxRadius / cell));
  const cx = Math.floor(x / cell);
  const cy = Math.floor(y / cell);
  for (let gx = cx - span; gx <= cx + span; gx += 1) {
    for (let gy = cy - span; gy <= cy + span; gy += 1) {
      const list = cells.get(`${gx},${gy}`);
      if (!list) {
        continue;
      }
      for (const entry of list) {
        if (
          x >= entry.x - entry.radius &&
          x <= entry.x + entry.radius &&
          y >= entry.y - entry.radius &&
          y <= entry.y + entry.radius
        ) {
          return true;
        }
      }
    }
  }
  return false;
}
