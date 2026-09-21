import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { getCachedGraph } from '../cache/graph-cache.ts';
import { scanRepository } from '../scan/scan.ts';
import { detectEntryPoints } from '../scan/entry-points.ts';
import { revisionFromFingerprint } from '../status.ts';
import type { Graph } from '../types.ts';
import { computeCoverage } from './coverage.ts';
import { computeCycles, type CycleGroup } from './cycles.ts';
import { isSafeRevision } from './impact.ts';
import { buildTierReport, type TierDirection } from './tiers.ts';

const run = promisify(execFile);

/**
 * The structural change between two revisions, read from the two graphs rather than the
 * text diff: which dependency edges, cycles, wrong-way tier edges, entry points, and test
 * reach appeared or disappeared.
 *
 * `diffGraphs` is pure. `computeStructuralDiff` is the one caller that needs a second
 * graph: the cache is keyed by a single fingerprint, so the base graph is scanned from a
 * temporary `git worktree --detach`, cached by revision, and removed whichever way the scan
 * goes. A base that cannot be read is reported `unavailable`, never as an empty diff.
 */

export interface StructuralTierEdge {
  unit: string;
  source: string;
  target: string;
  kind: 'upward' | 'skip-layer';
}

/** The recorded facts a side supplies to the diff: no graph traversal happens here. */
export interface StructuralContext {
  tierEdges: StructuralTierEdge[];
  /** Entry-point file ids, from the manifests that declare them. */
  entryPoints: string[];
  /** Non-test files a test reaches, from `computeCoverage`. */
  reached: string[];
}

export interface StructuralEdge {
  source: string;
  target: string;
  kind: string;
}

export interface StructuralCycle {
  id: string;
  members: string[];
}

export interface StructuralDiff {
  edgesAdded: StructuralEdge[];
  edgesRemoved: StructuralEdge[];
  cyclesIntroduced: StructuralCycle[];
  cyclesResolved: StructuralCycle[];
  tierEdgesAdded: StructuralTierEdge[];
  entryPointsAdded: string[];
  newlyUnreached: string[];
  counts: {
    edgesAdded: number;
    edgesRemoved: number;
    cyclesIntroduced: number;
    cyclesResolved: number;
    tierEdgesAdded: number;
    entryPointsAdded: number;
    newlyUnreached: number;
  };
}

export type StructuralUnavailableReason =
  | 'no-git'
  | 'git-error'
  | 'unknown-revision'
  | 'base-scan-failed';

export type StructuralDiffResult =
  | {
      available: true;
      base: string;
      baseRevision: string;
      headRevision: string | null;
      diff: StructuralDiff;
      cached: boolean;
    }
  | { available: false; reason: StructuralUnavailableReason; detail?: string };

/** Bounded, in-memory base graphs. A worktree scan is the expensive part of the diff. */
const BASE_CACHE_LIMIT = 4;
const baseGraphs = new Map<string, { graph: Graph; context: StructuralContext }>();

/** Drop the base-graph cache; tests call this between cases. */
export function clearStructuralDiffCache(): void {
  baseGraphs.clear();
}

/**
 * The structural difference between two graphs, given each side's recorded tier edges,
 * entry points, and test reach. Pure: every input is data.
 */
