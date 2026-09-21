import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Graph } from '../types.ts';
import { buildAdjacency, computeGraphMetrics } from './analysis.ts';
import { computeCoverage, computeTestReachByFile } from './coverage.ts';
import { contentAtRevision, readWorkingFile } from './git-content.ts';
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
import type { ChangePassport, ChangeRisk, CohesionChange, FunctionChange, PublicSurfaceChange, SymbolChange, TieredImpact, ReviewFile, ReviewStatus } from './review-types.ts';

const run = promisify(execFile);
const MAX_FILES = 40;

export type { ChangePassport, ChangeRisk, CohesionChange, FunctionChange, PublicSurfaceChange, TieredImpact } from './review-types.ts';

export async function computeChangePassport(
  root: string,
  files: readonly ReviewFile[],
  baseline: string | null,
  graph: Graph,
): Promise<ChangePassport> {
  const safeBaseline = baseline && isSafeRevision(baseline) ? baseline : null;
  const measured = files.slice(0, MAX_FILES);
  const changes: CohesionChange[] = [];
  const { forward, backward } = buildAdjacency(graph);
  const graphMetrics = computeGraphMetrics(graph);
  const coverage = computeCoverage(graph);
  const reached = new Set([...coverage.reached, ...coverage.testFiles]);
  const testsByFile = computeTestReachByFile(graph);
  for (const file of measured) {
    changes.push(await cohesionChange(root, file, safeBaseline, graph, forward, backward, graphMetrics.transitiveDependents, testsByFile, reached));
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
  reached: Set<string>,
): Promise<CohesionChange> {
  const base: Pick<CohesionChange, 'path' | 'status' | 'previousPath'> = {
    path: file.path,
    status: file.status,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
  };
  const snapshot = snapshotFor(file.path, forward, backward, blastRadius);

  // Which tests to run, and which dependents no test reaches, are answered for every file,
  // even one whose language has no extractor.
  const testsToRun = testsByFile.get(file.path) ?? [];
  const untestedDependents = (backward.get(file.path) ?? [])
    .filter((dependent) => !reached.has(dependent))
    .sort();

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
      note,
    });

  const extractor = symbolExtractorFor(file.path);
  if (!extractor) {
    return { ...base, before: null, after: null, note: 'no symbol extractor for this language', functions: [], publicSurface: [], impact: null, testsToRun, untestedDependents, risk: null, impactPassport: emptyPassport('no symbol extractor for this language') };
  }
  if (extractor.tracksAccess === false) {
    return { ...base, before: null, after: null, note: 'this language records no member access', functions: [], publicSurface: [], impact: null, testsToRun, untestedDependents, risk: null, impactPassport: emptyPassport('this language records no member access') };
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
  const risk = computeChangeRisk(file.path, functions, impact, reached);
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
    note,
  });

  return {
    ...base,
    before,
    after,
    note,
    functions,
    publicSurface,
    impact,
    testsToRun,
    untestedDependents,
    risk,
    impactPassport,
  };
}

/**
 * linesTouched × touchedComplexity × definiteImpact × untestedShare, with each input kept.
 *
 * A product, not a percentile: the passport is about one pending change, so there is no
 * repository to rank against. Null when nothing measurable was touched.
 */
