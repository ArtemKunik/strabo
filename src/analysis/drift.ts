import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Graph } from '../types.ts';
import { computeGraphMetrics, relationshipOf } from './analysis.ts';
import { computeCycles } from './cycles.ts';
import { revisionGraph } from './structural-diff.ts';

const run = promisify(execFile);

/**
 * A timeline of structural measures read from the per-commit revision graphs.
 *
 * A measure is a count or share of recorded edges, never a composite score. A measure the
 * revision cache cannot supply for a revision is `null`, and the line says so, so a gap in
 * the timeline is visible rather than silently zero.
 */

export interface DriftMeasure {
  /** Stable id, e.g. `cycles`. */
  key: string;
  /** Human label, e.g. `Cycles`. */
  label: string;
  /** `null` means the measure is not recorded for this revision. */
  value: number | null;
}

export interface DriftPoint {
  /** Full sha. */
  revision: string;
  /** 7-char short sha. */
  short: string;
  /** ISO author date from `git log`, or `null`. */
  date: string | null;
  subject: string | null;
  measures: DriftMeasure[];
}

export interface DriftSeries {
  key: string;
  label: string;
  points: Array<{ revision: string; value: number | null }>;
}

export interface DriftReport {
  available: boolean;
  reason?: string;
  repository: string;
  base: string | null;
  /** Newest first. */
  points: DriftPoint[];
  series: DriftSeries[];
}

export interface DriftOptions {
  limit?: number;
  base?: string | null;
}

/** The measures, in fixed order. Two are always `null`; see `computeDriftMeasures`. */
export const DRIFT_MEASURES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'cycles', label: 'Cycles' },
  { key: 'largest-cycle', label: 'Largest cycle' },
  { key: 'modules', label: 'Modules' },
  { key: 'largest-module', label: 'Largest module' },
  { key: 'edges', label: 'Dependency edges' },
  { key: 'largest-blast-radius', label: 'Largest blast radius' },
  { key: 'hidden-coupling-share', label: 'Hidden coupling share' },
  { key: 'tier-violations', label: 'Tier violations' },
];

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const MAX_BUFFER = 32 * 1024 * 1024;

/** The eight measures for one revision graph: six counts, two honest `null`s. */
export function computeDriftMeasures(graph: Graph): DriftMeasure[] {
  const cycles = computeCycles(graph);
  const largestCycle = cycles.reduce((max, cycle) => Math.max(max, cycle.members.length), 0);
  const modules = graph.nodes.length;
  const edges = graph.edges.filter((edge) => {
    const relationship = relationshipOf(edge);
    return relationship === 'import' || relationship === 're-export';
  }).length;
  const largestBlastRadius = Math.max(
    0,
    ...computeGraphMetrics(graph).transitiveDependents.values(),
  );

  return [
    { key: 'cycles', label: 'Cycles', value: cycles.length },
    { key: 'largest-cycle', label: 'Largest cycle', value: largestCycle },
    { key: 'modules', label: 'Modules', value: modules },
    { key: 'largest-module', label: 'Largest module', value: largestModule(graph) },
    { key: 'edges', label: 'Dependency edges', value: edges },
    { key: 'largest-blast-radius', label: 'Largest blast radius', value: largestBlastRadius },
    // A per-revision hidden-coupling share needs the bounded history window `collectHistory`
    // reads; `revisionGraph` records the graph only, so there is no honest value here.
    { key: 'hidden-coupling-share', label: 'Hidden coupling share', value: null },
    // Tier violations need a per-revision content pass: `structuralContext` reads the working
    // tree's manifests and tier overrides, not the manifests at this commit.
    { key: 'tier-violations', label: 'Tier violations', value: null },
  ];
}

/** The most files under one top-level directory; a file at the root counts under `.`. */
function largestModule(graph: Graph): number {
  const counts = new Map<string, number>();
  for (const node of graph.nodes) {
    const top = node.directory === '.' ? '.' : node.directory.split('/')[0] as string;
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  let max = 0;
  for (const count of counts.values()) {
    if (count > max) max = count;
  }
  return max;
}

/**
 * The structural timeline for the most recent commits of a repository.
 *
 * The commit list comes from one bounded `git log`; each commit's graph is read through
 * `revisionGraph`, so a commit whose graph cannot be built yields a point whose measures are
 * all `null` and stays in the list, keeping the gap visible. A repository that is not a git
 * repo, or whose `git log` fails, is `available: false` with a reason.
 */
export async function collectDrift(
  root: string,
  repository: string,
  options: DriftOptions = {},
): Promise<DriftReport> {
  const limit = clampLimit(options.limit);
  const base = options.base ?? null;

  let stdout: string;
  try {
    ({ stdout } = await run(
      'git',
      ['log', '--format=%H%x1f%h%x1f%aI%x1f%s', '-z', '-n', String(limit), base ?? 'HEAD'],
      { cwd: root, maxBuffer: MAX_BUFFER },
    ));
  } catch (error) {
    return unavailable(repository, base, gitFailureReason(error));
  }

  const commits = parseLog(stdout);
  if (commits.length === 0) {
    return unavailable(repository, base, 'no-commits');
  }

  const points: DriftPoint[] = [];
  for (const commit of commits) {
    try {
      const result = await revisionGraph(root, commit.revision, repository);
      points.push({ ...commit, measures: computeDriftMeasures(result.graph) });
    } catch {
      points.push({ ...commit, measures: emptyMeasures() });
    }
  }

  return { available: true, repository, base, points, series: buildSeries(points) };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(limit)));
}

interface DriftCommit {
  revision: string;
  short: string;
  date: string | null;
  subject: string | null;
}

/**
 * Parse `git log --format=%H%x1f%h%x1f%aI%x1f%s -z`: records are NUL-separated (a trailing
 * NUL ends the last one), and fields inside a record are unit-separator separated.
 */
function parseLog(stdout: string): DriftCommit[] {
  const commits: DriftCommit[] = [];
  for (const record of stdout.split('\0')) {
    if (record === '') continue;
    const [revision = '', short = '', date = '', ...subjectParts] = record.split('\u001f');
    if (revision === '') continue;
    commits.push({
      revision,
      short,
      date: date === '' ? null : date,
      subject: subjectParts.length === 0 ? null : subjectParts.join('\u001f'),
    });
  }
  return commits;
}

function emptyMeasures(): DriftMeasure[] {
  return DRIFT_MEASURES.map(({ key, label }) => ({ key, label, value: null }));
}

/** One series per measure, its points in the same newest-first order as `points`. */
function buildSeries(points: readonly DriftPoint[]): DriftSeries[] {
  return DRIFT_MEASURES.map(({ key, label }) => ({
    key,
    label,
    points: points.map((point) => {
      const measure = point.measures.find((entry) => entry.key === key);
      return { revision: point.revision, value: measure ? measure.value : null };
    }),
  }));
}

function unavailable(repository: string, base: string | null, reason: string): DriftReport {
  return { available: false, reason, repository, base, points: [], series: buildSeries([]) };
}

function gitFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/not a git repository|dubious ownership|not inside a Git working tree/i.test(message)) {
    return 'not-a-git-repository';
  }
  return 'git-log-failed';
}
