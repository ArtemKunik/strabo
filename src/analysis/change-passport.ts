import type { Graph } from '../types.ts';
import { buildAdjacency, computeGraphMetrics } from './analysis.ts';
import { computeTestReachByFile } from './coverage.ts';
import {
  fileCoverage,
  isUntested,
  UNDER_COVERED_THRESHOLD,
  type FileCoverage,
} from './file-coverage.ts';
import { contentAtRevision, readWorkingFile } from './git-content.ts';
import type { MeasuredCoverageSummary } from './measured-coverage.ts';
import { symbolExtractorFor, type SymbolExtractor } from '../scan/languages/registry.ts';
import type { SymbolExtraction } from '../scan/languages/symbols.ts';
import { computeMemberCohesion } from './file-health.ts';
import { buildFunctions } from './functions.ts';
import type { FunctionEntry } from './functions.ts';
import {
  buildFileImpactPassport,
  functionFacts,
  snapshotFor,
} from './impact-passport.ts';
import { isSafeRevision } from './impact.ts';
import { CHANGE_RISK_SIGNAL_LABELS, CHANGE_RISK_THRESHOLDS } from './signals.ts';
import type { StructuralDiff } from './structural-diff.ts';
import { IMPACT_TIER_LABELS } from './review-types.ts';
import type { ChangeEdge, ChangePassport, ChangeRisk, ChangeRiskSignal, CohesionChange, FunctionChange, PublicSurfaceChange, SymbolChange, TieredImpact, ReviewFile, ReviewStatus } from './review-types.ts';
import { run } from '../process.ts';

const MAX_FILES = 40;

export type { ChangePassport, ChangeRisk, CohesionChange, FunctionChange, PublicSurfaceChange, TieredImpact } from './review-types.ts';

export async function computeChangePassport(
  root: string,
  files: readonly ReviewFile[],
  baseline: string | null,
  graph: Graph,
  structural?: Pick<StructuralDiff, 'edgesAdded' | 'edgesRemoved'>,
  measuredCoverage: MeasuredCoverageSummary | null = null,
): Promise<ChangePassport> {
  const safeBaseline = baseline && isSafeRevision(baseline) ? baseline : null;
  const measured = files.slice(0, MAX_FILES);
  const changes: CohesionChange[] = [];
  const traversal = buildAdjacency(graph, { includeReExports: true });
  const { forward, backward } = traversal;
  const graphMetrics = computeGraphMetrics(graph, traversal);
  // One coverage source: the report when it names a file, otherwise the labelled reach fallback.
  const coverage = fileCoverage(graph, measuredCoverage);
  const basis: 'measured' | 'reachable' = measuredCoverage?.available ? 'measured' : 'reachable';
  const testsByFile = computeTestReachByFile(graph);
  for (const file of measured) {
    changes.push(await cohesionChange(root, file, safeBaseline, graph, forward, backward, graphMetrics.transitiveDependents, testsByFile, coverage, basis, structural));
  }
  return { files: changes, baseline: safeBaseline, capped: files.length > measured.length };
}

