/**
 * Canvas geometry for the Structure stack (Phase 35 Y3).
 *
 * The server places the tier bands on a fixed pitch because it does not know how big each
 * card draws; here the cards are re-packed along the stack by their drawn size, so the gap
 * between two cards is the same whatever their file counts. Edges then bow off the stack's
 * spine: a pair importing each other splits into two arcs (one per direction, each with
 * its own label), and a skip-layer edge arcs around the bands it jumps instead of running
 * underneath them.
 *
 * Pure functions only: no DOM, no Cytoscape, no fetch.
 */

import { nodeDiameter } from './strabo-graph-sizing.js';

/** Clear space between two neighbouring cards: room for an edge label between them. */
const STACK_GAP = 150;
const SHELF_GAP = 120;
/** How far the two halves of a bidirectional pair bow apart. */
const PAIR_BEND = 46;
/** Device pixels each half of a pair's label moves off the other. */
const PAIR_LABEL_SHIFT = 11;
/** Clear space between a skip arc's apex and the cards it jumps; nested arcs step out by `SKIP_NEST`. */
const ARC_CLEARANCE = 28;
const SKIP_NEST = 64;
/** A card label's footprint in model units: per line, its gap, and half its widest run. */
const LABEL_LINE = 15;
const LABEL_GAP = 14;
/** A vertical stack's side labels: the gap to the card, and the widest run they take. */
const LABEL_SIDE_GAP = 8;
const LABEL_WIDTH = 240;
/** Room for a bowed edge's label beyond its apex, and between the stack's plate and the shelf's. */
const ARC_LABEL_ROOM = 16;
const ARC_LABEL_HALF_WIDTH = 75;
const SHELF_CLEARANCE = 110;
/** Clear space between neighbouring data hubs in a column. */
const DATA_HUB_GAP = 84;
/** How many hubs a data-hub column holds before the reading wraps to the next column. */
const DATA_HUB_ROWS = 8;
/** Clear space between the stack's plate and the first data-hub column beyond it. */
const DATA_HUB_CLEARANCE = 120;

/**
 * Whether a card writes its label beside it rather than beneath: the bands of a vertical
 * stack, whose gaps along the stack are left to the edge labels.
 */
export function sideLabelled(model, node) {
  return isStructureStack(model) && model.structureDirection !== 'horizontal' && node.kind === 'tier';
}

/**
 * How far each edge's label is nudged along the screen's vertical, in device pixels, indexed
 * like `model.edges`: the two halves of an A⇄B pair split up and down, so their labels never
 * sit on each other even when the arcs between two close cards barely part.
 */
export function structureLabelShifts(model, rank) {
  const edges = model.edges ?? [];
  const pairs = new Set(edges.map((edge) => `${edge.source}\u0000${edge.target}`));
  return edges.map((edge) => {
    const from = rank.get(edge.source);
    const to = rank.get(edge.target);
    if (from === undefined || to === undefined || Math.abs(from - to) !== 1) return 0;
    if (!pairs.has(`${edge.target}\u0000${edge.source}`)) return 0;
    return from < to ? -PAIR_LABEL_SHIFT : PAIR_LABEL_SHIFT;
  });
}

/** Whether this model is the Structure stack (not the grid or a cell drill-down). */
export function isStructureStack(model) {
  return model?.structure === true && typeof model.structureDirection === 'string';
}

/** Lay one row of nodes along `axis`, keeping the first one's coordinate as the anchor. */
function pack(row, axis, gap, positions) {
  const sorted = [...row].sort((a, b) => positions.get(a.id)[axis] - positions.get(b.id)[axis]);
  let cursor = null;
  let previousRadius = 0;
  for (const node of sorted) {
    const position = positions.get(node.id);
    const radius = nodeDiameter(node) / 2;
    cursor = cursor === null ? position[axis] : cursor + previousRadius + gap + radius;
    positions.set(node.id, { ...position, [axis]: cursor });
    previousRadius = radius;
  }
}

/** Lay a column of nodes from a shared starting coordinate, so every column begins level. */
function packColumn(row, axis, start, gap, positions) {
  let cursor = start;
  let previousRadius = 0;
  for (const node of row) {
    const position = positions.get(node.id);
    const radius = nodeDiameter(node) / 2;
    cursor += previousRadius + gap + radius;
    positions.set(node.id, { ...position, [axis]: cursor });
    previousRadius = radius;
  }
}

