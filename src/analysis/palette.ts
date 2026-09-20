/**
 * Server-side palette assignment for the map.
 *
 * Colour encodes the top-level directory, but the client cannot derive that from a block
 * id: a block's id is already a directory with no file name, so the client's
 * `topLevelDirectory` fallback collapses every block to the root marker and paints the
 * whole map one colour. The directories are known here, where nodes are grouped, so the
 * index is assigned here and the client only maps it to a theme colour.
 *
 * The index is the rank of the node's region among the sorted unique regions. Sorting
 * makes it deterministic for a given node set, and distinct regions stay distinct until
 * the palette wraps (`PALETTE_SIZE`, the length of the client's `PALETTE`), which a hash
 * cannot promise.
 */

/** Number of colours in the client palette (`ui/strabo-graph.js`). */
export const PALETTE_SIZE = 7;

/** Assign a palette index to every node from its region, wrapping at `PALETTE_SIZE`. */
export function assignPaletteIndexes(regionByNodeId: ReadonlyMap<string, string>): Map<string, number> {
  const regions = [...new Set(regionByNodeId.values())].sort();
  const rank = new Map(regions.map((region, index) => [region, index]));
  const indexes = new Map<string, number>();
  for (const [id, region] of regionByNodeId) {
    indexes.set(id, (rank.get(region) ?? 0) % PALETTE_SIZE);
  }
  return indexes;
}

/** The first path segment, or `.` for a file at the repository root. */
export function topLevelDirectory(id: string): string {
  const slash = id.indexOf('/');
  return slash === -1 ? '.' : id.slice(0, slash);
}

/**
 * The region of a block: the directory the block *is*, or its first segment.
 *
 * A block id is a bare directory name with no file part, so unlike a file id it is its own
 * top-level directory when it has no slash (`ui` is the top-level `ui`, not the root).
 */
export function blockRegion(id: string): string {
  if (id === '.') {
    return '.';
  }
  const slash = id.indexOf('/');
  return slash === -1 ? id : id.slice(0, slash);
}
