import type { Graph } from '../types.ts';
import { symbolExtractorFor, type SymbolExtractor } from '../scan/languages/registry.ts';
import type { CodeSymbol, FunctionCall } from '../scan/languages/symbols.ts';
import { buildAdjacency, reachableSize } from './analysis.ts';
import { computeTestReachByFile } from './coverage.ts';
import {
  fileCoverage,
  isUntested,
  summariseFileCoverage,
  UNDER_COVERED_THRESHOLD,
  type FileCoverage,
} from './file-coverage.ts';
import { buildFunctions, type FunctionEntry } from './functions.ts';
import type { MeasuredCoverageSummary } from './measured-coverage.ts';
import { contentAtRevision, readWorkingFile } from './git-content.ts';
import { FUNCTION_SIGNAL_LABELS, type FunctionSignal } from './signals.ts';
import type {
  ComplexitySummary,
  CoherenceSummary,
  FileImpactPassport,
  ImpactFunction,
  ImpactPassportSet,
  ImpactRisk,
  ImpactSignal,
  ImpactSnapshot,
  ImpactTotals,
  ReviewStatus,
  TieredImpact,
} from './review-types.ts';

export type {
  ComplexitySummary,
  CoherenceSummary,
  FileImpactPassport,
  ImpactFunction,
  ImpactPassportSet,
  ImpactRisk,
  ImpactSignal,
  ImpactSnapshot,
  ImpactTotals,
  RiskBand,
  SymbolReferences,
} from './review-types.ts';

/**
 * The Change impact passport: one file's current risk surface, plus the deltas a change
 * produced when a baseline is available.
 *
 * Every number is derived from a recorded fact — the graph (blast radius, importers,
 * imports), the symbol extractor (functions, metrics, signals, types), and Git (the
 * baseline content). A value a side cannot provide is `null` and named in `note`; nothing
 * is estimated from names or text.
 */

/** The normalisation caps behind the risk score. A value at or past its cap contributes 1. */
export const RISK_CAPS = {
  maxComplexity: 40,
  blastRadius: 50,
  signals: 5,
} as const;

/** How each normalised input is weighted. Kept explicit so the score is reproducible. */
export const RISK_WEIGHTS = {
  complexity: 0.4,
  blastRadius: 0.3,
  signals: 0.2,
  untested: 0.1,
} as const;

/** Score thresholds for the coarse band. */
export const RISK_BAND_THRESHOLDS = {
  critical: 85,
  high: 60,
  moderate: 30,
} as const;

const MAX_MOST_COMPLEX = 5;

/** Signals ordered most severe first, so a passport can rank the ones it shows. */
const SIGNAL_ORDER: string[] = [
  'high-complexity',
  'nested-loops',
  'deep-nesting',
  'linear-scan-in-loop',
  'sort-in-loop',
  'long-function',
  'many-parameters',
  'recursion',
];

