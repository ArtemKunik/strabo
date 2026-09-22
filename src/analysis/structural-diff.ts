import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { cacheRoot, getCachedGraph } from '../cache/graph-cache.ts';
import { scanJsTsCalls } from '../scan/calls.ts';
import { detectEntryPoints } from '../scan/entry-points.ts';
import { classifyExclusion, excludedDirectory, looksMinified } from '../scan/exclusions.ts';
import { collectPolyglotExternalImports } from '../scan/external-polyglot.ts';
import { scanJsTsEdges } from '../scan/scan-js.ts';
import { isPolyglotSource, scanPolyglotEdges } from '../scan/scan-polyglot.ts';
import { countLines, directoryOf, isSourceExtension, isTestLike } from '../scan/scan.ts';
import { revisionFromFingerprint } from '../status.ts';
import type { Diagnostic, Exclusion, Graph } from '../types.ts';
import { computeCoverage } from './coverage.ts';
import { computeCycles, type CycleGroup } from './cycles.ts';
import { contentAtRevision } from './git-content.ts';
import { isSafeRevision } from './impact.ts';
import { buildTierReport, type TierDirection } from './tiers.ts';

const run = promisify(execFile);

/**
 * The structural change between two revisions, read from the two graphs rather than the
 * text diff: which dependency edges, cycles, wrong-way tier edges, entry points, and test
 * reach appeared or disappeared.
 *
 * `diffGraphs` is pure. `computeStructuralDiff` is the one caller that needs a second
 * graph: the base graph is scanned from the blobs at its commit (`git show <rev>:<path>`,
 * never a working-tree checkout), cached in memory, and persisted on disk keyed by the
 * resolved commit. A base that cannot be read is reported `unavailable`, never as an empty
 * diff.
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

/** Bump when the cached graph/context shape changes. */
export const REVISION_GRAPH_VERSION = 'revision-graph-1';
/** Bounded, in-memory base graphs. Building a revision's graph is the expensive part. */
const BASE_CACHE_LIMIT = 4;
/** Bounded entries per repository in the persisted store. */
const REVISION_DISK_LIMIT = 20;

interface RevisionGraphState {
  graph: Graph;
  context: StructuralContext;
}

/** Where a revision graph came from, so a caller can tell a cache hit from a build. */
export type RevisionGraphSource = 'memory' | 'disk' | 'build';

export interface RevisionGraphResult extends RevisionGraphState {
  source: RevisionGraphSource;
}

const baseGraphs = new Map<string, RevisionGraphState>();

interface RevisionStore {
  get(key: string): RevisionGraphState | null;
  set(key: string, value: RevisionGraphState): void;
}

const revisionStores = new Map<string, RevisionStore>();

/** Drop the base-graph caches (memory and parsed disk stores); tests call this between cases. */
export function clearStructuralDiffCache(): void {
  baseGraphs.clear();
  revisionStores.clear();
}

/** Path of the persisted revision-graph store for a root. Exposed for diagnostics and tests. */
export function revisionGraphCachePath(root: string): string {
  const key = path.resolve(root);
  return path.join(
    cacheRoot(),
    `strabo-${REVISION_GRAPH_VERSION}-${createHash('sha256').update(key).digest('hex').slice(0, 16)}.json`,
  );
}

/**
 * The persisted, commit-keyed store beside the graph cache, per repository root.
 *
 * Graphs never change once a commit exists, so an entry is keyed by the resolved commit
 * hash (and the repository name, which the context depends on). The file is rewritten
 * atomically on each new entry; the oldest entries are dropped past the limit. A missing,
 * unreadable, or wrong-version file starts empty, and a malformed entry is ignored rather
 * than trusted.
 */
function revisionStore(root: string): RevisionStore {
  const rootKey = path.resolve(root);
  const existing = revisionStores.get(rootKey);
  if (existing) return existing;

  const file = revisionGraphCachePath(rootKey);
  let entries: Record<string, RevisionGraphState> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      version?: string;
      entries?: Record<string, RevisionGraphState>;
    };
    if (parsed.version === REVISION_GRAPH_VERSION && parsed.entries && typeof parsed.entries === 'object') {
      entries = parsed.entries;
    }
  } catch {
    // Missing or unreadable: start empty.
  }

  const store: RevisionStore = {
    get(key) {
      const entry = entries[key];
      if (!entry || !Array.isArray(entry.graph?.nodes) || !Array.isArray(entry.graph?.edges) || !entry.context) {
        return null;
      }
      return entry;
    },
    set(key, value) {
      entries[key] = value;
      const keys = Object.keys(entries);
      for (const stale of keys.slice(0, Math.max(0, keys.length - REVISION_DISK_LIMIT))) delete entries[stale];
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({ version: REVISION_GRAPH_VERSION, entries }));
        fs.renameSync(temporary, file);
      } catch {
        // The cache is an optimisation; a write failure keeps the in-memory entry.
      }
    },
  };
  revisionStores.set(rootKey, store);
  return store;
}

/**
 * The graph and structural context at a resolved commit, from memory then disk, or built
 * from the blobs at that commit. `source` tells a caller which tier answered, so a test can
 * prove a cache hit without counting subprocesses.
 *
 * `commit` is the canonical commit hash `computeStructuralDiff` resolves with
 * `rev-parse <ref>^{commit}`; the cache key must not be a movable ref like `HEAD`.
 */