/**
 * Pack the data hubs into a grid of up to {@link DATA_HUB_COLUMNS} columns beside the stack.
 *
 * `axis` is the stack's own axis and `cross` the direction it faces (the shelf's). A column runs
 * along `cross`, so it stands perpendicular to the stack, and columns repeat along `axis`, so a
 * long list wraps into a compact block instead of one column far longer than the stack. Every
 * column starts level, so the block reads as a grid rather than a staircase. Returns the columns
 * in order along `axis`, each with its `cross` offset, for the caller to place beyond the shelf.
 */
function packDataHubs(hubs, axis, cross, positions) {
  const ordered = [...hubs].sort((a, b) => positions.get(a.id)[axis] - positions.get(b.id)[axis]);
  const start = ordered.length === 0 ? 0 : Math.min(...ordered.map((node) => positions.get(node.id)[cross]));
  const perColumn = Math.max(1, DATA_HUB_ROWS);
  const result = [];
  for (let index = 0; index < ordered.length; index += perColumn) {
    const members = ordered.slice(index, index + perColumn);
    packColumn(members, cross, start, DATA_HUB_GAP, positions);
    result.push(members);
  }
  return result;
}

/**
 * Re-pack the stack and the support shelf by drawn card size.
 *
 * Returns a model with adjusted positions, so the plates, hit-testing, and the drawn nodes
 * all read one geometry; any other model is returned untouched. Packing a packed model is
 * a no-op, since the order and the anchor both survive it.
 */
export function packStructureStack(model) {
  if (!isStructureStack(model)) {
    return model;
  }
  const positions = new Map((model.positions ?? []).map((p) => [p.id, { ...p }]));
  const axis = model.structureDirection === 'horizontal' ? 'x' : 'y';
  const placed = (model.nodes ?? []).filter((node) => positions.has(node.id));
  const bands = placed.filter((node) => node.kind === 'tier');
  const shelf = placed.filter((node) => node.kind === 'shelf');
  // The data-flow reading draws one hub per recorded dataset beside the stack. They are not
  // bands, so pack them into their own columns along the stack axis by drawn size. The server's
  // raw pitch would run them into the shelf and one long column would dwarf the stack.
  const dataHubs = placed.filter((node) => node.kind === 'dataset');
  pack(bands, axis, STACK_GAP, positions);
  pack(shelf, axis, SHELF_GAP, positions);
  // The hub columns run along the facing axis beyond the stack; the caller places each column
  // past the shelf. Pack them here so their drawn sizes set the spacing.
  const crossAxis = axis === 'x' ? 'y' : 'x';
  const hubColumns = packDataHubs(dataHubs, axis, crossAxis, positions);
  const packed = { ...model, positions: [...positions.values()] };
  if (bands.length === 0 || (shelf.length === 0 && dataHubs.length === 0)) {
    return packed;
  }
  // The shelf row sits beside the stack (below it when horizontal, right of it when
  // vertical), clear of the cards, the labels under them, and any arc bowing that way.
  const cross = axis === 'x' ? 'y' : 'x';
  let stackEdge = -Infinity;
  for (const node of bands) {
    const radius = nodeDiameter(node) / 2;
    // Horizontal: the label hangs below the card. Vertical: it sits to the card's right.
    const reach = cross === 'y' ? radius + LABEL_LINE * 4 + LABEL_GAP : radius + LABEL_SIDE_GAP + LABEL_WIDTH;
    stackEdge = Math.max(stackEdge, positions.get(node.id)[cross] + reach);
  }
  const bends = structureEdgeBends(packed, structureStackRank(packed));
  (model.edges ?? []).forEach((edge, index) => {
    const from = positions.get(edge.source);
    const to = positions.get(edge.target);
    if (!bends[index] || !from || !to) return;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    const apex = { x: (from.x + to.x) / 2 + (-dy / length) * (bends[index] / 2), y: (from.y + to.y) / 2 + (dx / length) * (bends[index] / 2) };
    stackEdge = Math.max(stackEdge, apex[cross] + (cross === 'x' ? ARC_LABEL_HALF_WIDTH : ARC_LABEL_ROOM));
  });
  const shelfReach = shelf.length > 0 ? Math.max(...shelf.map((node) => nodeDiameter(node) / 2)) : 0;
  let shelfAt = stackEdge;
  if (shelf.length > 0) {
    shelfAt = stackEdge + SHELF_CLEARANCE + shelfReach;
    for (const node of shelf) {
      positions.set(node.id, { ...positions.get(node.id), [cross]: shelfAt });
    }
  }
  // The data-hub columns sit beyond the shelf, so a write from a band to a hub crosses the
  // shelf rather than landing on it.
  let hubEdge = shelfAt + (shelf.length > 0 ? shelfReach : 0);
  for (const column of hubColumns) {
    const reach = Math.max(...column.map((node) => nodeDiameter(node) / 2));
    const at = hubEdge + DATA_HUB_CLEARANCE + reach;
    for (const node of column) {
      positions.set(node.id, { ...positions.get(node.id), [cross]: at });
    }
    hubEdge = at + reach;
  }
  return { ...model, positions: [...positions.values()] };
}

