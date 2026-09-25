import type { Graph } from '../types.ts';
import { computeCoverage } from './coverage.ts';
import type { MeasuredCoverageSummary } from './measured-coverage.ts';

/**
 * One file's coverage from a single source: the measured report when it names the file,
 * otherwise graph reachability from tests, always labelled with which it is.
 *
 * Every summary (passport, unit cards, tier stats, impact and change passports, the
 * repository report) reads this instead of calling `computeCoverage` on its own, so the
 * map and the summaries cannot disagree about one file.
 */
export interface FileCoverage {
  /** `measured` when the report names this file; otherwise `reachable`. */
  basis: 'measured' | 'reachable';
  /**
   * Measured line coverage, 0-100. Null for a `reachable` figure, and for a file the report
   * names without line counts: null is `unavailable`, never 0%.
   */
  value: number | null;
  /** Lines the report recorded as hit and found; null unless `basis` is `measured`. */
  linesHit: number | null;
  linesFound: number | null;
  /** True when the report predates the file's last commit; null when not assessed. */
  stale: boolean | null;
  /** Whether a test reaches this file over recorded edges: the labelled fallback. */
  reached: boolean;
  /** True when a report was read but does not name this file, so it is `not in report`. */
  notInReport: boolean;
}

/** Coverage for every graph file; report-named paths outside the graph get no entry. */
export function fileCoverage(
  graph: Graph,
  measured?: MeasuredCoverageSummary | null,
): Map<string, FileCoverage> {
  const reach = computeCoverage(graph);
  const reached = new Set([...reach.reached, ...reach.testFiles]);
  const report = measured?.available ? measured : null;
  const byPath = new Map(
    (report?.files ?? []).filter((entry) => entry.inGraph).map((entry) => [entry.file, entry]),
  );

  const result = new Map<string, FileCoverage>();
  for (const node of graph.nodes) {
    const entry = byPath.get(node.id);
    result.set(
      node.id,
      entry
        ? {
            basis: 'measured',
            value: entry.lineCoverage,
            linesHit: entry.linesHit,
            linesFound: entry.linesFound,
            stale: entry.stale,
            reached: reached.has(node.id),
            notInReport: false,
          }
        : {
            basis: 'reachable',
            value: null,
            linesHit: null,
            linesFound: null,
            stale: null,
            reached: reached.has(node.id),
            notInReport: report !== null,
          },
    );
  }
  return result;
}