export async function revisionGraph(
  root: string,
  commit: string,
  repository: string,
): Promise<RevisionGraphResult> {
  const memoryKey = `${path.resolve(root)}\u0000${repository}\u0000${commit}`;
  const inMemory = baseGraphs.get(memoryKey);
  if (inMemory) {
    // Refresh the LRU position.
    baseGraphs.delete(memoryKey);
    baseGraphs.set(memoryKey, inMemory);
    return { ...inMemory, source: 'memory' };
  }

  const store = revisionStore(root);
  const diskKey = `${repository}\u0000${commit}`;
  const onDisk = store.get(diskKey);
  if (onDisk) {
    rememberRevisionGraph(memoryKey, onDisk);
    return { ...onDisk, source: 'disk' };
  }

  const built = await buildRevisionGraph(root, commit, repository);
  rememberRevisionGraph(memoryKey, built);
  store.set(diskKey, built);
  return { ...built, source: 'build' };
}

function rememberRevisionGraph(key: string, state: RevisionGraphState): void {
  baseGraphs.set(key, state);
  if (baseGraphs.size > BASE_CACHE_LIMIT) {
    baseGraphs.delete(baseGraphs.keys().next().value as string);
  }
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
 * The base graph is built from the committed blobs at the resolved commit
 * (`git show <rev>:<path>`), so the working tree is never checked out or written. The
 * graph is cached in memory (LRU) and persisted on disk, both keyed by the resolved commit
 * hash. A base whose blobs or graph cannot be read is `base-scan-failed`, not an empty diff.
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

  let baseState: RevisionGraphState;
  let cachedHit: boolean;
  try {
    const resolved = await revisionGraph(root, baseRevision, repository);
    baseState = resolved;
    cachedHit = resolved.source !== 'build';
  } catch (error) {
    return { available: false, reason: 'base-scan-failed', detail: firstLine(error) };
  }

  const headContext = structuralContext(root, repository, headGraph);
  const diff = diffGraphs(baseState.graph, headGraph, baseState.context, headContext);
  return { available: true, base, baseRevision, headRevision, diff, cached: cachedHit };
}

/* ------------------------------------------------------------------ Revision blobs */

/** Concurrent `git show` reads: enough to hide process latency without a spawn storm. */
const REVISION_READ_CONCURRENCY = 8;

/**
 * Build a revision's graph from its committed blobs, reading each source file with
 * `git show <rev>:<path>`. The working tree is never checked out or written. The recorded
 * facts the diff needs (tier edges, entry points, test reach) come from `structuralContext`,
 * as on the head side.
 */
async function buildRevisionGraph(
  root: string,
  commit: string,
  repository: string,
): Promise<RevisionGraphState> {
  const files = await listRevisionFiles(root, commit);
  const contentByFile = await readRevisionContents(root, commit, files);
  const retained = [...contentByFile.keys()].sort();
  const graph = await assembleRevisionGraph(root, retained, contentByFile);
  return { graph, context: structuralContext(root, repository, graph) };
}

/** The tracked source files at a commit, minus what the working-tree walk would exclude. */
async function listRevisionFiles(root: string, commit: string): Promise<string[]> {
  const stdout = await git(root, ['ls-tree', '-r', '--name-only', '-z', commit]);
  const files: string[] = [];
  for (const file of stdout.split('\0')) {
    if (!file || !isSourceExtension(file) || revisionExclusion(file)) continue;
    files.push(file);
  }
  return files.sort();
}

/** The exclusion the working-tree walk would apply to a tracked path, if any. */
function revisionExclusion(file: string): Exclusion | null {
  const segments = file.split('/');
  for (let depth = 1; depth < segments.length; depth += 1) {
    const pruned = excludedDirectory(segments.slice(0, depth).join('/'));
    if (pruned) return { path: file, reason: pruned.reason, detail: pruned.detail };
  }
  return classifyExclusion(file);
}

/** Read a revision's files through `git show`, bounded and skipping minified blobs. */
async function readRevisionContents(
  root: string,
  commit: string,
  files: readonly string[],
): Promise<Map<string, string>> {
  const contentByFile = new Map<string, string>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < files.length) {
      const file = files[cursor];
      cursor += 1;
      if (file === undefined) return;
      const content = await contentAtRevision(root, commit, file);
      if (content === null || looksMinified(content)) continue;
      contentByFile.set(file, content);
    }
  };
  const workers = Array.from(
    { length: Math.min(REVISION_READ_CONCURRENCY, files.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return contentByFile;
}

/**
 * Nodes and edges for a revision, from the same extractors `scanRepository` runs. Only the
 * manifest/config reads that feed entry detection and alias resolution stay on the working
 * tree, since the extractors have no injectable manifest source.
 */
async function assembleRevisionGraph(
  root: string,
  files: readonly string[],
  contentByFile: ReadonlyMap<string, string>,
): Promise<Graph> {
  const entryByFile = new Map(detectEntryPoints(root, files).map((entry) => [entry.file, entry.reason]));
  const nodes: Graph['nodes'] = files.map((id) => ({
    id,
    kind: isTestLike(id) ? 'test' : entryByFile.has(id) ? 'entry' : 'module',
    directory: directoryOf(id),
    ...(entryByFile.has(id) ? { entryReason: entryByFile.get(id) as string } : {}),
    lines: countLines(contentByFile.get(id) as string),
  }));

  const [jsScan, polyglot, calls] = await Promise.all([
    scanJsTsEdges(files, contentByFile, { root }),
    scanPolyglotEdges(files.filter(isPolyglotSource), contentByFile),
    scanJsTsCalls(files, contentByFile, { root }),
  ]);

  const diagnostics: Diagnostic[] = [...jsScan.diagnostics, ...polyglot.diagnostics];
  const externalImports = [
    ...jsScan.externalImports,
    ...collectPolyglotExternalImports(files, contentByFile, diagnostics),
  ];

  return {
    nodes,
    edges: [...jsScan.edges, ...polyglot.edges, ...calls.edges],
    diagnostics,
    excluded: [],
    externalImports,
  };
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
