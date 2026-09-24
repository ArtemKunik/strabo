import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { assertReadable } from '../boundary/repository-root.ts';
import { cacheRoot } from '../cache/graph-cache.ts';
import { symbolExtractorFor } from '../scan/languages/registry.ts';
import { isResolvedPolyglotLanguage } from '../scan/languages/resolvers.ts';
import { countLines, isSourceExtension } from '../scan/scan.ts';
import { scanJsTsEdges } from '../scan/scan-js.ts';
import { languageOf, scanPolyglotEdges } from '../scan/scan-polyglot.ts';
import type { GraphEdge } from '../types.ts';
import { computeMemberCohesion } from './file-health.ts';
import { buildFunctions } from './functions.ts';
import { isSafeRevision } from './impact.ts';
import { parseNameStatus } from './review.ts';
import type { ReviewFile, ReviewStatus } from './review-types.ts';
import type { TimelineCommit } from './timeline.ts';

const run = promisify(execFile);

/**
 * Quantitative change impact: what a change set does to complexity and coupling.
 *
 * Each changed file is measured on both sides of the change. Complexity comes from the
 * function metrics the symbol extractor records (the cyclomatic proxy summed per file);
 * coupling comes from re-resolving the file's own imports against the file set of that
 * side, so fan-out before and after is exact. Fan-in is reported as a delta only: it moves
 * when a changed file starts or stops importing a target, and that is all a change set can
 * prove without rescanning the whole repository at the baseline.
 *
 * A measure a side cannot provide is `null` and named in `note`, never scored as zero.
 */

/** Bump when a measure's meaning or the cached shape changes. */
export const CHANGE_METRICS_VERSION = 'change-metrics-2';
const MAX_FILES = 40;
const MAX_BYTES = 2 * 1024 * 1024;
/** Other same-language files a polyglot resolver may read to resolve one side. */
const MAX_POLYGLOT_CONTEXT = 400;
const MEASURE_CACHE_LIMIT = 4000;
const COMMIT_CACHE_LIMIT = 500;

/** Size and complexity of one side of a file. */
export interface FileMeasures {
  lines: number;
  /** Null when no symbol extractor covers the language. */
  functions: number | null;
  /** Sum of per-function decision points (each starts at 1). */
  complexity: number | null;
  /** The most complex single function. */
  maxComplexity: number | null;
  maxNesting: number | null;
  /** Deterministic function signals (long, deeply nested, loop scans, …). */
  signals: number | null;
  /** Member cohesion from recorded wiring; null when the language records no access. */
  cohesion: number | null;
}

/** One function whose complexity moved. */
export interface FunctionDelta {
  name: string;
  owner: string;
  before: number | null;
  after: number | null;
}

export interface FileMetricDelta {
  path: string;
  previousPath?: string;
  status: ReviewStatus;
  before: FileMeasures | null;
  after: FileMeasures | null;
  /** Distinct in-repository import targets on each side; null when not resolvable. */
  fanOut: { before: number; after: number } | null;
  /** Targets this file started or stopped importing. */
  importsAdded: string[];
  importsRemoved: string[];
  /** Change-set files that started (positive) or stopped (negative) importing this one. */
  fanInDelta: number;
  /**
   * Complexity gained and shed across the file's functions. A refactor that moves branching
   * from one function to another shows on both sides even when the file total is flat.
   */
  complexityChange: { added: number; removed: number } | null;
  /** Functions whose complexity changed, largest move first (at most 20). */
  functions: FunctionDelta[];
  note?: string;
}

export interface MetricTotals {
  files: number;
  /** Files with a complexity measure on at least one side. */
  measured: number;
  /** Totals per side, and complexity gained and shed across changed functions. */
  complexity: { before: number; after: number; added: number; removed: number };
  functions: { before: number; after: number };
  signals: { before: number; after: number };
  lines: { before: number; after: number };
  /** Import edges the change set added or removed across all changed files. */
  coupling: { added: number; removed: number };
}

export interface ChangeMetrics {
  available: true;
  kind: 'commit' | 'working-tree' | 'range';
  /** Resolved commit hash, for commit metrics; the tip, for range metrics. */
  ref?: string;
  /** The revision the change set is compared against; null for a root commit. */
  baseline: string | null;
  files: FileMetricDelta[];
  totals: MetricTotals;
  /** True when more files changed than were measured. */
  capped: boolean;
  /** True when the result came from the commit cache. */
  cached?: boolean;
}

