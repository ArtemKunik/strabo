import type { Graph } from '../types.ts';
import { buildAdjacency, computeGraphMetrics } from './analysis.ts';
import { computeTestReachByFile } from './coverage.ts';
import { computeCycles } from './cycles.ts';
import {
  fileCoverage,
  isUntested,
  UNDER_COVERED_THRESHOLD,
} from './file-coverage.ts';
import type { MeasuredCoverageSummary } from './measured-coverage.ts';

/**
 * The weak coverage points a QA pass should close first.
 *
 * A gap is a used, non-test file that {@link isUntested} reports on the same measured-or-reachable
 * basis the map and the passports read: under `threshold` when a report names it, or reached by no
 * test on the reachability fallback. A file the report does not name is `notInReport` and is never
 * counted as 0%. Each gap carries the recorded impact that decides its rank, so the ordering is
 * explainable rather than a black box.
 *
 * Pure: no I/O, no Git, no network. It reads only the graph and an already-parsed report.
 */

/** One weak coverage point, with the recorded impact behind its rank. */
export interface CoverageGap {
  file: string;
  /** `measured` when the report names this file; otherwise `reachable`. */
  basis: 'measured' | 'reachable';
  /** Measured line coverage, 0-100; null on the reachable basis or when unrecorded. */
  value: number | null;
  /** Lines the report recorded as hit and found; null on the reachable basis. */
  linesHit: number | null;
  linesFound: number | null;
  /** True when a test reaches this file over recorded edges. */
  reached: boolean;
  /** True when the report predates this file's last commit; null when not assessed. */
  stale: boolean | null;
  /** Files that import this file directly. */
  dependents: number;
  /** Files that depend on it transitively: the blast radius. */
  transitiveDependents: number;
  /** The recorded cycle this file sits in, or 0 when it is in none. */
  cycleSize: number;
  /** Recorded function signals across the file, when a caller supplies them; 0 otherwise. */
  signals: number;
  /** Tests whose forward closure reaches this file: the tests that already run. */
  tests: string[];
  /** A non-negative rank; a larger score is a weaker point. See {@link scoreGap}. */
  score: number;
}

/** The ranked weak coverage points, with the basis and totals they were drawn from. */
export interface CoverageGapReport {
  /** The measured line-coverage percent below which a used file is a gap. */
  threshold: number;
  /** `measured` when a report was read, otherwise `reachable`. */
  basis: 'measured' | 'reachable';
  /** Every weak file, before any caller limit. */
  total: number;
  /** Used files the report does not name: `not in report`, never counted as 0%. */
  notInReport: number;
  /** The ranked gaps, weakest first. */
  gaps: CoverageGap[];
}

export interface CoverageGapOptions {
  /** Measured line-coverage cut-off; defaults to {@link UNDER_COVERED_THRESHOLD}. */
  threshold?: number;
  /** Cap on the returned gaps; omitted keeps them all. */
  limit?: number;
  /** Recorded function-signal counts per file, e.g. from `rankHotspots`. */
  signalsByFile?: ReadonlyMap<string, number>;
  /** Pre-computed cycle size per file, so a caller that already ran `computeCycles` reuses it. */
  cycleSizeByFile?: ReadonlyMap<string, number>;
}

/**
 * Rank the used, non-test files that tests leave weakly covered.
 *
 * Candidates are the files `isUntested` names, restricted to files something depends on: an
 * untested orphan is not a coverage gap a QA pass should rank. Files the report does not name
 * are counted in `notInReport` and never treated as 0%.
 */
export function computeCoverageGaps(
  graph: Graph,
  measured: MeasuredCoverageSummary | null | undefined,
  options: CoverageGapOptions = {},
): CoverageGapReport {
  const threshold = options.threshold ?? UNDER_COVERED_THRESHOLD;
  const basis: 'measured' | 'reachable' = measured?.available ? 'measured' : 'reachable';
  const coverage = fileCoverage(graph, measured ?? null);
  const adjacency = buildAdjacency(graph);
  const metrics = computeGraphMetrics(graph, adjacency);
  const testsByFile = computeTestReachByFile(graph);
  const cycleSizeByFile = options.cycleSizeByFile ?? cycleSizes(graph);

  const used = graph.nodes.filter(
    (node) =>
      node.kind !== 'test' &&
      ((metrics.fanIn.get(node.id) ?? 0) > 0 ||
        (metrics.transitiveDependents.get(node.id) ?? 0) > 0),
  );

  const gaps: CoverageGap[] = [];
  let notInReport = 0;
  for (const node of used) {
    const figure = coverage.get(node.id);
    if (!figure) {
      continue;
    }
    if (figure.notInReport) {
      notInReport += 1;
      continue;
    }
    if (!isUntested(figure, basis, threshold)) {
      continue;
    }
    const dependents = metrics.fanIn.get(node.id) ?? 0;
    const transitiveDependents = metrics.transitiveDependents.get(node.id) ?? 0;
    const cycleSize = cycleSizeByFile.get(node.id) ?? 0;
    const signals = options.signalsByFile?.get(node.id) ?? 0;
    const shortfall =
      figure.basis === 'measured' && figure.value !== null
        ? (threshold - figure.value) / threshold
        : 1;
    const score = scoreGap({ dependents, transitiveDependents, signals, cycleSize, shortfall });
    gaps.push({
      file: node.id,
      basis: figure.basis,
      value: figure.value,
      linesHit: figure.linesHit,
      linesFound: figure.linesFound,
      reached: figure.reached,
      stale: figure.stale,
      dependents,
      transitiveDependents,
      cycleSize,
      signals,
      tests: testsByFile.get(node.id) ?? [],
      score,
    });
  }

  gaps.sort(compareGaps);
  const total = gaps.length;
  const limited = options.limit === undefined ? gaps : gaps.slice(0, options.limit);
  return { threshold, basis, total, notInReport, gaps: limited };
}

/**
 * The rank a gap carries. Documented so the ordering is inspectable:
 * the transitive blast radius dominates, direct importers come next, recorded function
 * signals add pressure, a cycle adds a fixed penalty, and the distance below the threshold
 * breaks the rest as a bounded 0-10 weight.
 */
function scoreGap(input: {
  dependents: number;
  transitiveDependents: number;
  signals: number;
  cycleSize: number;
  shortfall: number;
}): number {
  const radius = input.transitiveDependents * 4 + input.dependents * 2;
  const pressure = input.signals * 3;
  const cycle = input.cycleSize > 1 ? 5 : 0;
  const shortfall = Math.round(input.shortfall * 10);
  return radius + pressure + cycle + shortfall;
}

/** Worst first: score, then transitive dependents, direct importers, and file path. */
function compareGaps(a: CoverageGap, b: CoverageGap): number {
  return (
    b.score - a.score ||
    b.transitiveDependents - a.transitiveDependents ||
    b.dependents - a.dependents ||
    a.file.localeCompare(b.file)
  );
}

/** The size of the cycle each file sits in, or no entry when it sits in none. */
function cycleSizes(graph: Graph): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const group of computeCycles(graph)) {
    for (const member of group.members) {
      sizes.set(member, group.members.length);
    }
  }
  return sizes;
}
