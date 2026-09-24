/**
 * How big the Strabo graph draws things: node diameters by blast radius, lines of code, or
 * file count, and edge stroke width by recorded weight.
 *
 * Pure functions only: no DOM, no Cytoscape, no fetch.
 */

export const MIN_DIAMETER = 22;
export const MAX_DIAMETER = 62;

/** The large-file lens sizes a file by lines of code; its own ceiling sits above the default. */
export const MAX_LOC_DIAMETER = 74;

/** A System-view unit is a card, not a file dot: bigger floor and ceiling, square-root size. */
export const MIN_UNIT_DIAMETER = 48;
export const MAX_UNIT_DIAMETER = 130;
export const MIN_SHELF_DIAMETER = 26;
export const MAX_SHELF_DIAMETER = 64;

/** Square-root transform keeps leaf nodes visible without one hub consuming the map. */
export function diameter(transitiveDependents) {
  const scaled = Math.sqrt(Math.max(0, transitiveDependents ?? 0)) * 6 + MIN_DIAMETER;
  return Math.max(MIN_DIAMETER, Math.min(MAX_DIAMETER, Math.round(scaled)));
}

/**
 * The diameter a file draws at under the large-file lens: area grows with lines of code.
 *
 * The default map sizes a node by blast radius; the lens swaps in this so a big file is a
 * big dot. Square-root, like the default, so a few very large files do not swamp the map.
 */
export function locDiameter(lines) {
  const scaled = Math.sqrt(Math.max(0, lines ?? 0)) * 2.4 + MIN_DIAMETER;
  return Math.max(MIN_DIAMETER, Math.min(MAX_LOC_DIAMETER, Math.round(scaled)));
}

/**
 * Stroke width for an edge, widening with the recorded import count.
 *
 * A System-view edge rolls many file imports into one unit pair, so the count is the
 * weight: one import is the base hairline and each doubling adds a step, capped so a
 * heavily-coupled pair cannot draw a bar across the map. A file edge has no weight and
 * stays the base hairline.
 */
export function edgeStrokeWidth(weight) {
  const count = Number.isFinite(weight) && weight > 0 ? weight : 1;
  return Math.min(4, 1.2 + Math.log2(count) * 0.9);
}

/** A unit's area grows with its file count on a square-root scale, with a floor (L18). */
export function unitDiameter(files) {
  const scaled = Math.sqrt(Math.max(0, files ?? 0)) * 7 + MIN_UNIT_DIAMETER;
  return Math.max(MIN_UNIT_DIAMETER, Math.min(MAX_UNIT_DIAMETER, Math.round(scaled)));
}

/** A shelf tag is deliberately smaller than its unit: it is a footnote, not a component. */
export function shelfDiameter(files) {
  const scaled = Math.sqrt(Math.max(0, files ?? 0)) * 8 + MIN_SHELF_DIAMETER;
  return Math.max(MIN_SHELF_DIAMETER, Math.min(MAX_SHELF_DIAMETER, Math.round(scaled)));
}

/** The diameter a node draws at: a unit/shelf by file count, a file by blast radius. */
export function nodeDiameter(node) {
  if (node?.kind === 'unit') return unitDiameter(node.files ?? node.size);
  if (node?.kind === 'shelf') return shelfDiameter(node.files);
  return diameter(node?.size ?? node?.files ?? node?.transitiveDependents);
}
