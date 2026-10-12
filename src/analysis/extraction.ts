import type { Graph, GraphEdge } from '../types.ts';
import { buildAdjacency, relationshipOf } from './analysis.ts';
import { computeCycles } from './cycles.ts';
import { matchesGlob } from './glob.ts';
import type { StringEdgeReport, StringEdgeSite } from './string-edges.ts';

/**
 * The extraction planner: what pulling a set of files out into its own package would have to
 * take along, and which recorded edges would have to be cut.
 *
 * Read only from recorded facts: import and re-export edges (a `call` parallels an import and a
 * module declaration describes the tree, so neither counts), the string edges of env vars,
 * routes, and flags, and the external packages the files import. The planner names the cost of
 * each choice; it does not choose. Data contracts and runtime coupling are not covered.
 */

export interface ExtractionEvidence {
  source: string;
  target: string;
  line: number;
  specifier: string;
}

/** A file outside the selection that selected files import. */
export interface ExtractionDependency {
  file: string;
  /** Selected files that import it directly. */
  importedBy: string[];
  edges: number;
  /** Further files outside the selection its own imports would drag along. */
  pulls: number;
  /** Files outside the selection that also import it, so taking it along means sharing it. */
  usedOutside: number;
  /** True when every import of it is type-only: erased at compile time, so cheap to cut. */
  typeOnly: boolean;
  evidence: ExtractionEvidence[];
}

/** A selected file that code staying behind imports. */
export interface ExtractionDependent {
  file: string;
  /** Files outside the selection that import it directly. */
  importers: string[];
  edges: number;
  evidence: ExtractionEvidence[];
}

export interface ExtractionStringCrossing {
  kind: 'env' | 'route' | 'flag';
  key: string;
  inside: StringEdgeSite[];
  outside: StringEdgeSite[];
}

export interface ExtractionPackage {
  package: string;
  ecosystem: string;
  files: string[];
}

export interface ExtractionPlan {
  include: string[];
  /** Patterns that matched no scanned file, so a typo is visible. */
  unmatched: string[];
  files: string[];
  /** Outward dependencies: cut each, or take it along. Most-used first. */
  dependencies: ExtractionDependency[];
  /** Inward dependents: each is an import the remaining code must repoint. Most importers first. */
  dependents: ExtractionDependent[];
  /** Every file outside the selection its imports reach transitively: the take-everything cost. */
  closure: string[];
  /** Recorded cycles with members on both sides: no cut of one edge separates them cleanly. */
  boundaryCycles: Array<{ id: string; inside: string[]; outside: string[] }>;
  stringCrossings: ExtractionStringCrossing[];
  /** The external packages the selection imports: what its own manifest would declare. */
  externalPackages: ExtractionPackage[];
  stringEdges: { available: boolean; reason?: string };
  summary: {
    files: number;
    dependencies: number;
    dependents: number;
    closure: number;
    boundaryCycles: number;
    stringCrossings: number;
    externalPackages: number;
    /** True when the selection imports nothing outside itself. */
    selfContained: boolean;
  };
  notCovered: string[];
}

/** Evidence lines kept per row; the edge count still counts every one. */
export const EXTRACTION_EVIDENCE_LIMIT = 5;

const GLOB_CHARACTERS = /[*?]/;

/**
 * Plan extracting the files `include` selects. A pattern without glob characters that names
 * no scanned file is read as a directory, so `src/words` means `src/words/**`.
 */