/** The coarse band for a 0-100 score. */
export function riskBandFor(score: number): ImpactRisk['band'] {
  if (score >= RISK_BAND_THRESHOLDS.critical) return 'critical';
  if (score >= RISK_BAND_THRESHOLDS.high) return 'high';
  if (score >= RISK_BAND_THRESHOLDS.moderate) return 'moderate';
  return 'low';
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

/** The bounded risk score and its band, from the named inputs. */
export function computeRisk(inputs: ImpactRisk['inputs']): ImpactRisk {
  const cx = clamp01(inputs.maxComplexity / RISK_CAPS.maxComplexity);
  const blast = clamp01(inputs.blastRadius / RISK_CAPS.blastRadius);
  const signals = clamp01(inputs.signals / RISK_CAPS.signals);
  const untested = clamp01(inputs.untestedShare);
  const score = Math.round(
    100 *
      (RISK_WEIGHTS.complexity * cx +
        RISK_WEIGHTS.blastRadius * blast +
        RISK_WEIGHTS.signals * signals +
        RISK_WEIGHTS.untested * untested),
  );
  return { score, band: riskBandFor(score), inputs };
}

/** The parse-derived facts one side of a file contributes to a passport. */
export interface FileFunctionFacts {
  file: string;
  /** Every recorded function, with body metrics where the extractor read a body. */
  functions: FunctionEntry[];
  /** Declared types and how many members each owns. */
  types: Array<{ name: string; memberCount: number }>;
  /** `owner\0name` -> summed decision points; null for a signature without a body. */
  byId: Map<string, number | null>;
  /** Decision points of the most complex function; null when none was measured. */
  maxComplexity: number | null;
  /** Summed decision points over measured functions; null when none was measured. */
  sumComplexity: number | null;
  /** Measured function count. */
  measuredCount: number;
  /** Every recorded function count. */
  count: number;
  signals: FunctionSignal[];
}

/** Derive the passport facts for one parsed side of a file. */
export function functionFacts(file: string, symbols: readonly CodeSymbol[], calls: readonly FunctionCall[] = []): FileFunctionFacts {
  const report = buildFunctions(file, [...symbols], [...calls]);
  const functions = report.functions;
  let maxComplexity: number | null = null;
  let sumComplexity = 0;
  let measuredCount = 0;
  let signalCount = 0;
  const byId = new Map<string, number | null>();
  const signals: FunctionSignal[] = [];
  for (const fn of functions) {
    const id = `${fn.owner}\u0000${fn.name}`;
    const points = fn.metrics?.decisionPoints ?? null;
    const existing = byId.get(id);
    byId.set(id, points === null ? (existing ?? null) : (existing ?? 0) + points);
    signalCount += fn.signals.length;
    signals.push(...fn.signals);
    if (points === null) continue;
    measuredCount += 1;
    sumComplexity += points;
    maxComplexity = maxComplexity === null ? points : Math.max(maxComplexity, points);
  }

  const types: Array<{ name: string; memberCount: number }> = [];
  for (const symbol of symbols) {
    if (symbol.kind !== 'type') continue;
    const memberCount = symbols.filter((candidate) => candidate.owner === symbol.name || candidate.owner.startsWith(`${symbol.name}.`)).length;
    types.push({ name: symbol.name, memberCount });
  }

  return {
    file,
    functions,
    types,
    byId,
    maxComplexity,
    sumComplexity: measuredCount === 0 ? null : sumComplexity,
    measuredCount,
    count: functions.length,
    signals,
  };
}

/** The inputs `buildFileImpactPassport` needs, so both the review and file paths share it. */
export interface BuildPassportInput {
  path: string;
  previousPath?: string;
  status: ReviewStatus;
  snapshot: ImpactSnapshot;
  before: FileFunctionFacts | null;
  after: FileFunctionFacts | null;
  /** Functions the change touched: `owner` + `name`. */
  changedFunctions: ReadonlyArray<{ owner: string; name: string }>;
  /** Types the change touched. */
  changedTypes: ReadonlyArray<{ name: string }>;
  impact: TieredImpact | null;
  testsToRun: readonly string[];
  untestedDependents: readonly string[];
  /** How `untestedDependents` was decided; defaults to the reachability fallback. */
  untestedBasis?: 'measured' | 'reachable';
  /** This file's own coverage from one source; omitted for a hand-built card. */
  coverage?: FileCoverage | null;
  note?: string;
}

/** Compose the passport for one file from already-recorded facts. Pure. */
export function buildFileImpactPassport(input: BuildPassportInput): FileImpactPassport {
  const { snapshot } = input;
  const untestedShare = snapshot.directImporters === 0 ? 0 : clamp01(input.untestedDependents.length / snapshot.directImporters);
  const maxComplexity = input.after?.maxComplexity ?? input.before?.maxComplexity ?? 0;
  const risk = computeRisk({
    maxComplexity,
    blastRadius: snapshot.blastRadius,
    signals: input.after?.signals.length ?? 0,
    untestedShare,
    directImporters: snapshot.directImporters,
  });

  return {
    path: input.path,
    ...(input.previousPath ? { previousPath: input.previousPath } : {}),
    status: input.status,
    risk,
    complexity: complexitySummary(input.before, input.after),
    coherence: coherenceOf(input.changedFunctions, input.changedTypes, input.after),
    snapshot,
    signals: signalsOf(input.after),
    mostComplex: mostComplexOf(input.before, input.after),
    impact: input.impact,
    // The card's symbol-references row reads the same count the tier did, so the two never
    // disagree; a card whose tier could not be computed carries no row rather than a zero.
    ...(input.impact
      ? { symbolReferences: { total: input.impact.referenceCount, files: input.impact.definite.length } }
      : {}),
    testsToRun: [...input.testsToRun],
    untestedDependents: [...input.untestedDependents],
    untestedBasis: input.untestedBasis ?? 'reachable',
    coverage: input.coverage ?? null,
    ...(input.note ? { note: input.note } : {}),
  };
}

function average(facts: FileFunctionFacts | null): number | null {
  if (!facts || facts.measuredCount === 0 || facts.sumComplexity === null) return null;
  return Math.round((facts.sumComplexity / facts.measuredCount) * 10) / 10;
}

function complexitySummary(before: FileFunctionFacts | null, after: FileFunctionFacts | null): ComplexitySummary {
  let functionsUnchanged: number | null = null;
  if (before || after) {
    functionsUnchanged = 0;
    for (const [id] of after?.byId ?? before?.byId ?? []) {
      if (before?.byId.has(id) && after?.byId.has(id) && before.byId.get(id) === after.byId.get(id)) {
        functionsUnchanged += 1;
      }
    }
  }

  let classesUnchanged: number | null = null;
  if (before || after) {
    classesUnchanged = 0;
    for (const type of before?.types ?? []) {
      const match = after?.types.find((candidate) => candidate.name === type.name);
      if (match && match.memberCount === type.memberCount) {
        classesUnchanged += 1;
      }
    }
  }

  return {
    maxBefore: before?.maxComplexity ?? null,
    maxAfter: after?.maxComplexity ?? null,
    averageBefore: average(before),
    averageAfter: average(after),
    sumBefore: before?.sumComplexity ?? null,
    sumAfter: after?.sumComplexity ?? null,
    functionCountBefore: before?.count ?? null,
    functionCountAfter: after?.count ?? null,
    functionsUnchanged,
    classesUnchanged,
  };
}

/** Largest connected component of changed symbols over their count, as a 0-100 score. */
function coherenceOf(
  changedFunctions: ReadonlyArray<{ owner: string; name: string }>,
  changedTypes: ReadonlyArray<{ name: string }>,
  after: FileFunctionFacts | null,
): CoherenceSummary | null {
  const ids = new Set<string>();
  for (const fn of changedFunctions) ids.add(`${fn.owner}\u0000${fn.name}`);
  for (const type of changedTypes) ids.add(`\u0000${type.name}`);
  const count = ids.size;
  if (count === 0) return null;

  const parent = new Map<string, string>();
  for (const id of ids) parent.set(id, id);
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let current = id;
    while (parent.get(current) !== root) {
      const next = parent.get(current) as string;
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  for (const fn of after?.functions ?? []) {
    const from = `${fn.owner}\u0000${fn.name}`;
    if (!ids.has(from)) continue;
    for (const call of fn.calls) {
      for (const target of ids) {
        const separator = target.indexOf('\u0000');
        const targetName = separator >= 0 ? target.slice(separator + 1) : target;
        if (target !== from && targetName === call.name) union(from, target);
      }
    }
  }

  const sizes = new Map<string, number>();
  for (const id of ids) {
    const root = find(id);
    sizes.set(root, (sizes.get(root) ?? 0) + 1);
  }
  const largest = Math.max(0, ...sizes.values());
  const score = Math.round((100 * largest) / count);
  return { score, changedSymbols: count, detail: `${count} changed symbol(s); concentration heuristic` };
}

/** The distinct cost signals on the reviewed side, most severe first. */
function signalsOf(after: FileFunctionFacts | null): ImpactSignal[] {
  if (!after) return [];
  const seen = new Map<string, ImpactSignal>();
  for (const signal of after.signals) {
    if (seen.has(signal.kind)) continue;
    const label = FUNCTION_SIGNAL_LABELS[signal.kind] ?? signal.kind;
    const detail = signal.kind === 'high-complexity' ? `maximum C${after.maxComplexity ?? 0}` : signal.detail;
    seen.set(signal.kind, { kind: signal.kind, label, detail });
  }
  return [...seen.values()].sort((a, b) => rank(a.kind) - rank(b.kind));
}

function rank(kind: string): number {
  const index = SIGNAL_ORDER.indexOf(kind);
  return index === -1 ? SIGNAL_ORDER.length : index;
}

/** The most complex functions in the reviewed state, with their move from the baseline. */
function mostComplexOf(before: FileFunctionFacts | null, after: FileFunctionFacts | null): ImpactFunction[] {
  if (!after) return [];
  return after.functions
    .filter((fn) => fn.metrics)
    .map((fn) => {
      const points = fn.metrics?.decisionPoints ?? 0;
      const previous = before?.byId.get(`${fn.owner}\u0000${fn.name}`) ?? null;
      return {
        name: fn.name,
        owner: fn.owner,
        complexity: points,
        before: previous,
        delta: previous === null ? null : points - previous,
      };
    })
    .sort((a, b) => b.complexity - a.complexity || a.name.localeCompare(b.name))
    .slice(0, MAX_MOST_COMPLEX);
}

/** The current-graph counts for one file. `metrics` may be shared across a change set. */
export function snapshotFor(
  file: string,
  forward: ReadonlyMap<string, string[]>,
  backward: ReadonlyMap<string, string[]>,
  blastRadiusByFile: ReadonlyMap<string, number>,
): ImpactSnapshot {
  return {
    blastRadius: blastRadiusByFile.get(file) ?? 0,
    directImporters: (backward.get(file) ?? []).length,
    directImports: (forward.get(file) ?? []).length,
    // The maps the scanner hands in follow barrel re-exports (see `computeFileImpactPassport`
    // and `computeChangePassport`), so the passport says so rather than leaving it implicit.
    countsIncludeReExports: true,
  };
}

/** The current-state passport for one file, independent of any change. */
export async function computeFileImpactPassport(
  root: string,
  graph: Graph,
  file: string,
  measured: MeasuredCoverageSummary | null = null,
): Promise<FileImpactPassport> {
  const { forward, backward } = buildAdjacency(graph, { includeReExports: true });
  // Only this file's blast radius is needed, so it is one traversal rather than the whole
  // graph's transitive metric map.
  const snapshot = snapshotFor(file, forward, backward, new Map([[file, reachableSize(file, backward)]]));

  // One coverage source: the report when it names a file, otherwise the labelled reach fallback.
  const coverage = fileCoverage(graph, measured);
  const basis: 'measured' | 'reachable' = measured?.available ? 'measured' : 'reachable';
  const testsToRun = computeTestReachByFile(graph).get(file) ?? [];
  const untestedDependents = (backward.get(file) ?? [])
    .filter((dependent) => isUntested(coverage.get(dependent), basis, UNDER_COVERED_THRESHOLD))
    .sort();
  const fileCoverageFigure = coverage.get(file) ?? null;

  const extractor = symbolExtractorFor(file);
  if (!extractor) {
    return buildFileImpactPassport({
      path: file,
      status: 'modified',
      snapshot,
      before: null,
      after: null,
      changedFunctions: [],
      changedTypes: [],
      impact: null,
      testsToRun,
      untestedDependents,
      untestedBasis: basis,
      coverage: fileCoverageFigure,
      note: 'no symbol extractor for this language',
    });
  }

  const afterContent = readWorkingFile(root, file);
  const beforeContent = await contentAtRevision(root, 'HEAD', file);
  const after = afterContent === null ? null : await factsOf(extractor, file, afterContent);
  const before = beforeContent === null ? null : await factsOf(extractor, file, beforeContent);

  const changed = changedFromFacts(before, after);
  const note = afterContent === null
    ? 'reviewed copy is binary or unreadable'
    : beforeContent === null
      ? 'not present in HEAD'
      : undefined;

  return buildFileImpactPassport({
    path: file,
    status: before === null ? 'added' : 'modified',
    snapshot,
    before,
    after,
    changedFunctions: changed.functions,
    changedTypes: changed.types,
    impact: null,
    testsToRun,
    untestedDependents,
    untestedBasis: basis,
    coverage: fileCoverageFigure,
    ...(note ? { note } : {}),
  });
}

async function factsOf(
  extractor: SymbolExtractor,
  file: string,
  content: string,
): Promise<FileFunctionFacts | null> {
  try {
    const result = await extractor.extract(file, content);
    return functionFacts(file, result.symbols, result.calls ?? []);
  } catch {
    return null;
  }
}

/** Functions and types whose recorded shape moved between two sides. */
export function changedFromFacts(
  before: FileFunctionFacts | null,
  after: FileFunctionFacts | null,
): { functions: Array<{ owner: string; name: string }>; types: Array<{ name: string }> } {
  const functions: Array<{ owner: string; name: string }> = [];
  const ids = new Set([...(before?.byId.keys() ?? []), ...(after?.byId.keys() ?? [])]);
  for (const id of ids) {
    if (before?.byId.get(id) === after?.byId.get(id)) continue;
    const separator = id.indexOf('\u0000');
    functions.push({ owner: id.slice(0, separator), name: id.slice(separator + 1) });
  }

  const types: Array<{ name: string }> = [];
  const names = new Set([...(before?.types ?? []), ...(after?.types ?? [])].map((type) => type.name));
  for (const name of names) {
    const beforeMembers = before?.types.find((type) => type.name === name)?.memberCount;
    const afterMembers = after?.types.find((type) => type.name === name)?.memberCount;
    if (beforeMembers !== afterMembers) types.push({ name });
  }

  return { functions, types };
}

/**
 * Roll the per-file passports up into one card for the change set or revision.
 *
 * Blast radius, importers, and imports are distinct-file unions over the drawn graph, so a
 * file reachable from two changed files is counted once. The risk is the worst file's, and
 * the complexity is the pooled average across measured files.
 */
export function rollUpImpactPassports(
  graph: Graph,
  files: readonly FileImpactPassport[],
  scope: ImpactPassportSet['scope'],
  baseline: string | null,
  capped: boolean,
): ImpactPassportSet {
  const { forward, backward } = buildAdjacency(graph, { includeReExports: true });
  const changed = new Set(files.map((file) => file.path));

  const reachable = new Set<string>();
  const queue = [...changed];
  const visited = new Set(queue);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const dependent of backward.get(current) ?? []) {
      if (!visited.has(dependent)) {
        visited.add(dependent);
        queue.push(dependent);
        reachable.add(dependent);
      }
    }
  }

  const importers = new Set<string>();
  const imports = new Set<string>();
  for (const file of files) {
    for (const importer of backward.get(file.path) ?? []) {
      if (!changed.has(importer)) importers.add(importer);
    }
    for (const target of forward.get(file.path) ?? []) {
      if (!changed.has(target)) imports.add(target);
    }
  }

  let maxComplexity: number | null = null;
  let sumAfter = 0;
  let measured = 0;
  let functionsUnchanged = 0;
  let classesUnchanged = 0;
  let coherenceSum = 0;
  let coherenceCount = 0;
  let changedSymbols = 0;
  let worstRisk: ImpactRisk | null = null;
  const signalCounts = new Map<string, ImpactSignal & { count: number }>();
  const mostComplex: ImpactFunction[] = [];

  for (const file of files) {
    if (file.risk && (!worstRisk || file.risk.score > worstRisk.score)) worstRisk = file.risk;
    const cx = file.complexity;
    if (cx.maxAfter !== null) maxComplexity = maxComplexity === null ? cx.maxAfter : Math.max(maxComplexity, cx.maxAfter);
    if (cx.sumAfter !== null && cx.functionCountAfter !== null && cx.functionCountAfter > 0) {
      sumAfter += cx.sumAfter;
      measured += cx.functionCountAfter;
    }
    functionsUnchanged += cx.functionsUnchanged ?? 0;
    classesUnchanged += cx.classesUnchanged ?? 0;
    if (file.coherence) {
      coherenceSum += file.coherence.score;
      coherenceCount += 1;
      changedSymbols += file.coherence.changedSymbols;
    }
    for (const signal of file.signals) {
      const entry = signalCounts.get(signal.kind);
      if (entry) entry.count += 1;
      else signalCounts.set(signal.kind, { ...signal, count: 1 });
    }
    mostComplex.push(...file.mostComplex);
  }

  const signals: ImpactSignal[] = [...signalCounts.values()]
    .map((entry) => ({ kind: entry.kind, label: entry.label, detail: entry.count > 1 ? `${entry.detail} · ${entry.count} files` : entry.detail }))
    .sort((a, b) => rank(a.kind) - rank(b.kind));

  // The changed files' own coverage figures, summed from the same helper the cards carry, so
  // a roll-up names its measured/reachable basis and the report age rather than a bare count.
  const coverageByFile = new Map<string, FileCoverage>();
  for (const file of files) {
    if (file.coverage) {
      coverageByFile.set(file.path, file.coverage);
    }
  }
  const coverage = coverageByFile.size > 0
    ? summariseFileCoverage([...coverageByFile.keys()], coverageByFile)
    : null;

  // References are summed, the files they come from are unioned: a file that references two
  // changed files is one referencing file but two references.
  const referencedFiles = new Set<string>();
  let referenceTotal = 0;
  let countedReferences = false;
  for (const file of files) {
    if (!file.symbolReferences) continue;
    countedReferences = true;
    referenceTotal += file.symbolReferences.total;
    for (const referenced of file.impact?.definite ?? []) referencedFiles.add(referenced);
  }
  const symbolReferences = countedReferences ? { total: referenceTotal, files: referencedFiles.size } : null;

  const totals: ImpactTotals = {
    files: files.length,
    risk: worstRisk ? { score: worstRisk.score, band: worstRisk.band } : null,
    maxComplexity,
    averageComplexity: measured === 0 ? null : Math.round((sumAfter / measured) * 10) / 10,
    coherence: coherenceCount === 0 ? null : Math.round(coherenceSum / coherenceCount),
    changedSymbols,
    blastRadius: reachable.size,
    directImporters: importers.size,
    directImports: imports.size,
    // Reachability and the direct sets above are built over re-export edges.
    countsIncludeReExports: true,
    ...(symbolReferences ? { symbolReferences } : {}),
    signals,
    mostComplex: mostComplex
      .sort((a, b) => b.complexity - a.complexity || a.name.localeCompare(b.name))
      .slice(0, MAX_MOST_COMPLEX),
    functionsUnchanged,
    classesUnchanged,
    coverage,
  };

  return { scope, baseline, files: [...files], totals, capped };
}
