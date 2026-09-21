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

/** The parent directory, or `.` for a top-level path. */
export function parentDirectory(id: string): string {
  const index = id.lastIndexOf('/');
  return index === -1 ? '.' : id.slice(0, index);
}

/** Every directory an id sits in, from its own directory up to `.`. */
export function directoriesOf(files: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    let directory = parentDirectory(file);
    while (true) {
      directories.add(directory);
      if (directory === '.') {
        break;
      }
      directory = parentDirectory(directory);
    }
  }
  return [...directories].sort();
}

/** A build unit's anchor: the directory root and the name its manifest declares. */
export interface UnitAnchor {
  id: string;
  name: string;
}

/** `unit › tail`, or just the unit when the directory is the unit root. */
export function unitAnchoredLabel(tail: string, unitName: string): string {
  return tail === '' ? unitName : `${unitName} › ${tail}`;
}

/**
 * Compress single-child directory chains and anchor a label at its unit root.
 *
 * A directory segment is dropped only when its parent holds exactly one child directory and
 * no content of its own: `service-rust/src/handlers` where `src` is an empty hop reads as
 * `service-rust/handlers`, and with a `service-rust` unit as `service › handlers`. A segment
 * that branches (several children) or holds content is kept, because it is where the tree
 * actually tells you something. The unit root is never dropped.
 */
export function compressDirectoryChains(
  directories: readonly string[],
  isContent: (directory: string) => boolean,
  units: readonly UnitAnchor[] = [],
): Map<string, string> {
  const set = new Set(directories);
  const childCount = new Map<string, number>();
  for (const directory of set) {
    const parent = parentDirectory(directory);
    if (parent !== directory) {
      childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
    }
  }

  const anchors = units
    .filter((unit) => unit.id !== '.')
    .sort((a, b) => b.id.length - a.id.length);

  const labels = new Map<string, string>();
  for (const directory of set) {
    const unit = anchors.find(
      (anchor) => directory === anchor.id || directory.startsWith(`${anchor.id}/`),
    );
    const prefix = unit ? unit.id : directory.split('/')[0] ?? '';
    const relative = unit
      ? directory === unit.id
        ? []
        : directory.slice(unit.id.length + 1).split('/')
      : directory.split('/').slice(1);

    const kept: string[] = [];
    let path = unit ? unit.id : prefix;
    for (const [index, segment] of relative.entries()) {
      path = path === '' ? segment : `${path}/${segment}`;
      const last = index === relative.length - 1;
      if (last || isContent(path) || (childCount.get(path) ?? 0) > 1) {
        kept.push(segment);
      }
    }

    const tail = kept.join('/');
    const label = unit ? unitAnchoredLabel(tail, unit.name) : tail === '' ? prefix : `${prefix}/${tail}`;
    labels.set(directory, label);
  }
  return labels;
}
