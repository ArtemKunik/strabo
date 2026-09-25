import type { Graph } from '../types.ts';
import { buildAdjacency, computeGraphMetrics, relationshipOf } from './analysis.ts';
import { computeCycles } from './cycles.ts';
import { fileCoverage, UNDER_COVERED_THRESHOLD } from './file-coverage.ts';
import type { MeasuredCoverageSummary } from './measured-coverage.ts';

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
  /**
   * Outgoing `declare` edges (barrel re-exports, Rust `mod`, `__init__` re-exports).
   * These are left out of adjacency so they never inflate blast radius, but the count
   * is reported so a barrel file reads as a forwarder rather than a "0 fan-out" leaf.
   */
  reExports: number;
  transitiveDependents: number;
  transitiveDependencies: number;
}

/**
 * A top-level directory roll-up; the coarsest grouping the scan can state.
 *
 * Named `topDirectories` rather than `layers` on purpose: the System view already uses
 * "layer" for depth-derived tiers inside a unit, and sharing the name confused the two.
 */
export interface PassportTopDirectory {
  directory: string;
  files: number;
  /** Direct importers of files in this directory, summed. */
  incoming: number;
}

/** Deprecated alias of {@link PassportTopDirectory}, kept for API compatibility. */
export type PassportLayer = PassportTopDirectory;

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
  topDirectories: PassportTopDirectory[];
  topFiles: PassportTopFile[];
  cycles: { total: number; largest: PassportCycle[] };
  untested: PassportUntested;
}

/** A used file's measured figure, as the passport lists it. */
export interface PassportCoverageFigure {
  file: string;
  value: number | null;
  stale: boolean | null;
}

/**
 * Used files (something imports them) that tests leave uncovered. With a measured report
 * that is "used and under `threshold`% measured", lowest first; without one it is "used but
 * no test reaches", by reachability. `basis` says which, so the two are never mixed.
 */
export interface PassportUntested {
  basis: 'measured' | 'reachable';
  /** Measured line-coverage percent a used file must reach; null on the reachable basis. */
  threshold: number | null;
  total: number;
  files: string[];
  /** Each listed file's figure, in `files` order; `value` is null on the reachable basis. */
  figures: PassportCoverageFigure[];
  /** Used files the measured report does not name: `not in report`, never counted as 0%. */
  notInReport: number;
}

/** A used file under this measured line coverage is listed as untested. */
export const PASSPORT_COVERAGE_THRESHOLD = UNDER_COVERED_THRESHOLD;

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
  measured: MeasuredCoverageSummary | null = null,
): RepositoryPassport {
  const adjacency = buildAdjacency(graph);
  const metrics = computeGraphMetrics(graph, adjacency);
  const nodes = graph.nodes;

  // Several extensions share one display language (`.js`/`.mjs`/`.cjs` are all
  // JavaScript), so totals are summed per language rather than per extension.
  const filesByLanguage = new Map<string, number>();
  for (const [extension, files] of Object.entries(extensionCounts)) {
    const language = LANGUAGE_BY_EXTENSION[extension] ?? extension;
    filesByLanguage.set(language, (filesByLanguage.get(language) ?? 0) + files);
  }
  const languages = [...filesByLanguage.entries()]
    .map(([language, files]) => ({ language, files }))
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language));

  const entryPoints = nodes
    .filter((node) => node.kind === 'entry')
    .map((node) => ({ file: node.id, reason: node.entryReason ?? 'declared by a manifest' }))
    .sort((a, b) => a.file.localeCompare(b.file));

  const layers = layerRollup(nodes, metrics.fanIn);

  const reExportsByFile = new Map<string, number>();
  for (const edge of graph.edges) {
    if (relationshipOf(edge) === 're-export' && edge.source !== edge.target) {
      reExportsByFile.set(edge.source, (reExportsByFile.get(edge.source) ?? 0) + 1);
    }
  }

  const topFiles = [...nodes]
    .map((node) => ({
      id: node.id,
      kind: node.kind,
      fanIn: metrics.fanIn.get(node.id) ?? 0,
      fanOut: metrics.fanOut.get(node.id) ?? 0,
      reExports: reExportsByFile.get(node.id) ?? 0,
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

  const untested = computeUntested(graph, measured, limit, adjacency.backward);

  return {
    repository,
    size: {
      files: nodes.length,
      // Call edges are a separate lens that parallels the import graph; the headline count
      // stays module coupling, matching what the map draws by default.
      edges: graph.edges.filter((edge) => edge.kind !== 'call').length,
      directories: new Set(nodes.map((node) => node.directory)).size,
      tests: nodes.filter((node) => node.kind === 'test').length,
      diagnostics: graph.diagnostics.length,
      excluded: graph.excluded.length,
    },
    languages,
    entryPoints,
    topDirectories: layers,
    topFiles,
    cycles: { total: cycles.length, largest },
    untested,
  };
}

/**
 * Used files that tests leave uncovered, on the measured basis when a report was read and on
 * reachability otherwise. Shared by the passport and the repository report.
 */
export function computeUntested(
  graph: Graph,
  measured: MeasuredCoverageSummary | null,
  limit: number,
  backward: Map<string, string[]> = buildAdjacency(graph).backward,
): PassportUntested {
  const coverage = fileCoverage(graph, measured);
  // Used: something depends on it. An unreached file with no dependents is an orphan, not
  // an untested dependency, and a test file is the test.
  const used = graph.nodes
    .filter((node) => node.kind !== 'test' && (backward.get(node.id) ?? []).length > 0)
    .map((node) => node.id);

  if (!measured?.available) {
    const files = used.filter((file) => !coverage.get(file)?.reached).sort();
    return {
      basis: 'reachable',
      threshold: null,
      total: files.length,
      files: files.slice(0, limit),
      figures: files.slice(0, limit).map((file) => ({ file, value: null, stale: null })),
      notInReport: 0,
    };
  }

  const figures: PassportCoverageFigure[] = [];
  let notInReport = 0;
  for (const file of used) {
    const figure = coverage.get(file);
    if (!figure || figure.notInReport) {
      notInReport += 1;
    } else if (figure.value !== null && figure.value < PASSPORT_COVERAGE_THRESHOLD) {
      figures.push({ file, value: figure.value, stale: figure.stale });
    }
  }
  figures.sort((a, b) => (a.value ?? 0) - (b.value ?? 0) || a.file.localeCompare(b.file));
  const listed = figures.slice(0, limit);
  return {
    basis: 'measured',
    threshold: PASSPORT_COVERAGE_THRESHOLD,
    total: figures.length,
    files: listed.map((figure) => figure.file),
    figures: listed,
    notInReport,
  };
}

/** Roll files up to their top-level directory and sum their incoming direct importers. */
function layerRollup(
  nodes: Graph['nodes'],
  fanIn: Map<string, number>,
): PassportTopDirectory[] {
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
