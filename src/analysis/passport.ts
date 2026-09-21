import type { Graph } from '../types.ts';
import { buildAdjacency, computeGraphMetrics } from './analysis.ts';
import { computeCoverage } from './coverage.ts';
import { computeCycles } from './cycles.ts';

/** A language and how many scanned source files carry it. */
export interface PassportLanguage {
  language: string;
  files: number;
}

/** A source file and the dependency reach recorded for it. */
export interface PassportTopFile {
  id: string;
  kind: string;
  fanIn: number;
  fanOut: number;
  transitiveDependents: number;
  transitiveDependencies: number;
}

/** A top-level directory roll-up; the coarsest layering the scan can state. */
export interface PassportLayer {
  directory: string;
  files: number;
  /** Direct importers of files in this layer, summed. */
  incoming: number;
}

export interface PassportEntryPoint {
  file: string;
  reason: string;
}

export interface PassportCycle {
  id: string;
  size: number;
  members: string[];
}

/**
 * The opening summary of a repository: what it is made of and where to start.
 *
 * Every field is derived from the recorded graph and the scan's extension counts; nothing
 * is inferred beyond what the scan resolved. A section with no evidence (no entry point,
 * no cycle, no unreached module) reports empty rather than a fabricated value.
 */
export interface RepositoryPassport {
  repository: string;
  size: {
    files: number;
    edges: number;
    directories: number;
    tests: number;
    diagnostics: number;
    excluded: number;
  };
  languages: PassportLanguage[];
  entryPoints: PassportEntryPoint[];
  layers: PassportLayer[];
  topFiles: PassportTopFile[];
  cycles: { total: number; largest: PassportCycle[] };
  untested: { total: number; files: string[] };
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript (TSX)',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript (JSX)',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.kts': 'Kotlin',
  '.cs': 'C#',
  '.rs': 'Rust',
  '.py': 'Python',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.cxx': 'C++',
  '.hpp': 'C++',
  '.hh': 'C++',
  '.hxx': 'C++',
  '.h': 'C++',
  '.sql': 'SQL',
};

/**
 * Build the repository passport.
 *
 * `extensionCounts` comes from the scan report, so language totals reflect the same file
 * set as the graph rather than a second walk of the filesystem.
 */
export function computeRepositoryPassport(
  repository: string,
  graph: Graph,
  extensionCounts: Record<string, number> = {},
  limit = 10,
): RepositoryPassport {
  const metrics = computeGraphMetrics(graph, buildAdjacency(graph));
  const nodes = graph.nodes;

  const languages = Object.entries(extensionCounts)
    .map(([extension, files]) => ({
      language: LANGUAGE_BY_EXTENSION[extension] ?? extension,
      files,
    }))
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language));

  const entryPoints = nodes
    .filter((node) => node.kind === 'entry')
    .map((node) => ({ file: node.id, reason: node.entryReason ?? 'declared by a manifest' }))
    .sort((a, b) => a.file.localeCompare(b.file));

  const layers = layerRollup(nodes, metrics.fanIn);

  const topFiles = [...nodes]
    .map((node) => ({
      id: node.id,
      kind: node.kind,
      fanIn: metrics.fanIn.get(node.id) ?? 0,
      fanOut: metrics.fanOut.get(node.id) ?? 0,
      transitiveDependents: metrics.transitiveDependents.get(node.id) ?? 0,
      transitiveDependencies: metrics.transitiveDependencies.get(node.id) ?? 0,
    }))
    // Fan-in is the direct question "how many files import this"; transitive dependents
    // break ties so a file that decides a larger area ranks first.
    .sort(
      (a, b) =>
        b.fanIn - a.fanIn ||
        b.transitiveDependents - a.transitiveDependents ||
        a.id.localeCompare(b.id),
    )
    .slice(0, limit);

  const cycles = computeCycles(graph);
  const largest = [...cycles]
    .sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id))
    .slice(0, 5)
    .map((group) => ({ id: group.id, size: group.members.length, members: group.members.slice(0, 12) }));

  const coverage = computeCoverage(graph);

  return {
    repository,
    size: {
      files: nodes.length,
      edges: graph.edges.length,
      directories: new Set(nodes.map((node) => node.directory)).size,
      tests: nodes.filter((node) => node.kind === 'test').length,
      diagnostics: graph.diagnostics.length,
      excluded: graph.excluded.length,
    },
    languages,
    entryPoints,
    layers,
    topFiles,
    cycles: { total: cycles.length, largest },
    untested: {
      total: coverage.unreachedWithDependents.length,
      files: coverage.unreachedWithDependents.slice(0, limit),
    },
  };
}

/** Roll files up to their top-level directory and sum their incoming direct importers. */
function layerRollup(
  nodes: Graph['nodes'],
  fanIn: Map<string, number>,
): PassportLayer[] {
  const byDirectory = new Map<string, { files: number; incoming: number }>();
  for (const node of nodes) {
    const directory = node.id.includes('/') ? node.id.slice(0, node.id.indexOf('/')) : '.';
    const entry = byDirectory.get(directory) ?? { files: 0, incoming: 0 };
    entry.files += 1;
    entry.incoming += fanIn.get(node.id) ?? 0;
    byDirectory.set(directory, entry);
  }
  return [...byDirectory.entries()]
    .map(([directory, entry]) => ({ directory, ...entry }))
    .sort((a, b) => b.files - a.files || a.directory.localeCompare(b.directory));
}