export type ChangeMetricsResult =
  | ChangeMetrics
  | { available: false; reason: 'no-git' | 'git-error' | 'unknown-revision'; detail?: string };

export interface MetricsHistoryEntry {
  commit: TimelineCommit;
  totals: MetricTotals | null;
  capped: boolean;
  detail?: string;
}

/* ------------------------------------------------------------------ Entry points */

/** Metrics for a commit's own changes, against its first parent. Cached by commit hash. */
export async function computeCommitMetrics(root: string, ref: string): Promise<ChangeMetricsResult> {
  if (!ref.trim() || !isSafeRevision(ref)) {
    return { available: false, reason: 'unknown-revision', detail: `Unknown revision "${ref}".` };
  }
  let hash: string;
  let parent: string | null;
  try {
    const { stdout } = await run('git', ['show', '-s', '--format=%H%x1f%P', ref], { cwd: root });
    const [resolved = '', parents = ''] = (stdout.split('\n')[0] ?? '').split('\u001f');
    if (!resolved) {
      return { available: false, reason: 'unknown-revision', detail: `Unknown revision "${ref}".` };
    }
    hash = resolved;
    parent = parents.trim().split(/\s+/).filter(Boolean)[0] ?? null;
  } catch (error) {
    return gitFailure(error, ref);
  }

  const store = commitStore(root);
  const hit = store.get(hash);
  if (hit) {
    return { ...hit, cached: true };
  }

  try {
    const nameStatus = await git(root, ['show', '--first-parent', '--format=', '--name-status', '-z', '-M', hash]);
    const result = await measureRevisions(root, parseNameStatus(nameStatus), parent, hash, 'commit');
    store.set(hash, result);
    return result;
  } catch (error) {
    return gitFailure(error, ref);
  }
}

/**
 * Metrics for everything between two revisions, `from` exclusive and `to` inclusive: a
 * branch measured from its merge base. Both must already be resolved commit hashes.
 * Not cached, since a range is rarely asked for twice at the same pair of tips.
 */
export async function computeRangeMetrics(root: string, from: string, to: string): Promise<ChangeMetricsResult> {
  if (!isSafeRevision(from) || !isSafeRevision(to)) {
    return { available: false, reason: 'unknown-revision', detail: `Unknown revision "${from}..${to}".` };
  }
  try {
    const nameStatus = await git(root, ['diff', '--name-status', '-z', '-M', from, to]);
    return await measureRevisions(root, parseNameStatus(nameStatus), from, to, 'range');
  } catch (error) {
    return gitFailure(error, `${from}..${to}`);
  }
}

/** Measure a change set whose two sides are both recorded revisions. */
async function measureRevisions(
  root: string,
  changes: ReturnType<typeof parseNameStatus>,
  before: string | null,
  after: string,
  kind: 'commit' | 'range',
): Promise<ChangeMetrics> {
  const [beforeFiles, afterFiles] = await Promise.all([
    before ? listTree(root, before) : Promise.resolve(new Set<string>()),
    listTree(root, after),
  ]);
  const measured = changes.slice(0, MAX_FILES);
  const blobs = await readBlobs(root, [
    ...(before ? measured.filter((c) => c.status !== 'added').map((c) => `${before}:${c.previousPath ?? c.path}`) : []),
    ...measured.filter((c) => c.status !== 'deleted').map((c) => `${after}:${c.path}`),
  ]);
  const sides: ChangeSide[] = measured.map((change) => ({
    path: change.path,
    ...(change.previousPath ? { previousPath: change.previousPath } : {}),
    status: change.status,
    before: before && change.status !== 'added' ? (blobs.get(`${before}:${change.previousPath ?? change.path}`) ?? null) : null,
    after: change.status === 'deleted' ? null : (blobs.get(`${after}:${change.path}`) ?? null),
  }));
  return measureChangeSet(root, sides, beforeFiles, afterFiles, {
    kind,
    ref: after,
    baseline: before,
    capped: changes.length > measured.length,
  });
}

/**
 * Metrics for the working tree against HEAD. The review's files are reused so staged,
 * unstaged, and untracked changes are one change set; a path in two groups counts once.
 */