function computeChangeRisk(
  filePath: string,
  functions: readonly FunctionChange[],
  impact: TieredImpact | null,
  reached: ReadonlySet<string>,
): ChangeRisk | null {
  const definiteImpact = impact?.definite.length ?? 0;
  if (functions.length === 0 && definiteImpact === 0) {
    return null;
  }
  let linesTouched = 0;
  let touchedComplexity = 0;
  for (const fn of functions) {
    linesTouched += fn.linesAfter ?? fn.linesBefore ?? 0;
    touchedComplexity += fn.decisionPointsAfter ?? fn.decisionPointsBefore ?? 0;
  }
  const candidates = [filePath, ...(impact?.definite ?? [])];
  const reachedCount = candidates.filter((candidate) => reached.has(candidate)).length;
  const untestedShare = candidates.length === 0 ? 1 : (candidates.length - reachedCount) / candidates.length;
  const score = linesTouched * touchedComplexity * definiteImpact * untestedShare;

  return {
    score: Math.round(score * 1000) / 1000,
    inputs: {
      linesTouched,
      touchedComplexity,
      definiteImpact,
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

  const importers = backward.get(filePath) ?? [];
  for (const importer of importers) {
    const edges = graph.edges.filter((e) => e.target === importer && e.source === filePath);
    let isDefinite = false;
    for (const edge of edges) {
      const specifier = edge.evidence.specifier;
      for (const symbolName of changedFileNames) {
        if (specifier.includes(symbolName) || specifier === symbolName) {
          isDefinite = true;
          break;
        }
      }
      if (isDefinite) break;
    }
    if (isDefinite) {
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
  };
}

function computePublicSurfaceDiff(
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

  const hunks = baseline && beforeExtraction !== null
    ? await getDiffHunks(root, baseline, file.path)
    : [];

  if (hunks.length === 0 && beforeExtraction !== null && afterExtraction !== null) {
    const beforeNames = new Set(beforeFunctions.map((f) => `${f.owner}\u0000${f.name}`));
    const afterNames = new Set(afterFunctions.map((f) => `${f.owner}\u0000${f.name}`));
    const added = afterFunctions.filter((f) => !beforeNames.has(`${f.owner}\u0000${f.name}`));
    const removed = beforeFunctions.filter((f) => !afterNames.has(`${f.owner}\u0000${f.name}`));
    return [...added.map((f) => functionChangeFromEntry(f)), ...removed.map((f) => functionChangeFromEntry(f))];
  }

  if (hunks.length > 0) {
    const beforeMap = new Map<string, FunctionEntry>();
    for (const f of beforeFunctions) {
      beforeMap.set(`${f.owner}\u0000${f.name}`, f);
    }
    const afterMap = new Map<string, FunctionEntry>();
    for (const f of afterFunctions) {
      afterMap.set(`${f.owner}\u0000${f.name}`, f);
    }

    const touched = new Set<string>();
    for (const hunk of hunks) {
      for (const [key] of beforeMap) {
        if (hunkOverlapsHunk(beforeMap.get(key)!, hunk, true)) {
          touched.add(key);
        }
      }
      for (const [key] of afterMap) {
        if (hunkOverlapsHunk(afterMap.get(key)!, hunk, false)) {
          touched.add(key);
        }
      }
    }

    if (touched.size === 0) {
      for (const key of afterMap.keys()) {
        touched.add(key);
      }
    }

    const changedFunctions: FunctionChange[] = [];
    for (const key of touched) {
      const fn = afterMap.get(key) ?? beforeMap.get(key);
      if (fn) {
        changedFunctions.push(functionChangeFromEntry(fn));
      }
    }
    return changedFunctions;
  }

  return [];
}

function functionsOf(file: string, extraction: SymbolExtraction): FunctionEntry[] {
  return buildFunctions(file, extraction.symbols, extraction.calls ?? []).functions;
}

function functionChangeFromEntry(fn: FunctionEntry): FunctionChange {
  const beforeMetrics = fn.metrics;
  return {
    name: fn.name,
    owner: fn.owner,
    line: fn.line,
    decisionPointsBefore: beforeMetrics?.decisionPoints ?? null,
    decisionPointsAfter: beforeMetrics?.decisionPoints ?? null,
    nestingBefore: beforeMetrics?.maxNestingDepth ?? null,
    nestingAfter: beforeMetrics?.maxNestingDepth ?? null,
    signalsBefore: fn.signals.map((s) => s.kind),
    signalsAfter: fn.signals.map((s) => s.kind),
    signalIntroduced: false,
    signalResolved: false,
    linesBefore: beforeMetrics?.lines ?? null,
    linesAfter: beforeMetrics?.lines ?? null,
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

function hunkOverlapsHunk(
  fn: { line: number; metrics?: { lines: number } },
  hunk: DiffHunk,
  useOld: boolean,
): boolean {
  const fnStart = fn.line;
  const fnEnd = fnStart + (fn.metrics?.lines ?? 0);
  const hunkStart = useOld ? hunk.oldStart : hunk.newStart;
  const hunkEnd = hunkStart + (useOld ? hunk.oldCount : hunk.newCount);
  return fnStart >= hunkStart && fnStart <= hunkEnd;
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
