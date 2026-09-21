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
  // The server may supply a compressed, unit-anchored label per directory; fall back to the
  // recorded path when it does not.
  const labels = options.labels ?? null;
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
      label: labels?.[group.directory] ?? islandLabel(group.directory),
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
 * A validated `directory → { dx, dy }` map, rebuilt from stored JSON.
 *
 * Persisted layout is operator input read back from localStorage, so nothing is trusted:
 * a non-object, a non-string key, or a non-finite pair is dropped rather than applied, and
 * a zero move is dropped because it says nothing. The result is always a plain object.
 */
export function normalizeIslandOffsets(raw) {
  const offsets = {};
  if (!raw || typeof raw !== 'object') {
    return offsets;
  }
  for (const [directory, value] of Object.entries(raw)) {
    if (!directory || !value || typeof value !== 'object') {
      continue;
    }
    const dx = Number(value.dx);
    const dy = Number(value.dy);
    if (Number.isFinite(dx) && Number.isFinite(dy) && (dx !== 0 || dy !== 0)) {
      offsets[directory] = { dx, dy };
    }
  }
  return offsets;
}

/** The recorded move for one directory, or null when it sits where the layout put it. */
export function islandOffset(offsets, directory) {
  const entry = offsets?.[directory];
  return entry ? { dx: entry.dx, dy: entry.dy } : null;
}

/** Whether any directory has been moved. */
export function hasIslandOffsets(offsets) {
  return Object.keys(offsets ?? {}).length > 0;
}

/**
 * A new offsets map with `directory` moved `dx`/`dy` further from wherever it already sits.
 *
 * The offset is the island's whole displacement from the computed layout, so a live drag
 * accumulates: each pointer move adds to it rather than replacing it.
 */
export function shiftIslandOffset(offsets, directory, dx, dy) {
  if (!directory || !Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
    return offsets ?? {};
  }
  const previous = offsets?.[directory] ?? { dx: 0, dy: 0 };
  return { ...offsets, [directory]: { dx: previous.dx + dx, dy: previous.dy + dy } };
}

/**
 * Replay the operator's island moves onto a fresh model.
 *
 * The unit that moves is the directory, but a position is per file, so a stored offset has
 * to be applied on every render — after a rescan, a filter change, or a mode toggle — or a
 * reload would snap every plate back. A model whose islands do not apply (block or System
 * mode), or one with no offsets, is returned untouched so a caller can cheaply skip it.
 */
export function applyIslandOffsets(model, offsets) {
  if (!model || !islandsApply(model) || !hasIslandOffsets(offsets)) {
    return model;
  }
  const directoryById = new Map(
    (model.nodes ?? []).map((node) => [node.id, node.directory ?? '.']),
  );
  const positions = (model.positions ?? []).map((position) => {
    const offset = islandOffset(offsets, directoryById.get(position.id));
    if (!offset) {
      return position;
    }
    return { ...position, x: position.x + offset.dx, y: position.y + offset.dy };
  });
  return { ...model, positions };
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

/**
 * The uniform device-space shift between two projections, or null when they differ otherwise.
 *
 * A pan is the one viewport change that moves every plate by the same amount without
 * resizing it. Detecting that lets the island layer translate its whole SVG group instead of
 * rewriting each plate's geometry and re-running the label-collision pass, which is the
 * expensive half of a repaint. `islands` is the model set behind `next`; its directory,
 * label, and count are compared so a filter that swapped a same-sized directory for another
 * is not mistaken for a pan. Floating-point projection is compared with a small epsilon,
 * because a false negative only costs a full repaint.
 */
export function uniformIslandShift(previous, islands, next) {
  if (!previous || !next || previous.length === 0 || previous.length !== next.length) {
    return null;
  }
  const epsilon = 1e-6;
  const dx = next[0].x - previous[0].x;
  const dy = next[0].y - previous[0].y;
  for (let index = 0; index < next.length; index += 1) {
    const before = previous[index];
    const after = next[index];
    if (after.width !== before.width || after.height !== before.height) {
      return null;
    }
    if (
      islands[index].directory !== before.directory ||
      islands[index].label !== before.label ||
      islands[index].count !== before.count
    ) {
      return null;
    }
    if (Math.abs(after.x - before.x - dx) > epsilon || Math.abs(after.y - before.y - dy) > epsilon) {
      return null;
    }
  }
  return { dx, dy };
}

/** Rendered label box: 11px type sitting `LABEL_BASELINE_GAP` above the plate's top edge. */
export const LABEL_HEIGHT = 12;
export const LABEL_BASELINE_GAP = 6;

function rectsOverlap(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Which plates may keep their label once labels are held at one device size.
 *
 * Plates shrink with zoom but their labels do not, so a zoomed-out map runs out of gap
 * above each plate and the title lands on the plate above it, or on the title next to it.
 * Plates are walked in order (largest first) and a label survives only if its box clears
 * every other plate and every label already kept; the rest stay silent and the hover
 * caption still names them. `texts[i]` is the text island `i` would draw ('' for none).
 * Returns, per island, whether its label may be drawn.
 */
export function labelsThatFit(boxes, texts) {
  // A pan repaints every plate each frame, so neighbours come from a bucket grid instead
  // of an all-pairs scan.
  const bucket = 128;
  const plateGrid = new Map();
  const labelGrid = new Map();
  const cellsOf = (rect) => {
    const cells = [];
    for (let cx = Math.floor(rect.x / bucket); cx <= Math.floor((rect.x + rect.width) / bucket); cx += 1) {
      for (let cy = Math.floor(rect.y / bucket); cy <= Math.floor((rect.y + rect.height) / bucket); cy += 1) {
        cells.push(`${cx},${cy}`);
      }
    }
    return cells;
  };
  const add = (grid, rect, owner) => {
    for (const key of cellsOf(rect)) {
      const list = grid.get(key);
      if (list) list.push({ rect, owner });
      else grid.set(key, [{ rect, owner }]);
    }
  };
  const hits = (grid, rect, owner) =>
    cellsOf(rect).some((key) =>
      (grid.get(key) ?? []).some((entry) => entry.owner !== owner && rectsOverlap(rect, entry.rect)),
    );

  boxes.forEach((box, index) => add(plateGrid, box, index));

  return boxes.map((box, index) => {
    const text = texts[index];
    if (!text) {
      return false;
    }
    const label = {
      x: box.x + LABEL_INSET,
      y: box.y - LABEL_BASELINE_GAP - LABEL_HEIGHT + 2,
      width: text.length * LABEL_CHAR_WIDTH,
      height: LABEL_HEIGHT,
    };
    if (hits(plateGrid, label, index) || hits(labelGrid, label, index)) {
      return false;
    }
    add(labelGrid, label, index);
    return true;
  });
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

/**
 * The plate under a pointer when the intent is to drag it: any plate, trimmed or not.
 *
 * The hover caption only serves a plate whose label was cut short, so `islandHit` skips the
 * rest; a drag has no such reason to. Overlap resolves the same way — smallest wins, so a
 * plate nested inside another moves on its own rather than taking the larger one with it.
 */
export function islandHitAny(boxes, x, y) {
  let best = null;
  let bestArea = Infinity;
  for (const box of boxes) {
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