async function cohesionChange(
  root: string,
  file: ReviewFile,
  baseline: string | null,
  graph: Graph,
  forward: ReadonlyMap<string, string[]>,
  backward: ReadonlyMap<string, string[]>,
  blastRadius: ReadonlyMap<string, number>,
  testsByFile: Map<string, string[]>,
  coverage: ReadonlyMap<string, FileCoverage>,
  basis: 'measured' | 'reachable',
  structural?: Pick<StructuralDiff, 'edgesAdded' | 'edgesRemoved'>,
): Promise<CohesionChange> {
  const base: Pick<CohesionChange, 'path' | 'status' | 'previousPath'> = {
    path: file.path,
    status: file.status,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
  };
  const snapshot = snapshotFor(file.path, forward, backward, blastRadius);
  const edgesAdded = edgesTouching(structural?.edgesAdded, file);
  const edgesRemoved = edgesTouching(structural?.edgesRemoved, file);
  const fileCoverageFigure = coverage.get(file.path) ?? null;

  // Which tests to run, and which dependents are under-covered or unreached, are answered for
  // every file, even one whose language has no extractor. `isUntested` reads the measured
  // figure when the report names the dependent and the labelled reach fallback otherwise.
  const testsToRun = testsByFile.get(file.path) ?? [];
  const isUntestedDependent = (dependent: string): boolean =>
    isUntested(coverage.get(dependent), basis, UNDER_COVERED_THRESHOLD);
  const untestedDependents = (backward.get(file.path) ?? []).filter(isUntestedDependent).sort();

  const emptyPassport = (note: string) =>
    buildFileImpactPassport({
      ...base,
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
      note,
    });

  const extractor = symbolExtractorFor(file.path);
  if (!extractor) {
    return { ...base, before: null, after: null, note: 'no symbol extractor for this language', functions: [], publicSurface: [], edgesAdded, edgesRemoved, impact: null, testsToRun, untestedDependents, untestedBasis: basis, coverage: fileCoverageFigure, risk: null, impactPassport: emptyPassport('no symbol extractor for this language') };
  }
  if (extractor.tracksAccess === false) {
    return { ...base, before: null, after: null, note: 'this language records no member access', functions: [], publicSurface: [], edgesAdded, edgesRemoved, impact: null, testsToRun, untestedDependents, untestedBasis: basis, coverage: fileCoverageFigure, risk: null, impactPassport: emptyPassport('this language records no member access') };
  }

  const sourcePath = file.previousPath ?? file.path;
  const beforeContent = baseline ? await contentAtRevision(root, baseline, sourcePath) : null;
  const afterContent = file.status === 'deleted' ? null : readWorkingFile(root, file.path);
  const beforeExtraction = beforeContent === null ? null : await safeExtract(extractor, sourcePath, beforeContent);
  const afterExtraction = afterContent === null ? null : await safeExtract(extractor, file.path, afterContent);
  const before = beforeExtraction === null ? null : cohesionOf(beforeExtraction);
  const after = afterExtraction === null ? null : cohesionOf(afterExtraction);

  const functions = await computeFunctionChanges(extractor, root, file, baseline, beforeExtraction, afterExtraction);
  const publicSurface = computePublicSurfaceDiff(extractor, beforeExtraction, afterExtraction);
  const impact = computeTieredImpact(file.path, file, graph, backward, functions);
  const risk = computeChangeRisk(file.path, functions, impact, isUntestedDependent);
  const note = noteFor({ file, baseline, beforeContent, before, after });

  const factsBefore = beforeExtraction === null ? null : functionFacts(sourcePath, beforeExtraction.symbols, beforeExtraction.calls ?? []);
  const factsAfter = afterExtraction === null ? null : functionFacts(file.path, afterExtraction.symbols, afterExtraction.calls ?? []);
  const impactPassport = buildFileImpactPassport({
    ...base,
    snapshot,
    before: factsBefore,
    after: factsAfter,
    changedFunctions: functions.map((fn) => ({ owner: fn.owner, name: fn.name })),
    changedTypes: publicSurface
      .flatMap((surface) => surface.symbols)
      .filter((symbol) => symbol.change !== 'unchanged')
      .map((symbol) => ({ name: symbol.name })),
    impact,
    testsToRun,
    untestedDependents,
    untestedBasis: basis,
    coverage: fileCoverageFigure,
    note,
  });

  return {
    ...base,
    before,
    after,
    note,
    functions,
    publicSurface,
    edgesAdded,
    edgesRemoved,
    impact,
    testsToRun,
    untestedDependents,
    untestedBasis: basis,
    coverage: fileCoverageFigure,
    risk,
    impactPassport,
  };
}

