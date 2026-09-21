import { buildAdjacency } from './analysis.ts';
import type { CoChangeCommit, HistorySummary, SkippedCommit } from './history.ts';
import type { Graph } from '../types.ts';

/**
 * Co-change edges: files that changed together often enough to be worth drawing.
 *
 * The smell path (`quality.ts`) reads the *share* of co-change that has no import path; this
 * reads the *edges*, each carrying the commits behind it. Pure: the summary and the graph
 * go in, a report comes out, and nothing here touches Git or the filesystem.
 *
 * Two files join when they shared at least `minCommits` commits in the window and, among
 * the commits that touched either file, at least `minRatio` of them touched both. A pair
 * with no listable commits is not drawn, so every edge names its evidence.
 */

export interface CoChangeOptions {
  /** Shared commits before a pair becomes an edge. */
  minCommits?: number;
  /**
   * Coupling ratio floor: `shared / (commits touching either file)`. 0.5 is the
   * quality scorecard's own "half or more" bar, so the edge and the smell agree.
   */
  minRatio?: number;
  /** Cap on the commits carried per edge; the summary already capped its per-pair list. */
  maxCommitsPerEdge?: number;
  /** Cap on the edges returned, heaviest first. */
  maxEdges?: number;
}

/** The recorded evidence behind one co-change edge. */
export interface CoChangeEdge {
  source: string;
  target: string;
  /** `source < target`, so the pair is stable whatever the graph order. */
  commits: CoChangeCommit[];
  commitsShared: number;
  /** `commits touching either file`, the ratio's denominator. */
  commitsUnion: number;
  /** `commitsShared / commitsUnion`, rounded to 3 places. */
  ratio: number;
  /** True when no import path joins the two files in either direction (K3). */
  hidden: boolean;
}

export interface CoChangeSkippedCommit extends SkippedCommit {
  /** The commit touched more files than the cap, so it was reported and left out. */
  reason: 'mass-commit';
}

export interface CoChangeReport {
  edges: CoChangeEdge[];
  /** Mass commits the history excluded from co-change, named rather than silently dropped. */
  skippedCommits: CoChangeSkippedCommit[];
  /** Files the edges mention that no graph node holds, so the caller can name the gap. */
  fromUnavailable: number;
  thresholds: {
    minCommits: number;
    minRatio: number;
    maxCommitsPerEdge: number;
    maxEdges: number;
    /** The history's own per-pair evidence cap, carried so the report is self-describing. */
    maxKeptCommitsPerPair: number;
  };
  /** History was unavailable (no Git, or no commits read); the edges list is empty. */
  unavailable: boolean;
}

/** Conservative defaults: three shared commits and half the union. */
export const DEFAULT_MIN_COMMITS = 3;
export const DEFAULT_MIN_RATIO = 0.5;
export const DEFAULT_MAX_COMMITS_PER_EDGE = 20;
export const DEFAULT_MAX_EDGES = 500;

/**
 * Build the co-change edges for a graph from its history summary.
 *
 * Files outside the graph are excluded, a pair with no listed commits is not drawn, and
 * `hidden` is decided over use-edge reachability in both directions, not a direct edge, so
 * a config/consumer pair joined only through a chain still reads honestly.
 */
export function buildCoChangeEdges(
  summary: HistorySummary,
  graph: Graph,
  options: CoChangeOptions = {},
): CoChangeReport {
  const minCommits = options.minCommits ?? DEFAULT_MIN_COMMITS;
  const minRatio = options.minRatio ?? DEFAULT_MIN_RATIO;
  const maxCommitsPerEdge = options.maxCommitsPerEdge ?? DEFAULT_MAX_COMMITS_PER_EDGE;
  const maxEdges = options.maxEdges ?? DEFAULT_MAX_EDGES;

  const thresholds = {
    minCommits,
    minRatio,
    maxCommitsPerEdge,
    maxEdges,
    maxKeptCommitsPerPair: summary.maxKeptCommitsPerPair,
  };

  if (!summary.available) {
    return { edges: [], skippedCommits: [], fromUnavailable: 0, thresholds, unavailable: true };
  }

  const inGraph = new Set(graph.nodes.map((node) => node.id));
  const { forward } = buildAdjacency(graph);
  // Reachability, not a direct edge: hidden coupling is a pair joined by no import path at
  // all, so a chain through a third file still counts as connected and is not flagged.
  const reachable = memoizedReachability(forward);

  const edges: CoChangeEdge[] = [];
  let fromUnavailable = 0;
  for (const pair of summary.coChangeCommits.values()) {
    const { a: source, b: target } = pair;
    if (!inGraph.has(source) || !inGraph.has(target)) {
      fromUnavailable += 1;
      continue;
    }
    if (pair.commits.length === 0) {
      // INVARIANT: an edge with no listable commits is not drawn.
      fromUnavailable += 1;
      continue;
    }
    const commitsShared = pair.commitsShared || pair.commits.length;
    const commitsUnion = (summary.churn.get(source) ?? 0) + (summary.churn.get(target) ?? 0) - commitsShared;
    if (commitsShared < minCommits || commitsUnion <= 0) {
      continue;
    }
    const ratio = commitsShared / commitsUnion;
    if (ratio < minRatio) {
      continue;
    }
    edges.push({
      source,
      target,
      commits: pair.commits.slice(0, maxCommitsPerEdge),
      commitsShared,
      commitsUnion,
      ratio: Number(ratio.toFixed(3)),
      hidden: !reachable(source, target) && !reachable(target, source),
    });
  }

  edges.sort(
    (a, b) =>
      b.commitsShared - a.commitsShared ||
      a.source.localeCompare(b.source) ||
      a.target.localeCompare(b.target),
  );

  return {
    edges: edges.slice(0, maxEdges),
    skippedCommits: summary.skippedCommits.map((commit) => ({ ...commit, reason: 'mass-commit' as const })),
    fromUnavailable,
    thresholds,
    unavailable: false,
  };
}

/** A `reachable(from, to)` over use-edge imports, caching each source's closure. */
function memoizedReachability(
  forward: Map<string, string[]>,
): (from: string, to: string) => boolean {
  const closures = new Map<string, Set<string>>();
  const closureOf = (start: string): Set<string> => {
    const cached = closures.get(start);
    if (cached) {
      return cached;
    }
    const seen = new Set<string>();
    const stack = [...(forward.get(start) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (next === start || seen.has(next)) {
        continue;
      }
      seen.add(next);
      for (const neighbour of forward.get(next) ?? []) {
        if (!seen.has(neighbour)) {
          stack.push(neighbour);
        }
      }
    }
    closures.set(start, seen);
    return seen;
  };
  return (from: string, to: string): boolean => {
    if (closureOf(from).has(to)) {
      return true;
    }
    return closureOf(to).has(from);
  };
}
