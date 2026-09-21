/**
 * Top-level directory identity for the map.
 *
 * Directory is a many-valued category, so it is carried by position (the islands the
 * layout already groups), not by hue. These helpers only name the region a node or block
 * belongs to; the client no longer colours by it.
 */

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