/** The recorded edges from a structural diff that touch this file, as import deltas. */
function edgesTouching(
  edges: readonly { source: string; target: string; kind: string }[] | undefined,
  file: ReviewFile,
): ChangeEdge[] {
  if (!edges || edges.length === 0) return [];
  const paths = new Set([file.path, ...(file.previousPath ? [file.previousPath] : [])]);
  return edges
    .filter((edge) => paths.has(edge.source) || paths.has(edge.target))
    .map((edge) => ({ source: edge.source, target: edge.target, kind: edge.kind }));
}

/** How each change-risk signal is weighted in the additive score. Kept explicit. */
export const CHANGE_RISK_WEIGHTS = {
  linesTouched: 0.35,
  touchedComplexity: 0.3,
  recordedReferences: 0.2,
  untestedShare: 0.15,
} as const;

function riskSignal(
  kind: ChangeRiskSignal['kind'],
  value: number,
  threshold: number,
): ChangeRiskSignal {
  const contribution = threshold <= 0 ? 0 : Math.min(1, value / threshold);
  return {
    kind,
    label: CHANGE_RISK_SIGNAL_LABELS[kind],
    value,
    threshold,
    contribution: Number(contribution.toFixed(3)),
  };
}

/**
 * The pending-change risk as contributing signals, each with its value and threshold, and an
 * additive 0-100 score summed from them.
 *
 * Additive, not a product: one zero signal no longer erases the rest, so a change that
 * touches many lines with no recorded reference still reads as risk. Null only when nothing
 * measurable was touched at all, so a score is never shown without its signals.
 */
function computeChangeRisk(
  filePath: string,
  functions: readonly FunctionChange[],
  impact: TieredImpact | null,
  isUntestedFile: (file: string) => boolean,
): ChangeRisk | null {
  const recordedReferences = impact?.referenceCount ?? 0;
  if (functions.length === 0 && recordedReferences === 0) {
    return null;
  }
  let linesTouched = 0;
  let touchedComplexity = 0;
  for (const fn of functions) {
    linesTouched += fn.linesAfter ?? fn.linesBefore ?? 0;
    touchedComplexity += fn.decisionPointsAfter ?? fn.decisionPointsBefore ?? 0;
  }
  const candidates = [filePath, ...(impact?.definite ?? [])];
  const untestedCount = candidates.filter(isUntestedFile).length;
  const untestedShare = candidates.length === 0 ? 1 : untestedCount / candidates.length;

  const signals: ChangeRiskSignal[] = [
    riskSignal('lines-touched', linesTouched, CHANGE_RISK_THRESHOLDS.linesTouched),
    riskSignal('touched-complexity', touchedComplexity, CHANGE_RISK_THRESHOLDS.touchedComplexity),
    riskSignal('recorded-references', recordedReferences, CHANGE_RISK_THRESHOLDS.recordedReferences),
    riskSignal('untested-share', Number(untestedShare.toFixed(3)), CHANGE_RISK_THRESHOLDS.untestedShare),
  ];
  const score = Math.round(
    100 *
      (CHANGE_RISK_WEIGHTS.linesTouched * signals[0]!.contribution +
        CHANGE_RISK_WEIGHTS.touchedComplexity * signals[1]!.contribution +
        CHANGE_RISK_WEIGHTS.recordedReferences * signals[2]!.contribution +
        CHANGE_RISK_WEIGHTS.untestedShare * signals[3]!.contribution),
  );

  return {
    score,
    signals,
    inputs: {
      linesTouched,
      touchedComplexity,
      recordedReferences,
      untestedShare: Number(untestedShare.toFixed(3)),
    },
  };
}

