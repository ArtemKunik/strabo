import type { Graph } from '../types.ts';
import { computeCoverage } from './coverage.ts';
import { percent, type MeasuredCoverageSummary } from './measured-coverage.ts';

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
  /** The report's own mtime, ISO-8601; null when no report was read. */
  reportModified: string | null;
  /** `now - reportModified` in milliseconds; null when no report was read. */
  reportAgeMs: number | null;
}

/**
 * A measured sum over several files, with the reachability fallback counted beside it, so a
 * tier cell, a per-tier stat, or a change-set roll-up names its basis and the report age.
 */
export interface FileCoverageAggregate {
  /** `measured` when any listed file was named by a report, or the report named none of them. */
  basis: 'measured' | 'reachable';
  /** Files considered. */
  files: number;
  /** Files the report names; the summed lines below cover these. */
  filesMeasured: number;
  /** Files a report was read for but does not name: `not in report`, never counted as 0%. */
  notInReport: number;
  /** Files no test reaches: the labelled fallback, counted for every listed file. */
  reached: number;
  linesHit: number;
  linesFound: number;
  /** Measured percent over `filesMeasured`, or null when nothing was measured. */
  value: number | null;
  /** The report's mtime, ISO-8601; null when no report was read. */
  reportModified: string | null;
  /** `now - reportModified` in milliseconds; null when no report was read. */
  reportAgeMs: number | null;
}

/**
 * Sum one figure per file into a basis-labelled aggregate. Files missing from `coverage`
 * (report paths outside the graph) contribute nothing and are not counted.
 */
export function summariseFileCoverage(
  files: readonly string[],
  coverage: ReadonlyMap<string, FileCoverage>,
): FileCoverageAggregate {
  let basis: 'measured' | 'reachable' = 'reachable';
  let filesMeasured = 0;
  let notInReport = 0;
  let reached = 0;
  let linesHit = 0;
  let linesFound = 0;
  let reportModified: string | null = null;
  let reportAgeMs: number | null = null;

  for (const file of files) {
    const figure = coverage.get(file);
    if (!figure) {
      continue;
    }
    if (figure.basis === 'measured') {
      basis = 'measured';
      filesMeasured += 1;
      linesHit += figure.linesHit ?? 0;
      linesFound += figure.linesFound ?? 0;
    } else if (figure.notInReport) {
      // A report was read but does not name this file: still the measured basis, unknown.
      basis = 'measured';
      notInReport += 1;
    }
    if (figure.reached) {
      reached += 1;
    }
    if (reportModified === null) {
      reportModified = figure.reportModified;
    }
    if (reportAgeMs === null) {
      reportAgeMs = figure.reportAgeMs;
    }
  }

  return {
    basis,
    files: files.length,
    filesMeasured,
    notInReport,
    reached,
    linesHit,
    linesFound,
    value: percent(linesHit, linesFound),
    reportModified,
    reportAgeMs,
  };
}

/** The measured line coverage below which a used file counts as under-covered. */
export const UNDER_COVERED_THRESHOLD = 50;

/**
 * Whether a file is untested for a consumer: under `threshold` measured when the report names
 * it, or no test reaches it on the reachability fallback. A file the report does not name is
 * `not in report`, not untested; callers count those separately rather than calling them 0%.
 */
export function isUntested(
  figure: FileCoverage | undefined,
  basis: 'measured' | 'reachable',
  threshold: number = UNDER_COVERED_THRESHOLD,
): boolean {
  if (!figure) {
    return false;
  }
  if (basis === 'measured') {
    return figure.value !== null && figure.value < threshold;
  }
  return !figure.reached;
}

/** Coverage for every graph file; report-named paths outside the graph get no entry. */
export function fileCoverage(
  graph: Graph,
  measured?: MeasuredCoverageSummary | null,
): Map<string, FileCoverage> {
  const reach = computeCoverage(graph);
  const reached = new Set([...reach.reached, ...reach.testFiles]);
  const report = measured?.available ? measured : null;
  const reportModified = report?.reportModified ?? null;
  const reportAgeMs = report?.reportAgeMs ?? null;
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
            reportModified,
            reportAgeMs,
          }
        : {
            basis: 'reachable',
            value: null,
            linesHit: null,
            linesFound: null,
            stale: null,
            reached: reached.has(node.id),
            notInReport: report !== null,
            reportModified,
            reportAgeMs,
          },
    );
  }
  return result;
}
