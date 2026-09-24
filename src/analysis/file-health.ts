import type { CodeSymbol, MemberAccess } from '../scan/languages/symbols.ts';
import type { Graph } from '../types.ts';
import { buildAdjacency, computeGraphMetrics } from './analysis.ts';
import { computeCoverage } from './coverage.ts';
import { computeCycles } from './cycles.ts';
import type { HealthAxis } from './health.ts';
import {
  coverageProvenance,
  formatAge,
  type CoverageProvenance,
  type MeasuredCoverageSummary,
} from './measured-coverage.ts';

export interface FileHealthMetrics {
  directImports: number;
  directImporters: number;
  blastRadius: number;
  /**
   * Outgoing barrel re-exports (`export … from`). They are `declare` edges, so the use-only
   * adjacency leaves them out; they are counted here so a forwarder is not read as a leaf.
   */
  reExports: number;
}

export interface FileHealthReport {
  file: string;
  /** False when the file is not a node in the scanned graph (e.g. an unsupported file). */
  found: boolean;
  score: number | null;
  axes: HealthAxis[];
  metrics: FileHealthMetrics;
  /** The measured report the coverage axis consulted, when one was read. */
  coverage?: CoverageProvenance;
}

/**
 * Architecture health for a single file/class.
 *
 * The graph axes (coupling, fan-out, complexity, coverage) are the repository signals
 * scoped to this file. **Cohesion** is different: it is measured from the member wiring
 * recorded for the file, so a class whose methods share fields scores higher than one whose
 * fields are never touched. Axes the scan cannot derive are `null`, never a fabricated 0;
 * `cohesionUnavailable` states why cohesion does not apply to this file's language.
 */
export function computeFileHealth(
  graph: Graph,
  file: string,
  symbols: CodeSymbol[] = [],
  accesses: MemberAccess[] = [],
  cohesionUnavailable?: string,
  measured?: MeasuredCoverageSummary | null,
): FileHealthReport {
  const { forward, backward } = buildAdjacency(graph);
  // A barrel's `export … from` edges are `declare` edges, so they are absent from the
  // use-only adjacency above. Following them here keeps a forwarder from reading as a leaf
  // with a perfect fan-out; `reExports` is the count the use-only adjacency left out.
  const withReExports = buildAdjacency(graph, { includeReExports: true });
  const metrics = computeGraphMetrics(graph);
  const node = graph.nodes.find((candidate) => candidate.id === file);
  const directImports = (forward.get(file) ?? []).length;
  const directImporters = (backward.get(file) ?? []).length;
  const importsWithReExports = (withReExports.forward.get(file) ?? []).length;
  const reExports = Math.max(0, importsWithReExports - directImports);
  const blastRadius = metrics.transitiveDependents.get(file) ?? 0;

  const axes: HealthAxis[] = [];

  if (node) {
    const connections = importsWithReExports + directImporters;
    axes.push({
      key: 'lowCoupling',
      label: 'Low coupling',
      value: score(1 - normalise(connections, 12)),
      detail: `${connections} connection(s) (${directImports} out, ${directImporters} in${reExports > 0 ? `, ${reExports} re-exported` : ''})`,
    });
    axes.push({
      key: 'lowFanOut',
      label: 'Low fan-out',
      value: score(1 - normalise(importsWithReExports, 10)),
      detail: `${directImports} direct import(s)${reExports > 0 ? ` · ${reExports} re-exported module(s)` : ''}`,
    });
    const cycle = computeCycles(graph).find((group) => group.members.includes(file));
    axes.push({
      key: 'lowComplexity',
      label: 'Low complexity',
      value: cycle ? score(1 - normalise(cycle.members.length, 10)) : 100,
      detail: cycle ? `in a cycle of ${cycle.members.length} files` : 'not in a dependency cycle',
    });
  } else {
    for (const [key, label] of [
      ['lowCoupling', 'Low coupling'],
      ['lowFanOut', 'Low fan-out'],
      ['lowComplexity', 'Low complexity'],
    ] as const) {
      axes.push({ key, label, value: null, detail: 'file is not in the scanned graph' });
    }
  }

  const cohesion = cohesionUnavailable
    ? { value: null, detail: cohesionUnavailable }
    : computeMemberCohesion(symbols, accesses);
  axes.push({ key: 'cohesion', label: 'Cohesion', value: cohesion.value, detail: cohesion.detail });

  axes.push(fileCoverage(graph, file, node, measured));

  const available = axes.filter((axis) => axis.value !== null).map((axis) => axis.value as number);
  return {
    file,
    found: Boolean(node),
    score: available.length > 0 ? Math.round(available.reduce((sum, n) => sum + n, 0) / available.length) : null,
    axes,
    metrics: { directImports, directImporters, blastRadius, reExports },
    ...(measured ? { coverage: coverageProvenance(measured) } : {}),
  };
}