export async function computeWorkingTreeMetrics(
  root: string,
  files: readonly ReviewFile[],
): Promise<ChangeMetricsResult> {
  try {
    let head: string | null = null;
    try {
      head = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])).trim() || null;
    } catch {
      head = null;
    }
    // A path staged and then edited again keeps its staged status (an added file is still
    // new against HEAD); a later deletion in the tree wins, since nothing is left to read.
    const unique = new Map<string, ReviewFile>();
    for (const file of files) {
      if (!unique.has(file.path) || file.status === 'deleted') unique.set(file.path, file);
    }
    const changes = [...unique.values()];
    const measured = changes.slice(0, MAX_FILES);
    const beforeFiles = head ? await listTree(root, head) : new Set<string>();
    const afterFiles = new Set(beforeFiles);
    for (const change of changes) {
      if (change.previousPath && change.status === 'renamed') afterFiles.delete(change.previousPath);
      if (change.status === 'deleted') afterFiles.delete(change.path);
      else if (isSourceExtension(change.path)) afterFiles.add(change.path);
    }
    const blobs = head
      ? await readBlobs(
          root,
          measured
            .filter((c) => c.status !== 'added' && c.status !== 'untracked')
            .map((c) => `${head}:${c.previousPath ?? c.path}`),
        )
      : new Map<string, string | null>();
    const sides: ChangeSide[] = measured.map((change) => ({
      path: change.path,
      ...(change.previousPath ? { previousPath: change.previousPath } : {}),
      status: change.status,
      before:
        head && change.status !== 'added' && change.status !== 'untracked'
          ? (blobs.get(`${head}:${change.previousPath ?? change.path}`) ?? null)
          : null,
      after: change.status === 'deleted' ? null : readWorkingFile(root, change.path),
    }));
    return await measureChangeSet(root, sides, beforeFiles, afterFiles, {
      kind: 'working-tree',
      baseline: head ? 'HEAD' : null,
      capped: changes.length > measured.length,
    });
  } catch (error) {
    return gitFailure(error, 'HEAD');
  }
}

/**
 * Change metric totals for recent commits, newest first. Each commit is served from the
 * commit cache when present, so a second request for the same history reads no blobs.
 */
export async function computeMetricsHistory(
  root: string,
  commits: readonly TimelineCommit[],
): Promise<MetricsHistoryEntry[]> {
  const entries: MetricsHistoryEntry[] = [];
  for (const commit of commits) {
    const result = await computeCommitMetrics(root, commit.hash);
    entries.push(
      result.available
        ? { commit, totals: result.totals, capped: result.capped }
        : { commit, totals: null, capped: false, ...(result.detail ? { detail: result.detail } : {}) },
    );
  }
  return entries;
}

/* ------------------------------------------------------------------ Measurement */

interface ChangeSide {
  path: string;
  previousPath?: string;
  status: ReviewStatus;
  before: string | null;
  after: string | null;
}

