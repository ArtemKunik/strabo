import type { ClassificationTag, LineageEdge } from '../../types.ts';

export interface ClassificationInput {
  /** Tags stated by a declaration (a descriptor, a catalog, or a column comment). */
  declared: readonly ClassificationTag[];
  lineage: readonly LineageEdge[];
}

/**
 * Propagate a declared classification along recorded `derives` edges (J14).
 *
 * A propagated tag is labelled `derived` and carries the full path of evidence lines, so it is
 * never mistaken for a declaration. Propagation follows only a plain column mapping; at an edge
 * whose column mapping was not read it stops, because a transformation the scan did not read
 * could combine, rename, or drop the column.
 */
export function propagateClassification(input: ClassificationInput): ClassificationTag[] {
  const outgoing = new Map<string, LineageEdge[]>();
  for (const edge of input.lineage) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge);
    outgoing.set(edge.source, list);
  }

  const derived: ClassificationTag[] = [];
  const seen = new Set<string>();
  const queue: ClassificationTag[] = input.declared.map((tag) => ({ ...tag }));
  while (queue.length > 0) {
    const tag = queue.shift() as ClassificationTag;
    for (const edge of outgoing.get(tag.dataset) ?? []) {
      if (!edge.columns || edge.columns.length === 0) {
        continue; // transformation not read: propagation stops here.
      }
      const mapping = tag.field === null
        ? edge.columns[0]
        : edge.columns.find((column) => column.source === tag.field);
      if (!mapping || mapping.transformation) {
        continue;
      }
      const key = `${edge.target}\u0000${mapping.target}\u0000${tag.tag}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const next: ClassificationTag = {
        dataset: edge.target,
        field: mapping.target,
        tag: tag.tag,
        source: 'derived',
        path: [
          ...tag.path,
          { dataset: edge.target, file: edge.evidence.file, line: edge.evidence.line, detail: edge.detail },
        ],
      };
      derived.push(next);
      queue.push(next);
    }
  }
  return derived.sort(
    (a, b) => a.dataset.localeCompare(b.dataset) || (a.field ?? '').localeCompare(b.field ?? '') || a.tag.localeCompare(b.tag),
  );
}