function fileCoverage(
  graph: Graph,
  file: string,
  node: Graph['nodes'][number] | undefined,
  measured?: MeasuredCoverageSummary | null,
): HealthAxis {
  const unavailable = (detail: string): HealthAxis => ({
    key: 'coverage',
    label: 'Coverage',
    value: null,
    detail,
    basis: 'reachable',
  });

  if (!node) {
    return unavailable('file is not in the scanned graph');
  }

  // Measured lines win when the report names this file; a named file with no line counts
  // stays measured-but-unavailable rather than being read as 0%.
  const measuredEntry =
    measured?.available ? measured.files.find((entry) => entry.inGraph && entry.file === file) : undefined;
  if (measuredEntry) {
    const age =
      measured?.reportAgeMs === null || measured?.reportAgeMs === undefined
        ? ''
        : ` · report ${formatAge(measured.reportAgeMs)} old`;
    const stale = measuredEntry.stale ? ' · stale' : '';
    return {
      key: 'coverage',
      label: 'Coverage',
      value: measuredEntry.lineCoverage === null ? null : measuredEntry.lineCoverage,
      detail:
        measuredEntry.lineCoverage === null
          ? `measured: the report records no line counts for this file${age}${stale}`
          : `measured ${measuredEntry.lineCoverage}% of ${measuredEntry.linesFound} line(s)${age}${stale}`,
      basis: 'measured',
    };
  }

  const reach = computeCoverage(graph);
  if (reach.testFiles.length === 0) {
    return unavailable('no test files identified');
  }
  if (node.kind === 'test') {
    return { key: 'coverage', label: 'Coverage', value: 100, detail: 'test file', basis: 'reachable' };
  }
  if (reach.reached.includes(file)) {
    return {
      key: 'coverage',
      label: 'Coverage',
      value: 100,
      detail: `reachable from ${reach.testFiles.length} test file(s)`,
      basis: 'reachable',
    };
  }
  return { key: 'coverage', label: 'Coverage', value: 0, detail: 'no path from a test', basis: 'reachable' };
}

export interface MemberCohesion {
  value: number | null;
  detail: string;
}

/**
 * LCOM-style cohesion from the recorded field wiring.
 *
 * Members are nodes; a method is joined to every field it reads or writes. Cohesion is how
 * close the member graph is to a single component: one component is 100, and every field
 * touched by no method lowers it. With no members at all it is reported unavailable.
 */
export function computeMemberCohesion(symbols: CodeSymbol[], accesses: MemberAccess[]): MemberCohesion {
  const fields = new Set<string>();
  const methods = new Set<string>();
  for (const symbol of symbols) {
    const key = memberKey(symbol.owner, symbol.name);
    if (symbol.kind === 'field' || symbol.kind === 'property') {
      fields.add(key);
    } else if (symbol.kind === 'method') {
      methods.add(key);
    }
  }

  const total = fields.size + methods.size;
  if (total === 0) {
    return { value: null, detail: 'no members recorded' };
  }

  // Cohesion joins methods to the fields they touch. With no methods there is nothing that
  // could wire two fields together, so every field is trivially its own cluster and the LCOM
  // proxy returns 0 — a verdict, not evidence. A data-only type is therefore unavailable,
  // matching the SQL guard in src/api/routes/analysis.ts rather than scoring it as incohesive.
  if (methods.size === 0) {
    return { value: null, detail: `${fields.size} field(s) recorded, but no methods wire them` };
  }

  const adjacency = new Map<string, Set<string>>();
  const ensure = (key: string): Set<string> => {
    const existing = adjacency.get(key);
    if (existing) {
      return existing;
    }
    const created = new Set<string>();
    adjacency.set(key, created);
    return created;
  };
  for (const key of [...fields, ...methods]) {
    ensure(key);
  }
  for (const access of accesses) {
    const method = memberKey(access.owner, access.method);
    const field = memberKey(access.owner, access.field);
    if (!adjacency.has(method) || !adjacency.has(field)) {
      continue;
    }
    adjacency.get(method)?.add(field);
    adjacency.get(field)?.add(method);
  }

  let components = 0;
  const seen = new Set<string>();
  for (const key of adjacency.keys()) {
    if (seen.has(key)) {
      continue;
    }
    components += 1;
    const queue = [key];
    seen.add(key);
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const neighbour of adjacency.get(current) ?? []) {
        if (!seen.has(neighbour)) {
          seen.add(neighbour);
          queue.push(neighbour);
        }
      }
    }
  }

  const value = total === 1 ? 100 : score(1 - (components - 1) / (total - 1));
  return { value, detail: `${components} cluster(s) across ${total} member(s)` };
}

function memberKey(owner: string, name: string): string {
  return `${owner}\u0000${name}`;
}

function normalise(value: number, ceiling: number): number {
  return Math.min(1, Math.max(0, value / ceiling));
}

function score(fraction: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}
