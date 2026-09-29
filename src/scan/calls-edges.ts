import type { GraphEdge } from '../types.ts';
import { resolveAliased, type AliasTables } from '../resolve/aliases.ts';
import { resolveRelative, type ResolvedReference } from '../resolve/index.ts';
import type { FileFacts } from './calls-facts.ts';

export function resolveCalls(
  facts: Map<string, FileFacts>,
  fileSet: ReadonlySet<string>,
  tables: AliasTables | null,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const [file, fact] of facts) {
    for (const call of fact.calls) {
      const binding = call.receiver ? fact.imports.get(call.receiver) : fact.imports.get(call.name);
      if (!binding) {
        continue;
      }
      if (call.receiver) {
        // A member call only proves a cross-file target through a namespace import.
        if (binding.kind !== 'namespace') {
          continue;
        }
      } else if (binding.kind === 'namespace') {
        // A namespace object is not itself callable.
        continue;
      }
      const resolved = resolveSource(binding.source, call.line, file, fileSet, tables);
      if (!resolved) {
        continue;
      }
      const exportedName = binding.kind === 'namespace' ? call.name : binding.imported;
      if (!facts.get(resolved.target)?.callableExports.has(exportedName)) {
        continue;
      }
      const key = `${file}\u0000${resolved.target}\u0000${call.line}\u0000${call.specifier}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      edges.push({
        source: file,
        target: resolved.target,
        kind: 'call',
        role: 'use',
        evidence: {
          line: call.line,
          specifier: call.specifier,
          resolution: resolved.evidence.resolution,
        },
      });
    }
  }

  return edges;
}

/**
 * Record cross-file `extends`/`implements` edges for JS/TS.
 *
 * A class or interface names a supertype by simple name; the edge is drawn only when that
 * name is an import (value or type-only) whose specifier resolves inside the repository and
 * whose target file actually exports a type of that name. A default import matches a
 * default-exported type. A supertype declared in the same file, a qualified name, and a name
 * that does not resolve are left unclaimed rather than guessed.
 */
export function resolveInheritance(
  facts: Map<string, FileFacts>,
  fileSet: ReadonlySet<string>,
  tables: AliasTables | null,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const [file, fact] of facts) {
    for (const supertype of fact.supertypes) {
      const binding = fact.imports.get(supertype.name) ?? fact.typeImports.get(supertype.name);
      if (!binding) {
        continue;
      }
      const resolved = resolveSource(binding.source, supertype.line, file, fileSet, tables);
      if (!resolved || resolved.target === file) {
        continue;
      }
      const target = facts.get(resolved.target);
      if (!target) {
        continue;
      }
      const exportedName = binding.kind === 'default' ? 'default' : binding.imported;
      const declared =
        exportedName === 'default' ? target.defaultType : target.typeExports.has(exportedName);
      if (!declared) {
        continue;
      }
      const key = `${file}\u0000${resolved.target}\u0000${supertype.relation}\u0000${supertype.name}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      edges.push({
        source: file,
        target: resolved.target,
        kind: 'inheritance',
        role: 'use',
        relationship: 'inheritance',
        evidence: {
          line: supertype.line,
          specifier: `${supertype.relation} ${supertype.name}`,
          resolution: resolved.evidence.resolution,
        },
      });
    }
  }

  return edges;
}

/** Resolve an import specifier to an internal file through the same rules import edges use. */
function resolveSource(
  specifier: string,
  line: number,
  from: string,
  files: ReadonlySet<string>,
  tables: AliasTables | null,
): ResolvedReference | null {
  if (specifier.startsWith('.')) {
    return resolveRelative(specifier, line, { from, files });
  }
  return tables ? resolveAliased(specifier, line, from, files, tables).resolved : null;
}
