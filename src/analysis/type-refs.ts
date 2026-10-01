import type { Graph } from '../types/graph.ts';
import type { MemberMap } from './member-map.ts';

/** How a type name used in a file was tied to the file that declares it. */
export type TypeRefBasis = 'this-file' | 'import' | 'same-folder';

export interface TypeRef {
  /** The repository-relative file that declares the type. */
  file: string;
  basis: TypeRefBasis;
}

/**
 * Tie the type names a file's members use (field types, return types, supertypes) to the
 * file that declares them, so the passport can link `KeyQuality` to its source.
 *
 * Only recorded evidence is used, in this order: a type the file declares itself; a file the
 * file has an edge to whose name is the type name (`import ...KeyQuality`); a file in the
 * same folder whose name is the type name (a same-package reference needs no import in
 * Kotlin, Java, or C#). A name with no such evidence, or with more than one candidate at the
 * first step that has any, is left out rather than guessed.
 */
export function resolveTypeRefs(file: string, memberMap: MemberMap, graph: Graph): Record<string, TypeRef> {
  const used = new Set<string>();
  for (const type of memberMap.types) {
    for (const field of type.fields) if (field.type) used.add(field.type);
    for (const method of type.methods) if (method.type) used.add(method.type);
    for (const superType of type.superTypes ?? []) used.add(superType.name);
  }

  const declaredHere = new Set(memberMap.types.map((type) => type.name.split('.').at(-1) as string));
  const imported = graph.edges.filter((edge) => edge.source === file).map((edge) => edge.target);
  const folder = directoryOf(file);
  const siblings = graph.nodes
    .filter((node) => node.id !== file && directoryOf(node.id) === folder)
    .map((node) => node.id);

  const refs: Record<string, TypeRef> = {};
  for (const name of used) {
    if (declaredHere.has(name)) {
      refs[name] = { file, basis: 'this-file' };
      continue;
    }
    const byImport = unique(imported.filter((target) => stemOf(target) === name));
    if (byImport) {
      refs[name] = { file: byImport, basis: 'import' };
      continue;
    }
    const bySibling = unique(siblings.filter((sibling) => stemOf(sibling) === name));
    if (bySibling) {
      refs[name] = { file: bySibling, basis: 'same-folder' };
    }
  }
  return refs;
}

function unique(candidates: string[]): string | null {
  const distinct = [...new Set(candidates)];
  return distinct.length === 1 ? (distinct[0] as string) : null;
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function stemOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.indexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}