async function measureChangeSet(
  root: string,
  sides: readonly ChangeSide[],
  beforeFiles: Set<string>,
  afterFiles: Set<string>,
  meta: { kind: ChangeMetrics['kind']; ref?: string; baseline: string | null; capped: boolean },
): Promise<ChangeMetrics> {
  const beforeContent = new Map<string, string>();
  const afterContent = new Map<string, string>();
  for (const side of sides) {
    if (side.before !== null) beforeContent.set(side.previousPath ?? side.path, side.before);
    if (side.after !== null) afterContent.set(side.path, side.after);
  }

  const [beforeEdges, afterEdges] = [
    await importTargets(root, beforeContent, beforeFiles),
    await importTargets(root, afterContent, afterFiles),
  ];

  // Fan-in moves only through edges the change set itself added or removed.
  const fanInDelta = new Map<string, number>();
  const files: FileMetricDelta[] = [];
  for (const side of sides) {
    const sourceBefore = side.previousPath ?? side.path;
    const [before, after] = await Promise.all([
      side.before === null ? null : measureContent(sourceBefore, side.before),
      side.after === null ? null : measureContent(side.path, side.after),
    ]);
    const targetsBefore = beforeEdges.targets.get(sourceBefore) ?? new Set<string>();
    const targetsAfter = afterEdges.targets.get(side.path) ?? new Set<string>();
    const resolvable = couplingMeasurable(side.path);
    const importsAdded = resolvable ? [...targetsAfter].filter((t) => !targetsBefore.has(t)).sort() : [];
    const importsRemoved = resolvable ? [...targetsBefore].filter((t) => !targetsAfter.has(t)).sort() : [];
    for (const target of importsAdded) fanInDelta.set(target, (fanInDelta.get(target) ?? 0) + 1);
    for (const target of importsRemoved) fanInDelta.set(target, (fanInDelta.get(target) ?? 0) - 1);

    const moved = functionDeltas(before?.functions ?? null, after?.functions ?? null);
    const notes: string[] = [];
    if (!symbolExtractorFor(side.path)) notes.push('no symbol extractor for this language');
    if (!resolvable) notes.push('imports are not resolved for this language');
    const skipped = beforeEdges.skipped.has(sourceBefore) || afterEdges.skipped.has(side.path);
    if (skipped) notes.push('too many same-language files to resolve imports');
    if (side.status !== 'added' && side.status !== 'untracked' && side.before === null && meta.baseline) {
      notes.push(`not readable in ${meta.baseline}`);
    }
    if (side.status !== 'deleted' && side.after === null) notes.push('reviewed copy is binary or unreadable');

    files.push({
      path: side.path,
      ...(side.previousPath ? { previousPath: side.previousPath } : {}),
      status: side.status,
      before: before?.measures ?? null,
      after: after?.measures ?? null,
      fanOut: resolvable && !skipped ? { before: targetsBefore.size, after: targetsAfter.size } : null,
      importsAdded,
      importsRemoved,
      fanInDelta: 0,
      complexityChange: complexityChurn(before?.measures ?? null, after?.measures ?? null, moved),
      functions: moved.slice(0, 20),
      ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
    });
  }
  for (const file of files) {
    file.fanInDelta = fanInDelta.get(file.path) ?? 0;
  }

  return {
    available: true,
    kind: meta.kind,
    ...(meta.ref ? { ref: meta.ref } : {}),
    baseline: meta.baseline,
    files,
    totals: totalsOf(files),
    capped: meta.capped,
  };
}

interface MeasuredContent {
  measures: FileMeasures;
  /** `owner\0name` -> decision points, for per-function deltas. */
  functions: Record<string, number>;
}

const measureCache = new Map<string, MeasuredContent>();

/** Drop cached measures and commit results; tests call this between cases. */
export function clearChangeMetricsCache(): void {
  measureCache.clear();
  commitStores.clear();
}

/** Measure one side of a file. Keyed by content, so identical blobs are measured once. */
async function measureContent(file: string, content: string): Promise<MeasuredContent> {
  const extractor = symbolExtractorFor(file);
  const key = createHash('sha256')
    .update(`${CHANGE_METRICS_VERSION}\0${extractor?.language ?? path.extname(file)}\0`)
    .update(content)
    .digest('hex');
  const hit = measureCache.get(key);
  if (hit) {
    measureCache.delete(key);
    measureCache.set(key, hit);
    return hit;
  }

  const lines = countLines(content);
  let measured: MeasuredContent = {
    measures: { lines, functions: null, complexity: null, maxComplexity: null, maxNesting: null, signals: null, cohesion: null },
    functions: {},
  };
  if (extractor) {
    try {
      const result = await extractor.extract(file, content);
      const report = buildFunctions(file, result.symbols, result.calls ?? []);
      let complexity = 0;
      let maxComplexity = 0;
      let maxNesting = 0;
      let signals = 0;
      const functions: Record<string, number> = {};
      for (const fn of report.functions) {
        signals += fn.signals.length;
        if (!fn.metrics) continue;
        complexity += fn.metrics.decisionPoints;
        maxComplexity = Math.max(maxComplexity, fn.metrics.decisionPoints);
        maxNesting = Math.max(maxNesting, fn.metrics.maxNestingDepth);
        const id = `${fn.owner}\0${fn.name}`;
        // Overloads share a name; their complexity is summed under it.
        functions[id] = (functions[id] ?? 0) + fn.metrics.decisionPoints;
      }
      // The model reports cohesion unavailable when a language records members but no methods
      // to wire them (SQL columns, a data-only class), so no `tracksAccess` guard is needed.
      const cohesion = computeMemberCohesion(result.symbols, result.accesses ?? []).value;
      measured = {
        measures: {
          lines,
          functions: report.functions.length,
          complexity,
          maxComplexity,
          maxNesting,
          signals,
          cohesion,
        },
        functions,
      };
    } catch {
      // A parse failure leaves only the line count; complexity stays unmeasured.
    }
  }

  measureCache.set(key, measured);
  if (measureCache.size > MEASURE_CACHE_LIMIT) {
    measureCache.delete(measureCache.keys().next().value as string);
  }
  return measured;
}

