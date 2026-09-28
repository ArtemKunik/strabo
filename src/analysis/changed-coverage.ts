import type { FileDiff } from './diff.ts';
import type { FunctionEntry } from './functions.ts';
import type { MeasuredCoverageSummary } from './measured-coverage.ts';
import type { SymbolChange } from './review-types.ts';

/** One changed function with uncovered lines in review. */
export interface UncoveredFunctionChange {
  name: string;
  owner: string;
  isPublic: boolean;
  linesChanged: number;
  linesCovered: number;
  linesUncovered: number;
}

/**
 * Line coverage computed specifically over the added/modified lines in a change.
 *
 * Intersects git diff additions with the measured coverage report. When the report
 * predates the change, answers "report predates the change" with basis `stale`
 * rather than fabricating a figure.
 */
export interface ChangedLineCoverage {
  file: string;
  basis: 'measured' | 'stale' | 'unavailable';
  linesChanged: number;
  linesCovered: number;
  linesUncovered: number;
  /** 0-100 percent of changed lines that were covered; null when linesChanged is 0 or basis != measured. */
  coveragePercent: number | null;
  changedLines: number[];
  coveredLines: number[];
  uncoveredLines: number[];
  /** Changed functions that have uncovered lines, with public-surface functions listed first. */
  uncoveredFunctions: UncoveredFunctionChange[];
  note?: string;
}

/** Summary rollup across all changed files. */
export interface ChangedCoverageTotals {
  filesChanged: number;
  linesChanged: number;
  linesCovered: number;
  linesUncovered: number;
  coveragePercent: number | null;
  uncoveredFunctionsCount: number;
}

export interface ComputeChangedCoverageOptions {
  functions?: readonly FunctionEntry[];
  publicSymbols?: readonly SymbolChange[];
}

/**
 * Compute changed-line coverage for a single file's diff against a measured coverage report.
 */
export function computeChangedLineCoverage(
  diff: FileDiff,
  measured: MeasuredCoverageSummary | null | undefined,
  options: ComputeChangedCoverageOptions = {},
): ChangedLineCoverage {
  const changedLines: number[] = [];
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add' && line.newLine !== null && Number.isFinite(line.newLine)) {
        changedLines.push(line.newLine);
      }
    }
  }
  changedLines.sort((a, b) => a - b);

  if (!measured?.available) {
    return {
      file: diff.file,
      basis: 'unavailable',
      linesChanged: changedLines.length,
      linesCovered: 0,
      linesUncovered: changedLines.length,
      coveragePercent: null,
      changedLines,
      coveredLines: [],
      uncoveredLines: changedLines,
      uncoveredFunctions: [],
      note: measured?.reason ?? 'no measured report available',
    };
  }

  const fileEntry = measured.files.find((f) => f.file === diff.file);
  if (!fileEntry) {
    return {
      file: diff.file,
      basis: 'unavailable',
      linesChanged: changedLines.length,
      linesCovered: 0,
      linesUncovered: changedLines.length,
      coveragePercent: null,
      changedLines,
      coveredLines: [],
      uncoveredLines: changedLines,
      uncoveredFunctions: [],
      note: 'not in report',
    };
  }

  if (fileEntry.stale === true) {
    return {
      file: diff.file,
      basis: 'stale',
      linesChanged: changedLines.length,
      linesCovered: 0,
      linesUncovered: changedLines.length,
      coveragePercent: null,
      changedLines,
      coveredLines: [],
      uncoveredLines: changedLines,
      uncoveredFunctions: [],
      note: 'report predates the change',
    };
  }

  const reportCoveredSet = new Set(fileEntry.coveredLines ?? []);
  const coveredLines = changedLines.filter((line) => reportCoveredSet.has(line));
  const uncoveredLines = changedLines.filter((line) => !reportCoveredSet.has(line));
  const linesCovered = coveredLines.length;
  const linesUncovered = uncoveredLines.length;
  const coveragePercent =
    changedLines.length > 0 ? Math.round((linesCovered / changedLines.length) * 100) : null;

  const publicSet = new Set(
    (options.publicSymbols ?? []).map((s) => s.name),
  );

  const uncoveredFunctions: UncoveredFunctionChange[] = [];
  for (const fn of options.functions ?? []) {
    const fnStart = fn.line;
    const fnEnd = fnStart + Math.max(0, (fn.metrics?.lines ?? 1) - 1);
    const fnChanged = changedLines.filter((line) => line >= fnStart && line <= fnEnd);
    if (fnChanged.length === 0) {
      continue;
    }
    const fnCovered = fnChanged.filter((line) => reportCoveredSet.has(line));
    const fnUncovered = fnChanged.filter((line) => !reportCoveredSet.has(line));
    if (fnUncovered.length > 0) {
      const isPublic = fn.visibility === 'public' || publicSet.has(fn.name);
      uncoveredFunctions.push({
        name: fn.name,
        owner: fn.owner,
        isPublic,
        linesChanged: fnChanged.length,
        linesCovered: fnCovered.length,
        linesUncovered: fnUncovered.length,
      });
    }
  }

  // Public surface functions listed first, then by most uncovered lines, then name.
  uncoveredFunctions.sort((a, b) => {
    if (a.isPublic !== b.isPublic) {
      return a.isPublic ? -1 : 1;
    }
    if (a.linesUncovered !== b.linesUncovered) {
      return b.linesUncovered - a.linesUncovered;
    }
    return a.name.localeCompare(b.name);
  });

  return {
    file: diff.file,
    basis: 'measured',
    linesChanged: changedLines.length,
    linesCovered,
    linesUncovered,
    coveragePercent,
    changedLines,
    coveredLines,
    uncoveredLines,
    uncoveredFunctions,
  };
}

/**
 * Summarise changed-line coverage across a list of changed file coverages.
 */
export function summariseChangedCoverage(
  items: readonly ChangedLineCoverage[],
): ChangedCoverageTotals {
  let linesChanged = 0;
  let linesCovered = 0;
  let linesUncovered = 0;
  let uncoveredFunctionsCount = 0;

  for (const item of items) {
    linesChanged += item.linesChanged;
    linesCovered += item.linesCovered;
    linesUncovered += item.linesUncovered;
    uncoveredFunctionsCount += item.uncoveredFunctions.length;
  }

  const coveragePercent =
    linesChanged > 0 ? Math.round((linesCovered / linesChanged) * 100) : null;

  return {
    filesChanged: items.length,
    linesChanged,
    linesCovered,
    linesUncovered,
    coveragePercent,
    uncoveredFunctionsCount,
  };
}
