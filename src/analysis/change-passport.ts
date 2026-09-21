import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

import type { Graph } from '../types.ts';
import { buildAdjacency } from './analysis.ts';
import { assertReadable } from '../boundary/repository-root.ts';
import { symbolExtractorFor, type SymbolExtractor } from '../scan/languages/registry.ts';
import { computeMemberCohesion } from './file-health.ts';
import { buildFunctions } from './functions.ts';
import type { FunctionEntry } from './functions.ts';
import { isSafeRevision } from './impact.ts';
import type { ChangePassport, CohesionChange, FunctionChange, PublicSurfaceChange, SymbolChange, TieredImpact, ReviewFile, ReviewStatus } from './review-types.ts';

const run = promisify(execFile);
const MAX_FILES = 40;
const MAX_BYTES = 4 * 1024 * 1024;

export type { ChangePassport, CohesionChange, FunctionChange, PublicSurfaceChange, TieredImpact } from './review-types.ts';

export async function computeChangePassport(
  root: string,
  files: readonly ReviewFile[],
  baseline: string | null,
  graph: Graph,
): Promise<ChangePassport> {
  const safeBaseline = baseline && isSafeRevision(baseline) ? baseline : null;
  const measured = files.slice(0, MAX_FILES);
  const changes: CohesionChange[] = [];
  const { backward } = buildAdjacency(graph);
  for (const file of measured) {
    changes.push(await cohesionChange(root, file, safeBaseline, graph, backward));
  }
  return { files: changes, baseline: safeBaseline, capped: files.length > measured.length };
}

async function cohesionChange(
  root: string,
  file: ReviewFile,
  baseline: string | null,
  graph: Graph,
  backward: Map<string, string[]>,
): Promise<CohesionChange> {
  const base: Pick<CohesionChange, 'path' | 'status' | 'previousPath'> = {
    path: file.path,
    status: file.status,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
  };

  const extractor = symbolExtractorFor(file.path);
  if (!extractor) {
    return { ...base, before: null, after: null, note: 'no symbol extractor for this language', functions: [], publicSurface: [], impact: null };
  }
  if (extractor.tracksAccess === false) {
    return { ...base, before: null, after: null, note: 'this language records no member access', functions: [], publicSurface: [], impact: null };
  }

  const sourcePath = file.previousPath ?? file.path;
  const beforeContent = baseline ? await contentAtRevision(root, baseline, sourcePath) : null;
  const afterContent = file.status === 'deleted' ? null : readWorkingFile(root, file.path);
  const before = beforeContent === null ? null : await cohesionOf(extractor, sourcePath, beforeContent);
  const after = afterContent === null ? null : await cohesionOf(extractor, file.path, afterContent);

  const functions = await computeFunctionChanges(extractor, root, file, baseline, beforeContent, afterContent);
  const publicSurface = await computePublicSurfaceDiff(extractor, root, file, baseline, beforeContent, afterContent);
  const impact = computeTieredImpact(file.path, file, graph, backward, functions);

  return {
    ...base,
    before,
    after,
    note: noteFor({ file, baseline, beforeContent, before, after }),
    functions,
    publicSurface,
    impact,
  };
}

function computeTieredImpact(
  filePath: string,
  file: ReviewFile,
  graph: Graph,
  backward: Map<string, string[]>,
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

async function computePublicSurfaceDiff(
  extractor: SymbolExtractor,
  root: string,
  file: ReviewFile,
  baseline: string | null,
  beforeContent: string | null,
  afterContent: string | null,
): Promise<PublicSurfaceChange[]> {
  if (beforeContent === null && afterContent === null) {
    return [];
  }

  const beforeSymbols = beforeContent !== null ? await extractPublicSymbols(extractor, file.path, beforeContent) : [];
  const afterSymbols = afterContent !== null ? await extractPublicSymbols(extractor, file.path, afterContent) : [];

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

async function extractPublicSymbols(
  extractor: SymbolExtractor,
  file: string,
  content: string,
): Promise<SymbolChange[]> {
  try {
    const result = await extractor.extract(file, content);
    const symbols: SymbolChange[] = [];
    for (const sym of result.symbols) {
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
  } catch {
    return [];
  }
}

async function computeFunctionChanges(
  extractor: SymbolExtractor,
  root: string,
  file: ReviewFile,
  baseline: string | null,
  beforeContent: string | null,
  afterContent: string | null,
): Promise<FunctionChange[]> {
  if (beforeContent === null && afterContent === null) {
    return [];
  }

  const beforeFunctions: FunctionEntry[] = beforeContent !== null ? await extractFunctions(extractor, file.path, beforeContent) : [];
  const afterFunctions: FunctionEntry[] = afterContent !== null ? await extractFunctions(extractor, file.path, afterContent) : [];

  if (beforeFunctions.length === 0 && afterFunctions.length === 0) {
    return [];
  }

  const hunks = baseline && beforeContent !== null
    ? await getDiffHunks(root, baseline, file.path)
    : [];

  if (hunks.length === 0 && beforeContent !== null && afterContent !== null) {
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

async function extractFunctions(
  extractor: SymbolExtractor,
  file: string,
  content: string,
): Promise<FunctionEntry[]> {
  try {
    const result = await extractor.extract(file, content);
    const built = buildFunctions(file, result.symbols, result.calls ?? []);
    return built.functions;
  } catch {
    return [];
  }
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

async function cohesionOf(
  extractor: SymbolExtractor,
  file: string,
  content: string,
): Promise<number | null> {
  try {
    const result = await extractor.extract(file, content);
    return computeMemberCohesion(result.symbols, result.accesses ?? []).value;
  } catch {
    return null;
  }
}

async function contentAtRevision(root: string, ref: string, file: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['show', `${ref}:${file}`], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    });
    const content = typeof stdout === 'string' ? stdout : String(stdout);
    return content.includes('\0') ? null : content;
  } catch {
    return null;
  }
}

function readWorkingFile(root: string, file: string): string | null {
  try {
    const resolved = assertReadable(root, file);
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_BYTES) {
      return null;
    }
    const content = fs.readFileSync(resolved);
    return content.includes(0) ? null : content.toString('utf8');
  } catch {
    return null;
  }
}