export function diffGraphs(
  before: Graph,
  after: Graph,
  beforeContext: StructuralContext,
  afterContext: StructuralContext,
): StructuralDiff {
  const beforeEdges = dependencyEdges(before);
  const afterEdges = dependencyEdges(after);
  const beforeEdgeKeys = new Set(beforeEdges.map(edgeKey));
  const afterEdgeKeys = new Set(afterEdges.map(edgeKey));

  const edgesAdded = afterEdges
    .filter((edge) => !beforeEdgeKeys.has(edgeKey(edge)))
    .map(toStructuralEdge)
    .sort(compareEdge);
  const edgesRemoved = beforeEdges
    .filter((edge) => !afterEdgeKeys.has(edgeKey(edge)))
    .map(toStructuralEdge)
    .sort(compareEdge);

  const beforeCycles = cycleMap(computeCycles(before));
  const afterCycles = cycleMap(computeCycles(after));
  const cyclesIntroduced = [...afterCycles.values()]
    .filter((cycle) => !beforeCycles.has(cycleKey(cycle)))
    .sort(compareCycle);
  const cyclesResolved = [...beforeCycles.values()]
    .filter((cycle) => !afterCycles.has(cycleKey(cycle)))
    .sort(compareCycle);

  const beforeTierKeys = new Set(beforeContext.tierEdges.map(tierEdgeKey));
  const tierEdgesAdded = afterContext.tierEdges
    .filter((edge) => !beforeTierKeys.has(tierEdgeKey(edge)))
    .map((edge) => ({ ...edge }))
    .sort(compareTierEdge);

  const beforeEntries = new Set(beforeContext.entryPoints);
  const entryPointsAdded = [...new Set(afterContext.entryPoints)]
    .filter((file) => !beforeEntries.has(file))
    .sort();

  const afterNodes = new Set(after.nodes.map((node) => node.id));
  const afterReached = new Set(afterContext.reached);
  const newlyUnreached = [...new Set(beforeContext.reached)]
    .filter((file) => afterNodes.has(file) && !afterReached.has(file))
    .sort();

  return {
    edgesAdded,
    edgesRemoved,
    cyclesIntroduced,
    cyclesResolved,
    tierEdgesAdded,
    entryPointsAdded,
    newlyUnreached,
    counts: {
      edgesAdded: edgesAdded.length,
      edgesRemoved: edgesRemoved.length,
      cyclesIntroduced: cyclesIntroduced.length,
      cyclesResolved: cyclesResolved.length,
      tierEdgesAdded: tierEdgesAdded.length,
      entryPointsAdded: entryPointsAdded.length,
      newlyUnreached: newlyUnreached.length,
    },
  };
}

/**
 * The recorded facts one side contributes to `diffGraphs`: wrong-way tier edges, entry
 * points, and the files a test reaches. Reads the working tree `root` for manifests and
 * tier overrides, so it is called once per side, not per comparison.
 */
export function structuralContext(root: string, repository: string, graph: Graph): StructuralContext {
  const tiers = buildTierReport(root, repository, graph);
  const files = graph.nodes.map((node) => node.id);
  return {
    tierEdges: tiers.directions.map((direction) => toStructuralTierEdge(direction)),
    entryPoints: detectEntryPoints(root, files).map((entry) => entry.file),
    reached: computeCoverage(graph).reached,
  };
}

export interface StructuralDiffOptions {
  /** The already-scanned head graph, when the caller has one. */
  headGraph?: Graph;
  headRevision?: string | null;
  /** Repository name for tier classification and unit detection. */
  repository?: string;
}

/**
 * Diff the graph at `base` against the head graph.
 *
 * The base graph is scanned from a detached temporary worktree so the existing pipeline
 * produces it unchanged. The worktree is removed in a `finally`, even when the scan or the
 * context read throws, and it is created under the OS temp directory, never inside the
 * scanned tree. A resolved base whose scan fails is `base-scan-failed`, not an empty diff.
 */
export async function computeStructuralDiff(
  root: string,
  base: string,
  options: StructuralDiffOptions = {},
): Promise<StructuralDiffResult> {
  if (!base.trim() || !isSafeRevision(base)) {
    return { available: false, reason: 'unknown-revision', detail: `Unknown revision "${base}".` };
  }

  let baseRevision: string;
  try {
    baseRevision = (await git(root, ['rev-parse', '--verify', `${base}^{commit}`])).trim();
  } catch (error) {
    return classifyGitFailure(error, base);
  }
  if (!baseRevision) {
    return { available: false, reason: 'unknown-revision', detail: `Unknown revision "${base}".` };
  }

  const repository = options.repository ?? path.basename(root);
  let headGraph: Graph;
  let headRevision: string | null;
  if (options.headGraph) {
    headGraph = options.headGraph;
    headRevision = options.headRevision ?? null;
  } else {
    const cached = await getCachedGraph(root);
    headGraph = cached.report.graph;
    headRevision = revisionFromFingerprint(cached.fingerprint);
  }

  const key = `${path.resolve(root)}\u0000${baseRevision}`;
  let baseState = baseGraphs.get(key);
  const cachedHit = baseState !== undefined;
  if (!baseState) {
    const materialized = await materializeBaseGraph(root, baseRevision, repository);
    if (!materialized.available) {
      return materialized;
    }
    baseState = { graph: materialized.graph, context: materialized.context };
    baseGraphs.set(key, baseState);
    if (baseGraphs.size > BASE_CACHE_LIMIT) {
      baseGraphs.delete(baseGraphs.keys().next().value as string);
    }
  }

  const headContext = structuralContext(root, repository, headGraph);
  const diff = diffGraphs(baseState.graph, headGraph, baseState.context, headContext);
  return { available: true, base, baseRevision, headRevision, diff, cached: cachedHit };
}

