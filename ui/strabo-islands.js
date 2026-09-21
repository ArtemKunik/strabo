/**
 * Directory islands: the backplates drawn behind the map so a directory reads as one
 * region instead of a run of unrelated dots.
 *
 * There is no second layout here. `buildPositions` (src/analysis/layout.ts) already packs
 * each directory's members into their own grid block and shelf-packs the blocks, so an
 * island is just the bounding box of the members the layout put together. Nothing is
 * inferred that the layout did not already decide, and nothing moves when islands are
 * drawn or hidden.
 *
 * Pure geometry: no DOM, no Cytoscape. Bounds come back in model coordinates; the caller
 * projects them with the viewport's own pan and zoom.
 */

import { diameter } from './strabo-graph.js';

/** Gap between the outermost node edge and the plate, in model units. */
export const ISLAND_PADDING = 26;

/** The repository root is stored as `.` by the scanner; on the map it reads as `/`. */
export function islandLabel(directory) {
  return directory === '.' ? '/' : directory;
}

/**
 * Whether a view model should be drawn with islands at all.
 *
 * Block mode aggregates each directory into a single node, so its `directory` is the
 * *parent* of the block. Every top-level block would land in one island spanning the
 * whole map, which says nothing. Islands are a file-mode affordance.
 */
export function islandsApply(model) {
  return Boolean(model) && model.prefixLength === undefined && model.system !== true;
}

/**
 * Bounding box per directory, in model coordinates.
 *
 * `visible` is the set of node ids currently passing the filter; pass null for all. An
 * island shrinks to its surviving members rather than holding the shape of a set that is
 * no longer drawn, and a directory filtered out entirely drops rather than lingering as
 * an empty plate.
 *
 * A node the layout gave no position is skipped: a plate around a node that is not drawn
 * would claim a region the map does not show.
 */
export function islandBounds(model, options = {}) {
  if (!islandsApply(model)) {
    return [];
  }

  const padding = options.padding ?? ISLAND_PADDING;
  const visible = options.visible ?? null;
  const positions = new Map((model.positions ?? []).map((position) => [position.id, position]));
  const groups = new Map();

  for (const node of model.nodes ?? []) {
    if (visible && !visible.has(node.id)) {
      continue;
    }
    const position = positions.get(node.id);
    if (!position) {
      continue;
    }
    const directory = node.directory ?? '.';
    // Half the drawn node, so the plate encloses the circle rather than its centre.
    const radius = diameter(node.transitiveDependents) / 2;
    const group = groups.get(directory) ?? {
      directory,
      count: 0,
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    };
    group.count += 1;
    group.minX = Math.min(group.minX, position.x - radius);
    group.minY = Math.min(group.minY, position.y - radius);
    group.maxX = Math.max(group.maxX, position.x + radius);
    group.maxY = Math.max(group.maxY, position.y + radius);
    groups.set(directory, group);
  }

  return [...groups.values()]
    .map((group) => ({
      directory: group.directory,
      label: islandLabel(group.directory),
      count: group.count,
      x: group.minX - padding,
      y: group.minY - padding,
      width: group.maxX - group.minX + padding * 2,
      height: group.maxY - group.minY + padding * 2,
    }))
    // Largest first so a smaller plate is never buried by a bigger one drawn later.
    .sort(
      (a, b) => b.width * b.height - a.width * a.height || a.directory.localeCompare(b.directory),
    );
}

/**
 * Project a model-coordinate island onto the viewport.
 *
 * Cytoscape's transform is `rendered = model * zoom + pan`, so islands hold their place
 * over the nodes without being recomputed on every pan or wheel tick.
 */
export function projectIsland(island, viewport) {
  const zoom = viewport.zoom;
  return {
    x: island.x * zoom + viewport.pan.x,
    y: island.y * zoom + viewport.pan.y,
    width: island.width * zoom,
    height: island.height * zoom,
  };
}

/** Below this rendered size a plate has no room for its name, so the label is dropped. */
export const LABEL_MIN_WIDTH = 64;
export const LABEL_MIN_HEIGHT = 28;

export function islandLabelFits(projected) {
  return projected.width >= LABEL_MIN_WIDTH && projected.height >= LABEL_MIN_HEIGHT;
}

/**
 * The island under a device-space pointer, or null.
 *
 * Only islands whose drawn label had to be trimmed are candidates: when the plate already
 * shows the full directory there is nothing for a hover to reveal. When boxes overlap, the
 * smallest wins so a nested plate is not shadowed by the larger one it sits inside.
 */
export function islandHit(boxes, x, y) {
  let best = null;
  let bestArea = Infinity;
  for (const box of boxes) {
    if (!box.trimmed) {
      continue;
    }
    if (x < box.x || y < box.y || x > box.x + box.width || y > box.y + box.height) {
      continue;
    }
    const area = box.width * box.height;
    if (area < bestArea) {
      best = box;
      bestArea = area;
    }
  }
  return best;
}

/** The hover caption for a trimmed island: the full path, and its member count. */
export function islandTooltipText(box) {
  const label = box.label ?? islandLabel(box.directory ?? '.');
  const count = box.count ?? 0;
  return count > 1 ? `${label} · ${count} files` : label;
}

/** Inset from the plate edge to the first glyph, in device pixels. */
export const LABEL_INSET = 10;
/**
 * Advance width of one glyph at the label's 11px monospace size. The face is monospace by
 * construction, so a constant measures it as well as the DOM would and costs nothing on a
 * pan, where every island is re-laid out per frame. Rounded up rather than down: over-
 * estimating spends a character, under-estimating puts the label back over its neighbour.
 */
export const LABEL_CHAR_WIDTH = 6.6;
/** Fewer glyphs than this and the ellipsis is most of the name, so drop the label. */
export const LABEL_MIN_CHARS = 4;

/**
 * Trim a directory to what its plate can hold, keeping the tail.
 *
 * A path earns its keep at the end — `…/acceptance/steps` still says where you are, while
 * trimming the tail instead would render a dozen different islands as `test/fixtures/…`.
 * Untrimmed, the label overflows its plate and collides with the neighbouring island's.
 */
export function fitLabel(label, widthPx) {
  const budget = Math.floor((widthPx - LABEL_INSET * 2) / LABEL_CHAR_WIDTH);
  if (budget < LABEL_MIN_CHARS) {
    return '';
  }
  if (label.length <= budget) {
    return label;
  }
  return `…${label.slice(-(budget - 1))}`;
}