function computeTieredImpact(
  filePath: string,
  file: ReviewFile,
  graph: Graph,
  backward: ReadonlyMap<string, string[]>,
  functions: FunctionChange[],
): TieredImpact | null {
  const changedSymbolNames = new Set(functions.map((f) => `${f.owner}\u0000${f.name}`));
  const changedFileNames = new Set(functions.map((f) => f.name));

  const definite: string[] = [];
  const possible: string[] = [];
  let referenceCount = 0;

  const importers = backward.get(filePath) ?? [];
  for (const importer of importers) {
    // The importer's own recorded edges into the changed file: source is the importer, target is
    // the changed file. The direction is what makes a specifier the importer's reference; the
    // reverse edges (the changed file importing the importer) are not references.
    const edges = graph.edges.filter((e) => e.source === importer && e.target === filePath);
    let references = 0;
    for (const edge of edges) {
      const specifier = edge.evidence.specifier;
      for (const symbolName of changedFileNames) {
        if (specifier.includes(symbolName) || specifier === symbolName) {
          references += 1;
          break;
        }
      }
    }
    referenceCount += references;
    if (references > 0) {
      definite.push(importer);
    } else {
      possible.push(importer);
    }
  }

  const reachable = new Set<string>();
  const queue = [...importers];
  const visited = new Set(queue);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    reachable.add(current);
    for (const dependent of backward.get(current) ?? []) {
      if (!visited.has(dependent)) {
        visited.add(dependent);
        queue.push(dependent);
      }
    }
  }

  if (definite.length === 0 && possible.length === 0) {
    return null;
  }

  return {
    definite,
    possible,
    reachable: [...reachable],
    referenceCount,
    labels: IMPACT_TIER_LABELS,
  };
}

export function computePublicSurfaceDiff(
  extractor: SymbolExtractor,
  beforeExtraction: SymbolExtraction | null,
  afterExtraction: SymbolExtraction | null,
): PublicSurfaceChange[] {
  if (beforeExtraction === null && afterExtraction === null) {
    return [];
  }

  const beforeSymbols = beforeExtraction !== null ? publicSymbols(beforeExtraction) : [];
  const afterSymbols = afterExtraction !== null ? publicSymbols(afterExtraction) : [];

  if (beforeSymbols.length === 0 && afterSymbols.length === 0) {
    return [];
  }

  const beforeMap = new Map<string, SymbolChange>();
  for (const s of beforeSymbols) {
    beforeMap.set(`${s.owner}\u0000${s.name}`, s);
  }
  const afterMap = new Map<string, SymbolChange>();
  for (const s of afterSymbols) {
    afterMap.set(`${s.owner}\u0000${s.name}`, s);
  }

  const symbols: SymbolChange[] = [];
  const beforeNames = new Set(beforeMap.keys());
  const afterNames = new Set(afterMap.keys());

  for (const [key, s] of beforeMap) {
    if (!afterNames.has(key)) {
      symbols.push({ ...s, change: 'removed', typeAfter: null, parametersAfter: null });
    } else {
      const after = afterMap.get(key)!;
      if (s.typeBefore !== after.typeBefore || s.parametersBefore !== after.parametersBefore) {
        symbols.push({ ...s, change: 'changed-signature', typeBefore: s.typeBefore, typeAfter: after.typeBefore, parametersBefore: s.parametersBefore, parametersAfter: after.parametersBefore });
      } else {
        symbols.push({ ...s, change: 'unchanged', typeBefore: s.typeBefore, typeAfter: after.typeBefore, parametersBefore: s.parametersBefore, parametersAfter: after.parametersBefore });
      }
    }
  }
  for (const [key, s] of afterMap) {
    if (!beforeNames.has(key)) {
      symbols.push({ ...s, change: 'added', typeBefore: null, parametersBefore: null });
    }
  }

  if (symbols.length === 0) {
    return [];
  }

  return [{ language: extractor.language, symbols }];
}

function publicSymbols(extraction: SymbolExtraction): SymbolChange[] {
  const symbols: SymbolChange[] = [];
  for (const sym of extraction.symbols) {
    if (sym.visibility === 'public' || sym.visibility === 'export' || sym.visibility === 'pub') {
      symbols.push({
        name: sym.name,
        owner: sym.owner,
        change: 'unchanged',
        typeBefore: sym.type ?? null,
        typeAfter: null,
        parametersBefore: sym.parameters ?? null,
        parametersAfter: null,
      });
    }
  }
  return symbols;
}