function functionDeltas(
  before: Record<string, number> | null,
  after: Record<string, number> | null,
): FunctionDelta[] {
  const ids = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const deltas: FunctionDelta[] = [];
  for (const id of ids) {
    const b = before?.[id] ?? null;
    const a = after?.[id] ?? null;
    if (b === a) continue;
    const [owner = '', name = ''] = id.split('\0');
    deltas.push({ name, owner, before: b, after: a });
  }
  return deltas.sort(
    (x, y) => Math.abs((y.after ?? 0) - (y.before ?? 0)) - Math.abs((x.after ?? 0) - (x.before ?? 0)) || x.name.localeCompare(y.name),
  );
}

function complexityChurn(
  before: FileMeasures | null,
  after: FileMeasures | null,
  moved: readonly FunctionDelta[],
): FileMetricDelta['complexityChange'] {
  if (before?.complexity == null && after?.complexity == null) return null;
  let added = 0;
  let removed = 0;
  for (const fn of moved) {
    const delta = (fn.after ?? 0) - (fn.before ?? 0);
    if (delta > 0) added += delta;
    else removed -= delta;
  }
  return { added, removed };
}

function totalsOf(files: readonly FileMetricDelta[]): MetricTotals {
  const totals: MetricTotals = {
    files: files.length,
    measured: 0,
    complexity: { before: 0, after: 0, added: 0, removed: 0 },
    functions: { before: 0, after: 0 },
    signals: { before: 0, after: 0 },
    lines: { before: 0, after: 0 },
    coupling: { added: 0, removed: 0 },
  };
  for (const file of files) {
    totals.lines.before += file.before?.lines ?? 0;
    totals.lines.after += file.after?.lines ?? 0;
    totals.coupling.added += file.importsAdded.length;
    totals.coupling.removed += file.importsRemoved.length;
    if (!file.complexityChange) continue;
    totals.measured += 1;
    totals.complexity.before += file.before?.complexity ?? 0;
    totals.complexity.after += file.after?.complexity ?? 0;
    totals.complexity.added += file.complexityChange.added;
    totals.complexity.removed += file.complexityChange.removed;
    totals.functions.before += file.before?.functions ?? 0;
    totals.functions.after += file.after?.functions ?? 0;
    totals.signals.before += file.before?.signals ?? 0;
    totals.signals.after += file.after?.signals ?? 0;
  }
  return totals;
}

/* ------------------------------------------------------------------ Coupling */

function couplingMeasurable(file: string): boolean {
  if (!isSourceExtension(file)) return false;
  const language = languageOf(file);
  return language === undefined || isResolvedPolyglotLanguage(language);
}

/**
 * Resolve the given files' imports against one side's file set and return each file's
 * distinct `use` targets. JS/TS resolves per file; a polyglot language resolves over its
 * whole file set, so the other same-language files are read from the working tree as an
 * approximation of that side (bounded, and reported as skipped past the bound).
 */
async function importTargets(
  root: string,
  content: ReadonlyMap<string, string>,
  fileSet: Set<string>,
): Promise<{ targets: Map<string, Set<string>>; skipped: Set<string> }> {
  const targets = new Map<string, Set<string>>();
  const skipped = new Set<string>();
  if (content.size === 0) return { targets, skipped };

  const files = [...new Set([...fileSet, ...content.keys()])].sort();
  const edges: GraphEdge[] = [];
  edges.push(...scanJsTsEdges(files, content, { root }).edges);

  const byLanguage = new Map<string, string[]>();
  for (const file of content.keys()) {
    const language = languageOf(file);
    if (!language || !isResolvedPolyglotLanguage(language)) continue;
    byLanguage.set(language, [...(byLanguage.get(language) ?? []), file]);
  }
  for (const [language, changed] of byLanguage) {
    const peers = files.filter((file) => languageOf(file) === language);
    if (peers.length > MAX_POLYGLOT_CONTEXT) {
      for (const file of changed) skipped.add(file);
      continue;
    }
    const context = new Map(content);
    const readable: string[] = [];
    for (const peer of peers) {
      if (!context.has(peer)) {
        const text = readWorkingFile(root, peer);
        if (text === null) continue;
        context.set(peer, text);
      }
      readable.push(peer);
    }
    try {
      edges.push(...(await scanPolyglotEdges(readable, context)).edges);
    } catch {
      for (const file of changed) skipped.add(file);
    }
  }

  for (const edge of edges) {
    if (!content.has(edge.source) || edge.role === 'declare' || edge.source === edge.target) continue;
    const set = targets.get(edge.source) ?? new Set<string>();
    set.add(edge.target);
    targets.set(edge.source, set);
  }
  return { targets, skipped };
}