/* ------------------------------------------------------------------ Base worktree */

type MaterializedBase =
  | { available: true; graph: Graph; context: StructuralContext }
  | { available: false; reason: StructuralUnavailableReason; detail?: string };

async function materializeBaseGraph(
  root: string,
  baseRevision: string,
  repository: string,
): Promise<MaterializedBase> {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-base-'));
  const worktree = path.join(parent, 'worktree');
  let added = false;
  try {
    await git(root, ['worktree', 'add', '--detach', worktree, baseRevision]);
    added = true;
    const report = await scanRepository(worktree);
    const context = structuralContext(worktree, repository, report.graph);
    return { available: true, graph: report.graph, context };
  } catch (error) {
    return {
      available: false,
      reason: 'base-scan-failed',
      detail: firstLine(error),
    };
  } finally {
    if (added) {
      try {
        await git(root, ['worktree', 'remove', '--force', worktree]);
      } catch {
        // Fall through to a direct removal; the prune below forgets the metadata.
      }
    }
    try {
      fs.rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Best effort: the path is under the OS temp directory.
    }
    try {
      await git(root, ['worktree', 'prune']);
    } catch {
      // Pruning is cleanup; a failure does not change the diff.
    }
  }
}

/* ------------------------------------------------------------------ Helpers */

/** A real dependency edge: not a `declare`, not a self-loop. */
function dependencyEdges(graph: Graph) {
  return graph.edges.filter((edge) => edge.source !== edge.target && edge.role !== 'declare');
}

function edgeKey(edge: { source: string; target: string; kind: string }): string {
  return `${edge.source}\u0000${edge.target}\u0000${edge.kind}`;
}

function toStructuralEdge(edge: { source: string; target: string; kind: string }): StructuralEdge {
  return { source: edge.source, target: edge.target, kind: edge.kind };
}

function compareEdge(a: StructuralEdge, b: StructuralEdge): number {
  return a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.kind.localeCompare(b.kind);
}

function cycleKey(cycle: StructuralCycle): string {
  return cycle.members.join('\u0000');
}

function compareCycle(a: StructuralCycle, b: StructuralCycle): number {
  return a.id.localeCompare(b.id) || cycleKey(a).localeCompare(cycleKey(b));
}

function cycleMap(groups: readonly CycleGroup[]): Map<string, StructuralCycle> {
  const map = new Map<string, StructuralCycle>();
  for (const group of groups) {
    const cycle = { id: group.id, members: [...group.members] };
    map.set(cycleKey(cycle), cycle);
  }
  return map;
}

function toStructuralTierEdge(direction: TierDirection): StructuralTierEdge {
  return {
    unit: direction.unit,
    source: direction.source,
    target: direction.target,
    kind: direction.kind,
  };
}

function tierEdgeKey(edge: StructuralTierEdge): string {
  return `${edge.unit}\u0000${edge.source}\u0000${edge.target}\u0000${edge.kind}`;
}

function compareTierEdge(a: StructuralTierEdge, b: StructuralTierEdge): number {
  return (
    a.unit.localeCompare(b.unit) ||
    a.source.localeCompare(b.source) ||
    a.target.localeCompare(b.target) ||
    a.kind.localeCompare(b.kind)
  );
}

/* ------------------------------------------------------------------ Git */

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

function classifyGitFailure(error: unknown, ref: string): StructuralDiffResult {
  const message = error instanceof Error ? error.message : String(error);
  if (/not a git repository|dubious ownership|not inside a Git working tree/i.test(message)) {
    return { available: false, reason: 'no-git', detail: firstLine(error) };
  }
  if (/unknown revision|bad revision|ambiguous argument|does not have any commits|Needed a single revision/i.test(message)) {
    return { available: false, reason: 'unknown-revision', detail: `Unknown revision "${ref}".` };
  }
  return { available: false, reason: 'git-error', detail: firstLine(error) };
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}