async function computeFunctionChanges(
  extractor: SymbolExtractor,
  root: string,
  file: ReviewFile,
  baseline: string | null,
  beforeExtraction: SymbolExtraction | null,
  afterExtraction: SymbolExtraction | null,
): Promise<FunctionChange[]> {
  if (beforeExtraction === null && afterExtraction === null) {
    return [];
  }

  const beforeFunctions: FunctionEntry[] = beforeExtraction !== null ? functionsOf(file.path, beforeExtraction) : [];
  const afterFunctions: FunctionEntry[] = afterExtraction !== null ? functionsOf(file.path, afterExtraction) : [];

  if (beforeFunctions.length === 0 && afterFunctions.length === 0) {
    return [];
  }

  const beforeMap = indexFunctions(beforeFunctions);
  const afterMap = indexFunctions(afterFunctions);

  // A function present on only one side was added or removed outright; a modified body is
  // found by the diff hunks when a baseline is available, and by the recorded metrics when
  // it is not. Both sides' metrics are carried, so the delta is real.
  const touched = new Set<string>();
  for (const id of afterMap.keys()) if (!beforeMap.has(id)) touched.add(id);
  for (const id of beforeMap.keys()) if (!afterMap.has(id)) touched.add(id);

  if (beforeExtraction !== null && afterExtraction !== null) {
    const hunks = baseline ? await getDiffHunks(root, baseline, file.path) : [];
    if (hunks.length > 0) {
      for (const hunk of hunks) {
        for (const [key, fn] of beforeMap) {
          if (hunkOverlapsHunk(fn, hunk, true)) touched.add(key);
        }
        for (const [key, fn] of afterMap) {
          if (hunkOverlapsHunk(fn, hunk, false)) touched.add(key);
        }
      }
    } else {
      for (const [key, fn] of beforeMap) {
        const after = afterMap.get(key);
        if (after && !sameFunction(fn, after)) touched.add(key);
      }
    }
  }

  const changedFunctions: FunctionChange[] = [];
  for (const key of touched) {
    changedFunctions.push(functionChange(beforeMap.get(key) ?? null, afterMap.get(key) ?? null));
  }
  return changedFunctions.sort(
    (a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name),
  );
}

function functionsOf(file: string, extraction: SymbolExtraction): FunctionEntry[] {
  return buildFunctions(file, extraction.symbols, extraction.calls ?? []).functions;
}

function indexFunctions(functions: readonly FunctionEntry[]): Map<string, FunctionEntry> {
  const map = new Map<string, FunctionEntry>();
  for (const fn of functions) {
    map.set(`${fn.owner}\u0000${fn.name}`, fn);
  }
  return map;
}

/** True when the two sides record the same shape and signals, so nothing changed. */
function sameFunction(before: FunctionEntry, after: FunctionEntry): boolean {
  return (
    (before.metrics?.decisionPoints ?? null) === (after.metrics?.decisionPoints ?? null) &&
    (before.metrics?.maxNestingDepth ?? null) === (after.metrics?.maxNestingDepth ?? null) &&
    (before.metrics?.lines ?? null) === (after.metrics?.lines ?? null) &&
    signalKey(before) === signalKey(after)
  );
}

function signalKey(fn: FunctionEntry): string {
  return fn.signals
    .map((signal) => signal.kind)
    .sort()
    .join('\u0000');
}

