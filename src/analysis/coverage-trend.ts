import type { Graph } from '../types.ts';
import { computeGraphMetrics } from './analysis.ts';
import { computeCoverage, reachedFiles } from './coverage.ts';
import { readCommits, type CommitRow } from './git-log.ts';
import { revisionGraph } from './structural-diff.ts';

/**
 * A trend of the static test reach across the recent commits, for a weekly coverage summary.
 *
 * Each commit's graph is read through `revisionGraph` (the same per-commit cache the
 * architecture-drift timeline reads). The basis is reachability at that revision: a historical
 * measured coverage report is not available, so no figure here is presented as measured. A
 * commit whose graph cannot be built keeps a point whose measures are all `null`, so a gap is
 * visible rather than silently zero.
 */
export interface CoverageTrendMeasure {
  /** Stable id, e.g. `untested`. */
  key: string;
  label: string;
  /** `null` means the measure is not recorded for this revision. */
  value: number | null;
}

export interface CoverageTrendPoint extends CommitRow {
  measures: CoverageTrendMeasure[];
}

/** The movement of one measure across the window, oldest to newest. */
export interface CoverageTrendDelta {
  key: string;
  label: string;
  /** Oldest recorded value in the window. */
  from: number | null;
  /** Newest value. */
  to: number | null;
  /** `to - from` when both are recorded, else `null`. */
  change: number | null;
}

export interface CoverageTrendReport {
  available: boolean;
  reason?: string;
  repository: string;
  /** Window length in days. */
  days: number;
  /** Newest first. */
  points: CoverageTrendPoint[];
  deltas: CoverageTrendDelta[];
}

export interface CoverageTrendOptions {
  /** Window length in days; defaults to 7. */
  days?: number;
  /** Most commits to walk; defaults to 30. */
  limit?: number;
}

/** The measures, in fixed order. */
export const COVERAGE_TREND_MEASURES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'untested', label: 'Untested used files' },
  { key: 'used', label: 'Used files' },
  { key: 'reach-share', label: 'Reached share (%)' },
  { key: 'tests', label: 'Test files' },
];

const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
const MAX_DAYS = 90;
const DEFAULT_LIMIT = 30;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

/**
 * The reach-based coverage measures for one revision graph.
 *
 * `used` is a non-test file something depends on; `untested` is a used file no test reaches;
 * `reach-share` is the percent of used files a test reaches; `tests` is the test-file count.
 */
export function computeCoverageTrendMeasures(graph: Graph): CoverageTrendMeasure[] {
  const metrics = computeGraphMetrics(graph);
  const reached = reachedFiles(computeCoverage(graph));
  const used = graph.nodes.filter(
    (node) =>
      node.kind !== 'test' &&
      ((metrics.fanIn.get(node.id) ?? 0) > 0 ||
        (metrics.transitiveDependents.get(node.id) ?? 0) > 0),
  );
  const untested = used.filter((node) => !reached.has(node.id)).length;
  const tests = graph.nodes.filter((node) => node.kind === 'test').length;
  const share = used.length > 0 ? round1(((used.length - untested) / used.length) * 100) : null;

  return [
    { key: 'untested', label: 'Untested used files', value: untested },
    { key: 'used', label: 'Used files', value: used.length },
    { key: 'reach-share', label: 'Reached share', value: share },
    { key: 'tests', label: 'Test files', value: tests },
  ];
}

/**
 * Walk the commits in the window and measure the reach-based coverage at each.
 *
 * A repository that is not a git repo, or whose `git log` fails, is `available: false` with a
 * reason. An empty window is `available: true` with no points, which the caller states as such.
 */
export async function collectCoverageTrend(
  root: string,
  repository: string,
  options: CoverageTrendOptions = {},
): Promise<CoverageTrendReport> {
  const days = clamp(options.days, DEFAULT_DAYS, MIN_DAYS, MAX_DAYS);
  const limit = clamp(options.limit, DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);

  const result = await readCommits(root, ['-n', String(limit), `--since=${days} days ago`, 'HEAD']);
  if (!result.available) {
    return unavailable(repository, days, result.reason);
  }

  const points: CoverageTrendPoint[] = [];
  for (const commit of result.commits) {
    try {
      const { graph } = await revisionGraph(root, commit.revision, repository);
      points.push({ ...commit, measures: computeCoverageTrendMeasures(graph) });
    } catch {
      points.push({ ...commit, measures: emptyMeasures() });
    }
  }

  return { available: true, repository, days, points, deltas: buildDeltas(points) };
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function emptyMeasures(): CoverageTrendMeasure[] {
  return COVERAGE_TREND_MEASURES.map(({ key, label }) => ({ key, label, value: null }));
}

/** The oldest-to-newest movement of each measure, null when either end is not recorded. */
function buildDeltas(points: readonly CoverageTrendPoint[]): CoverageTrendDelta[] {
  const newest = points[0];
  const oldest = points[points.length - 1];
  return COVERAGE_TREND_MEASURES.map(({ key, label }) => {
    const from = valueOf(oldest, key);
    const to = valueOf(newest, key);
    return { key, label, from, to, change: from !== null && to !== null ? round1(to - from) : null };
  });
}

function valueOf(point: CoverageTrendPoint | undefined, key: string): number | null {
  if (!point) return null;
  const measure = point.measures.find((entry) => entry.key === key);
  return measure ? measure.value : null;
}

function unavailable(repository: string, days: number, reason: string): CoverageTrendReport {
  return { available: false, reason, repository, days, points: [], deltas: buildDeltas([]) };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