/**
 * Each Structure grid cell's row, top first: a grid is a vertical stack per build unit, so
 * its edges bow by the same rules, with every cell in a jumped row to clear.
 */
export function structureGridRank(model) {
  const positions = new Map((model.positions ?? []).map((p) => [p.id, p]));
  const cells = (model.nodes ?? []).filter((node) => node.kind === 'tier' && positions.has(node.id));
  const rows = [...new Set(cells.map((node) => positions.get(node.id).y))].sort((a, b) => a - b);
  return new Map(cells.map((node) => [node.id, rows.indexOf(positions.get(node.id).y)]));
}

/** Each stack band's rank along the stack, top (or left) first. */
export function structureStackRank(model) {
  const axis = model.structureDirection === 'horizontal' ? 'x' : 'y';
  const positions = new Map((model.positions ?? []).map((p) => [p.id, p]));
  const bands = (model.nodes ?? []).filter((node) => node.kind === 'tier' && positions.has(node.id));
  bands.sort((a, b) => positions.get(a.id)[axis] - positions.get(b.id)[axis]);
  return new Map(bands.map((node, index) => [node.id, index]));
}

/**
 * The control-point distance each stack edge bows by, indexed like `model.edges`.
 *
 * The distance is signed relative to the edge's own direction (positive bows to the right of
 * travel, on screen), so the two halves of an A⇄B pair, given the same distance, bow to
 * opposite sides. A skip-layer arc bows far enough to clear every card it jumps, and the
 * labels beneath them: its apex sits at half the control distance. Across a horizontal
 * stack, where the labels hang below the cards, a downward skip arcs over the top and an
 * upward one under the labels; down a vertical stack, where the labels sit to the right,
 * every skip arcs round the left.
 *
 * `labelLines` is each card's label line count (see `structureLabelLines`).
 */
export function structureEdgeBends(model, rank, labelLines = new Map()) {
  const edges = model.edges ?? [];
  const pairs = new Set(edges.map((edge) => `${edge.source}\u0000${edge.target}`));
  const horizontal = model.structureDirection === 'horizontal';
  // A rank can hold several cards (a grid row has one per build unit); an arc clears them all.
  const byRank = [];
  for (const node of model.nodes ?? []) {
    const index = rank.get(node.id);
    if (index !== undefined) (byRank[index] ??= []).push(node);
  }
  const labelBlock = (node) => (labelLines.get(node.id) ?? 2) * LABEL_LINE + LABEL_GAP;
  return edges.map((edge) => {
    const from = rank.get(edge.source);
    const to = rank.get(edge.target);
    if (from === undefined || to === undefined) return 0;
    const span = Math.abs(from - to);
    if (span <= 1) {
      return pairs.has(`${edge.target}\u0000${edge.source}`) ? PAIR_BEND : 0;
    }
    const downward = from < to;
    // Horizontal: a downward skip arcs above (negative), an upward one below (negative too,
    // since its travel is reversed) and so has to clear the labels as well.
    const labelSide = horizontal && !downward;
    let clearance = 0;
    for (let index = Math.min(from, to) + 1; index < Math.max(from, to); index += 1) {
      for (const node of byRank[index] ?? []) {
        const radius = nodeDiameter(node) / 2;
        // Down a vertical stack the arc's level label is centred on its apex, so the arc also
        // clears half that label's width.
        const labelRoom = horizontal ? (labelSide ? labelBlock(node) : 0) : ARC_LABEL_HALF_WIDTH;
        clearance = Math.max(clearance, radius + labelRoom);
      }
    }
    const distance = 2 * (clearance + ARC_CLEARANCE) + SKIP_NEST * (span - 2);
    // Positive bows right of travel: down a vertical stack that is left for a downward edge
    // and right for an upward one, so an upward skip is flipped to join the others on the left.
    if (horizontal) return -distance;
    // A grid names its rows down the left and keeps its cell labels inside the cards, so its
    // arcs take the right-hand side instead.
    const left = model.structureLevel !== 'grid';
    return downward === left ? distance : -distance;
  });
}
