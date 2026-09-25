/**
 * Stable ids for the Strabo graph: a deterministic string hash (layout seeds) and the
 * top-level directory a path id belongs to.
 *
 * Pure functions only: no DOM, no Cytoscape, no fetch.
 */

export function hash(value) {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(result);
}

/** The first path segment, or `.` for a file at the repository root. */
export function topLevelDirectory(id) {
  const value = String(id ?? '');
  const slash = value.indexOf('/');
  return slash === -1 ? '.' : value.slice(0, slash);
}
