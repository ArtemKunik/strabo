import type { Graph } from '../types.ts';
import { buildAdjacency } from './analysis.ts';
import { computeCoverage } from './coverage.ts';
import { computeCycles } from './cycles.ts';
import { coverageProvenance, formatAge, type CoverageProvenance, type MeasuredCoverageSummary } from './measured-coverage.ts';

export interface HealthAxis {
  key: string;
  label: string;
  /** 0-100, or null when the scan cannot derive it. */
  value: number | null;
  /** The values the axis was derived from, so the number is explainable. */
  detail: string;
  /**
   * Which method produced the figure when this axis is coverage: `measured` from an
   * existing report, or `reachable` from the static test-reach. Other axes omit it.
   */
  basis?: 'measured' | 'reachable';
}

export interface HealthReport {
  /** Mean of the available axes, or null when none could be derived. */
  score: number | null;
  axes: HealthAxis[];
  /** The measured report the coverage axis consulted, when one was read. */
  coverage?: CoverageProvenance;
}

/**
 * Heuristic repository health signals derived from the resolved graph.
 *
 * Each axis reports the values it came from. This is deliberately a signal, not a verdict:
 * an absent edge limits what any of these can measure, so the caller should present the
 * detail alongside the number.
 */
export function computeArchitectureHealth(
  graph: Graph,
  measured?: MeasuredCoverageSummary | null,
): HealthReport {
  const { forward, backward } = buildAdjacency(graph);
  const nodeCount = graph.nodes.length;

  const fanOuts = graph.nodes.map((node) => (forward.get(node.id) ?? []).length);
  const averageFanOut = fanOuts.length > 0 ? fanOuts.reduce((sum, n) => sum + n, 0) / fanOuts.length : 0;
  const maxFanOut = fanOuts.reduce((max, n) => Math.max(max, n), 0);

  const axes: HealthAxis[] = [];

  // Low coupling: how far average fan-out stays from a busy value.
  axes.push({
    key: 'lowCoupling',
    label: 'Low coupling',
    value: score(1 - normalise(averageFanOut, 10)),
    detail: `average fan-out ${averageFanOut.toFixed(1)}`,
  });

  // Low fan-out: the busiest single file.
  axes.push({
    key: 'lowFanOut',
    label: 'Low fan-out',
    value: score(1 - normalise(maxFanOut, 25)),
    detail: `max fan-out ${maxFanOut}`,
  });

  // Low complexity: share of files not entangled in dependency cycles.
  const cycleNodes = new Set(computeCycles(graph).flatMap((group) => group.members));
  axes.push({
    key: 'lowComplexity',
    label: 'Low complexity',
    value: score(1 - normalise(cycleNodes.size, Math.max(1, nodeCount))),
    detail: `${cycleNodes.size} of ${nodeCount} files in cycles`,
  });

  // Cohesion: share of a file's connections that stay inside its own directory.
  const cohesion = computeCohesion(graph, forward, backward);
  axes.push({
    key: 'cohesion',
    label: 'Cohesion',
    value: cohesion.value,
    detail: cohesion.detail,
  });

  // Coverage: measured lines when a report exists, else modules reachable from a test.
  const reach = computeCoverage(graph);
  const modules = graph.nodes.filter((node) => node.kind !== 'test');
  const measuredLine = measured?.available ? measured.summary.lineCoverage : null;
  if (measured?.available && measuredLine !== null && measured.summary.filesMeasured > 0) {
    axes.push({
      key: 'coverage',
      label: 'Coverage',
      value: score(measuredLine / 100),
      detail:
        `measured ${measuredLine}% line coverage across ${measured.summary.filesMeasured} module(s)` +
        reportAge(measured),
      basis: 'measured',
    });
  } else if (reach.testFiles.length === 0 || modules.length === 0) {
    axes.push({
      key: 'coverage',
      label: 'Coverage',
      value: null,
      detail: 'no test files identified',
      basis: 'reachable',
    });
  } else {
    const covered = modules.filter((node) => reach.reached.includes(node.id)).length;
    const noLines = measured?.available ? '; the measured report records no line counts' : '';
    axes.push({
      key: 'coverage',
      label: 'Coverage',
      value: score(covered / modules.length),
      detail: `${covered} of ${modules.length} modules reachable from tests${noLines}`,
      basis: 'reachable',
    });
  }

  const available = axes.filter((axis) => axis.value !== null).map((axis) => axis.value as number);
  return {
    score: available.length > 0 ? Math.round(available.reduce((sum, n) => sum + n, 0) / available.length) : null,
    axes,
    ...(measured ? { coverage: coverageProvenance(measured) } : {}),
  };
}

/** " · report 3d old", when the measured report records a timestamp. */
function reportAge(measured: MeasuredCoverageSummary): string {
  return measured.reportAgeMs === null ? '' : ` · report ${formatAge(measured.reportAgeMs)} old`;
}

function computeCohesion(
  graph: Graph,
  forward: Map<string, string[]>,
  backward: Map<string, string[]>,
): { value: number | null; detail: string } {
  let total = 0;
  let inside = 0;
  let considered = 0;

  for (const node of graph.nodes) {
    const neighbours = [...(forward.get(node.id) ?? []), ...(backward.get(node.id) ?? [])];
    if (neighbours.length === 0) {
      continue;
    }
    considered += 1;
    const directory = parentDirectory(node.id);
    const same = neighbours.filter((id) => parentDirectory(id) === directory).length;
    total += neighbours.length;
    inside += same;
  }

  if (considered === 0 || total === 0) {
    return { value: null, detail: 'no resolved connections' };
  }
  const value = score(inside / total);
  return { value, detail: `${inside} of ${total} connections stay in the same directory` };
}

/** The file's containing directory, which is a finer signal than the top-level folder. */
function parentDirectory(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash === -1 ? '.' : id.slice(0, slash);
}

function normalise(value: number, ceiling: number): number {
  return Math.min(1, Math.max(0, value / ceiling));
}

function score(fraction: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}