export function planExtraction(
  graph: Graph,
  include: readonly string[],
  options: { stringEdges?: StringEdgeReport | null } = {},
): ExtractionPlan {
  const ids = graph.nodes.map((node) => node.id);
  const nodeIds = new Set(ids);
  const patterns = include.map(normalise).filter(Boolean);
  const globs = patterns.map((pattern) =>
    GLOB_CHARACTERS.test(pattern) || nodeIds.has(pattern) ? pattern : `${pattern}/**`,
  );
  const unmatched = patterns.filter((_, index) => !ids.some((id) => matchesGlob(id, globs[index] as string)));
  const inside = new Set(ids.filter((id) => globs.some((glob) => matchesGlob(id, glob))));

  const crossing = graph.edges.filter(isDependencyEdge);
  const outward = new Map<string, GraphEdge[]>();
  const inward = new Map<string, GraphEdge[]>();
  const importersOutside = new Map<string, Set<string>>();
  for (const edge of crossing) {
    const fromInside = inside.has(edge.source);
    const toInside = inside.has(edge.target);
    if (fromInside && !toInside) {
      push(outward, edge.target, edge);
    } else if (!fromInside && toInside) {
      push(inward, edge.target, edge);
    } else if (!fromInside && !toInside) {
      const set = importersOutside.get(edge.target) ?? new Set<string>();
      set.add(edge.source);
      importersOutside.set(edge.target, set);
    }
  }

  const { forward } = buildAdjacency(graph, { includeReExports: true });
  const closure = reachOutside([...inside], forward, inside);

  const dependencies: ExtractionDependency[] = [...outward].map(([file, edges]) => ({
    file,
    importedBy: distinct(edges.map((edge) => edge.source)),
    edges: edges.length,
    pulls: reachOutside([file], forward, inside).filter((id) => id !== file).length,
    usedOutside: importersOutside.get(file)?.size ?? 0,
    typeOnly: edges.every((edge) => edge.typeOnly === true),
    evidence: evidenceOf(edges),
  }));
  dependencies.sort(
    (a, b) => b.importedBy.length - a.importedBy.length || b.edges - a.edges || a.file.localeCompare(b.file),
  );

  const dependents: ExtractionDependent[] = [...inward].map(([file, edges]) => ({
    file,
    importers: distinct(edges.map((edge) => edge.source)),
    edges: edges.length,
    evidence: evidenceOf(edges),
  }));
  dependents.sort(
    (a, b) => b.importers.length - a.importers.length || b.edges - a.edges || a.file.localeCompare(b.file),
  );

  const boundaryCycles = computeCycles(graph)
    .map((cycle) => ({
      id: cycle.id,
      inside: cycle.members.filter((member) => inside.has(member)),
      outside: cycle.members.filter((member) => !inside.has(member)),
    }))
    .filter((cycle) => cycle.inside.length > 0 && cycle.outside.length > 0);

  const stringEdges = options.stringEdges ?? null;
  const stringCrossings: ExtractionStringCrossing[] = [];
  if (stringEdges?.available) {
    for (const edge of [...stringEdges.env, ...stringEdges.routes, ...stringEdges.flags]) {
      const sites = [...edge.readers, ...edge.declarations];
      const insideSites = sites.filter((site) => inside.has(site.file));
      const outsideSites = sites.filter((site) => !inside.has(site.file) && nodeIds.has(site.file));
      if (insideSites.length > 0 && outsideSites.length > 0) {
        stringCrossings.push({ kind: edge.kind, key: edge.key, inside: insideSites, outside: outsideSites });
      }
    }
    stringCrossings.sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
  }

  const packages = new Map<string, ExtractionPackage>();
  for (const entry of graph.externalImports ?? []) {
    if (!inside.has(entry.file)) continue;
    const key = `${entry.ecosystem}\u0000${entry.package}`;
    const found = packages.get(key) ?? { package: entry.package, ecosystem: entry.ecosystem, files: [] };
    if (!found.files.includes(entry.file)) found.files.push(entry.file);
    packages.set(key, found);
  }
  const externalPackages = [...packages.values()]
    .map((entry) => ({ ...entry, files: entry.files.sort() }))
    .sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.package.localeCompare(b.package));

  return {
    include: patterns,
    unmatched,
    files: [...inside].sort(),
    dependencies,
    dependents,
    closure,
    boundaryCycles,
    stringCrossings,
    externalPackages,
    stringEdges: stringEdges
      ? { available: stringEdges.available, ...(stringEdges.reason ? { reason: stringEdges.reason } : {}) }
      : { available: false, reason: 'string edges were not read' },
    summary: {
      files: inside.size,
      dependencies: dependencies.length,
      dependents: dependents.length,
      closure: closure.length,
      boundaryCycles: boundaryCycles.length,
      stringCrossings: stringCrossings.length,
      externalPackages: externalPackages.length,
      selfContained: dependencies.length === 0,
    },
    notCovered: [
      'data contracts and shared schemas',
      'runtime coupling (reflection, dependency injection, dynamic imports by computed name)',
      'files beyond the scan, such as build scripts and configuration',
    ],
  };
}

/** Recorded imports and re-exports between two different files. */
function isDependencyEdge(edge: GraphEdge): boolean {
  if (edge.kind === 'call' || edge.source === edge.target) return false;
  const relationship = relationshipOf(edge);
  return relationship === 'import' || relationship === 're-export';
}

/** Files outside `inside` reachable from `start` without passing back through the selection. */
function reachOutside(start: readonly string[], forward: Map<string, string[]>, inside: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const stack = start.flatMap((id) => (inside.has(id) ? (forward.get(id) ?? []) : [id]));
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (inside.has(next) || seen.has(next)) continue;
    seen.add(next);
    stack.push(...(forward.get(next) ?? []));
  }
  return [...seen].sort();
}

function evidenceOf(edges: readonly GraphEdge[]): ExtractionEvidence[] {
  return [...edges]
    .sort((a, b) => a.source.localeCompare(b.source) || a.evidence.line - b.evidence.line)
    .slice(0, EXTRACTION_EVIDENCE_LIMIT)
    .map((edge) => ({
      source: edge.source,
      target: edge.target,
      line: edge.evidence.line,
      specifier: edge.evidence.specifier,
    }));
}

function push(map: Map<string, GraphEdge[]>, key: string, edge: GraphEdge): void {
  const list = map.get(key);
  if (list) list.push(edge);
  else map.set(key, [edge]);
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function normalise(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}