/** A function change with both sides' recorded metrics, so added/removed/changed is exact. */
function functionChange(before: FunctionEntry | null, after: FunctionEntry | null): FunctionChange {
  const anchor = after ?? before;
  const beforeSignals = before?.signals.map((signal) => signal.kind) ?? [];
  const afterSignals = after?.signals.map((signal) => signal.kind) ?? [];
  const beforeSet = new Set(beforeSignals);
  const afterSet = new Set(afterSignals);
  return {
    name: anchor?.name ?? '',
    owner: anchor?.owner ?? '',
    line: anchor?.line ?? 0,
    change: before === null ? 'added' : after === null ? 'removed' : 'changed',
    decisionPointsBefore: before?.metrics?.decisionPoints ?? null,
    decisionPointsAfter: after?.metrics?.decisionPoints ?? null,
    nestingBefore: before?.metrics?.maxNestingDepth ?? null,
    nestingAfter: after?.metrics?.maxNestingDepth ?? null,
    signalsBefore: beforeSignals,
    signalsAfter: afterSignals,
    signalIntroduced: afterSignals.some((kind) => !beforeSet.has(kind)),
    signalResolved: beforeSignals.some((kind) => !afterSet.has(kind)),
    linesBefore: before?.metrics?.lines ?? null,
    linesAfter: after?.metrics?.lines ?? null,
  };
}

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

async function getDiffHunks(root: string, base: string, file: string): Promise<DiffHunk[]> {
  const hunks: DiffHunk[] = [];
  try {
    const { stdout } = await run('git', ['diff', '-U0', base, '--', file], {
      cwd: root,
      maxBuffer: 8 * 1024 * 1024,
    });
    const hunkRegex = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/g;
    let match: RegExpExecArray | null;
    while ((match = hunkRegex.exec(stdout)) !== null) {
      const newStart = parseInt(match[1]!, 10);
      const newCount = match[2] ? parseInt(match[2], 10) : 1;
      const oldMatch = /@@ -(\d+)(?:,(\d+))?/.exec(stdout.slice(Math.max(0, match.index - 20), match.index + 2));
      const oldStart = oldMatch ? parseInt(oldMatch[1]!, 10) : newStart;
      const oldCount = oldMatch && oldMatch[2] ? parseInt(oldMatch[2]!, 10) : 1;
      hunks.push({ oldStart, oldCount, newStart, newCount });
    }
  } catch {
    // No diff or git error; return empty.
  }
  return hunks;
}

/** True when the function's line range and the hunk's line range overlap on one side. */
function hunkOverlapsHunk(
  fn: { line: number; metrics?: { lines: number } },
  hunk: DiffHunk,
  useOld: boolean,
): boolean {
  const fnStart = fn.line;
  const fnEnd = fnStart + Math.max(0, (fn.metrics?.lines ?? 1) - 1);
  const hunkStart = useOld ? hunk.oldStart : hunk.newStart;
  const hunkCount = useOld ? hunk.oldCount : hunk.newCount;
  const hunkEnd = hunkStart + Math.max(0, hunkCount - 1);
  return fnStart <= hunkEnd && hunkStart <= fnEnd;
}

function noteFor(options: {
  file: ReviewFile;
  baseline: string | null;
  beforeContent: string | null;
  before: number | null;
  after: number | null;
}): string {
  const { file, baseline, beforeContent, before, after } = options;
  if (file.status === 'deleted') {
    return 'deleted — no reviewed state';
  }
  if (baseline === null) {
    return 'no baseline revision';
  }
  if (beforeContent === null) {
    return `not present in ${baseline}`;
  }
  if (before === null) {
    return `cohesion unavailable in ${baseline}`;
  }
  if (after === null) {
    return 'cohesion unavailable in the reviewed copy';
  }
  return `compared with ${baseline}`;
}

function cohesionOf(extraction: SymbolExtraction): number | null {
  return computeMemberCohesion(extraction.symbols, extraction.accesses ?? []).value;
}

/** Extract once, returning null on a parse failure so the side is named rather than empty. */
async function safeExtract(
  extractor: SymbolExtractor,
  file: string,
  content: string,
): Promise<SymbolExtraction | null> {
  try {
    return await extractor.extract(file, content);
  } catch {
    return null;
  }
}