/* ------------------------------------------------------------------ Commit cache */

interface CommitStore {
  get(hash: string): ChangeMetrics | null;
  set(hash: string, value: ChangeMetrics): void;
}

const commitStores = new Map<string, CommitStore>();

/**
 * Commit metrics never change once computed, so they are keyed by commit hash and kept on
 * disk beside the graph cache, per repository root. The file is rewritten on each new
 * entry; the oldest entries are dropped past the limit.
 */
function commitStore(root: string): CommitStore {
  const key = path.resolve(root);
  const existing = commitStores.get(key);
  if (existing) return existing;

  const file = path.join(
    cacheRoot(),
    `strabo-${CHANGE_METRICS_VERSION}-${createHash('sha256').update(key).digest('hex').slice(0, 16)}.json`,
  );
  let entries: Record<string, ChangeMetrics> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string; entries?: Record<string, ChangeMetrics> };
    if (parsed.version === CHANGE_METRICS_VERSION && parsed.entries) entries = parsed.entries;
  } catch {
    // Missing or unreadable: start empty.
  }

  const store: CommitStore = {
    get: (hash) => entries[hash] ?? null,
    set(hash, value) {
      const { cached: _cached, ...stored } = value;
      entries[hash] = stored;
      const keys = Object.keys(entries);
      for (const stale of keys.slice(0, Math.max(0, keys.length - COMMIT_CACHE_LIMIT))) delete entries[stale];
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ version: CHANGE_METRICS_VERSION, entries }));
      } catch {
        // The cache is an optimisation; a write failure keeps the in-memory entry.
      }
    },
  };
  commitStores.set(key, store);
  return store;
}

/* ------------------------------------------------------------------ Git */

async function listTree(root: string, rev: string): Promise<Set<string>> {
  const stdout = await git(root, ['ls-tree', '-r', '--name-only', '-z', rev]);
  return new Set(stdout.split('\0').filter((file) => file !== '' && isSourceExtension(file)));
}

/**
 * Read many `rev:path` blobs through one `git cat-file --batch`, rather than a process per
 * file. A missing object, a binary blob, or one past the size bound reads as null.
 */
export function readBlobs(root: string, specs: readonly string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(specs)];
  const result = new Map<string, string | null>();
  if (unique.length === 0) return Promise.resolve(result);
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git cat-file exited with ${code}`));
        return;
      }
      const buffer = Buffer.concat(chunks);
      let offset = 0;
      for (const spec of unique) {
        const newline = buffer.indexOf(0x0a, offset);
        if (newline === -1) break;
        const header = buffer.subarray(offset, newline).toString('utf8');
        offset = newline + 1;
        const match = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
        if (!match) {
          result.set(spec, null);
          continue;
        }
        const size = Number(match[2]);
        const body = buffer.subarray(offset, offset + size);
        offset += size + 1;
        result.set(spec, match[1] !== 'blob' || size > MAX_BYTES || body.includes(0) ? null : body.toString('utf8'));
      }
      resolve(result);
    });
    // Paths are newline-terminated on stdin; a path containing a newline cannot be named.
    child.stdin.end(unique.map((spec) => spec.replace(/\n/g, '')).join('\n') + '\n');
  });
}

function readWorkingFile(root: string, file: string): string | null {
  try {
    const resolved = assertReadable(root, file);
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const content = fs.readFileSync(resolved);
    return content.includes(0) ? null : content.toString('utf8');
  } catch {
    return null;
  }
}

function gitFailure(error: unknown, ref: string): ChangeMetricsResult {
  const message = error instanceof Error ? error.message : String(error);
  const detail = message.split('\n')[0] ?? message;
  if (/not a git repository|dubious ownership/i.test(message)) return { available: false, reason: 'no-git', detail };
  if (/unknown revision|bad revision|ambiguous argument|does not have any commits/i.test(message)) {
    return { available: false, reason: 'unknown-revision', detail: `Unknown revision "${ref}".` };
  }
  return { available: false, reason: 'git-error', detail };
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}
