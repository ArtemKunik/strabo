import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Graph } from '../types.ts';
import { buildAdjacency, computeGraphMetrics } from './analysis.ts';
import { computeCoverage } from './coverage.ts';
import { computeCycles } from './cycles.ts';
import { analyzeModuleDepth } from './depth.ts';
import { computeMemberCohesion } from './file-health.ts';
import { buildFunctions } from './functions.ts';
import { getFileAuthorHistory } from './ownership.ts';
import { symbolExtractorFor } from '../scan/languages/registry.ts';
import { assertReadable } from '../boundary/repository-root.ts';

const run = promisify(execFile);

export interface PercentileMeasure {
  percentile: number;
  value: number;
}

export interface ComplexityMeasures {
  loc: number;
  functionCount: number;
  sumDecisionPoints: number;
  maxDecisionPoints: number;
  maxNestingDepth: number;
  signalShare: number;
}

export interface ShapeMeasures {
  cohesion: number | null;
  memberCount: number;
  interfaceWidth: number;
  depthSignal: string;
  instability: number | null;
}

export interface CentralityMeasures {
  directImporters: number;
  blastRadius: number;
  transitiveDependencies: number;
  inCycle: boolean;
}

export interface EvolutionMeasures {
  churn90d: number;
  distinctAuthors: number;
  ownershipFragmentation: number;
  hiddenCouplingShare: number;
}

export interface ProtectionMeasures {
  testReach: boolean;
  testedDependentsShare: number;
}

export interface ModuleQuality {
  file: string;
  complexity: ComplexityMeasures;
  shape: ShapeMeasures;
  centrality: CentralityMeasures;
  evolution: EvolutionMeasures;
  protection: ProtectionMeasures;
}

export interface QualityPercentile {
  complexity: Record<string, PercentileMeasure>;
  shape: Record<string, PercentileMeasure>;
  centrality: Record<string, PercentileMeasure>;
  evolution: Record<string, PercentileMeasure>;
  protection: Record<string, PercentileMeasure>;
}

export interface QualityScorecard {
  repository: string;
  modules: ModuleQuality[];
  percentiles: QualityPercentile;
}

export async function computeQualityScorecard(
  graph: Graph,
  root: string,
  repository: string,
): Promise<QualityScorecard> {
  const { forward, backward } = buildAdjacency(graph);
  const metrics = computeGraphMetrics(graph);
  const cycles = computeCycles(graph);
  const cycleMembers = new Set(cycles.flatMap((g) => g.members));
  const coverage = computeCoverage(graph);
  const nodes = graph.nodes;

  const depthResults = analyzeModuleDepth(root, nodes.map((n) => n.id));
  const depthByFile = new Map<string, typeof depthResults[0]>();
  for (const d of depthResults) {
    depthByFile.set(d.file, d);
  }

  const churnMap = await computeChurn(root, nodes.map((n) => n.id));
  const authorMap = await computeAuthors(root, nodes.map((n) => n.id));
  const coChangeMap = await computeCoChange(root, nodes.map((n) => n.id));

  const importGraph = buildImportGraph(graph);

  const moduleQualities: ModuleQuality[] = [];
  for (const node of nodes) {
    const file = node.id;
    const centrality = computeCentrality(file, metrics, cycleMembers);
    const complexity = await computeComplexity(graph, file, root);
    const shape = await computeShape(graph, file, depthByFile, centrality, root);
    const evolution = computeEvolution(file, churnMap, authorMap, coChangeMap, importGraph);
    const protection = computeProtection(file, coverage, backward);

    moduleQualities.push({ file, complexity, shape, centrality, evolution, protection });
  }

  const percentiles = computePercentiles(moduleQualities);

  return {
    repository,
    modules: moduleQualities,
    percentiles,
  };
}

function computeCentrality(
  file: string,
  metrics: ReturnType<typeof computeGraphMetrics>,
  cycleMembers: Set<string>,
): CentralityMeasures {
  return {
    directImporters: metrics.fanIn.get(file) ?? 0,
    blastRadius: metrics.transitiveDependents.get(file) ?? 0,
    transitiveDependencies: metrics.transitiveDependencies.get(file) ?? 0,
    inCycle: cycleMembers.has(file),
  };
}

async function computeComplexity(
  graph: Graph,
  file: string,
  root: string,
): Promise<ComplexityMeasures> {
  let loc = 0;
  let functionCount = 0;
  let sumDecisionPoints = 0;
  let maxDecisionPoints = 0;
  let maxNestingDepth = 0;
  let signalFunctions = 0;

  const node = graph.nodes.find((n) => n.id === file);
  const extractor = node ? symbolExtractorFor(file) : null;

  if (extractor) {
    try {
      const content = fs.readFileSync(assertReadable(root, file), 'utf8');
      const result = await extractor.extract(file, content);
      const functions = buildFunctions(file, result.symbols, result.calls ?? []);
      functionCount = functions.functions.length;
      for (const fn of functions.functions) {
        if (fn.metrics) {
          sumDecisionPoints += fn.metrics.decisionPoints;
          maxDecisionPoints = Math.max(maxDecisionPoints, fn.metrics.decisionPoints);
          maxNestingDepth = Math.max(maxNestingDepth, fn.metrics.maxNestingDepth);
          if (fn.signals.length > 0) {
            signalFunctions += 1;
          }
          loc += fn.metrics.lines;
        }
      }
    } catch {
      // File unreadable; counts stay 0.
    }
  }

  return {
    loc,
    functionCount,
    sumDecisionPoints,
    maxDecisionPoints,
    maxNestingDepth,
    signalShare: functionCount > 0 ? signalFunctions / functionCount : 0,
  };
}

async function computeShape(
  graph: Graph,
  file: string,
  depthByFile: Map<string, { interfaceWidth: number; signal: string }>,
  centrality: CentralityMeasures,
  root: string,
): Promise<ShapeMeasures> {
  const depth = depthByFile.get(file);
  const depthSignal = depth?.signal ?? 'ok';
  const interfaceWidth = depth?.interfaceWidth ?? 0;

  const node = graph.nodes.find((n) => n.id === file);
  const extractor = node ? symbolExtractorFor(file) : null;
  let cohesion: number | null = null;
  let memberCount = 0;

  if (extractor) {
    try {
      const content = fs.readFileSync(assertReadable(root, file), 'utf8');
      const result = await extractor.extract(file, content);
      const symbols = result.symbols;
      const accesses = result.accesses ?? [];
      memberCount = symbols.filter((s) => s.kind === 'field' || s.kind === 'property' || s.kind === 'method').length;
      cohesion = computeMemberCohesion(symbols, accesses).value;
    } catch {
      // Cohesion unavailable.
    }
  }

  const instability = (centrality.directImporters + centrality.blastRadius) > 0
    ? centrality.blastRadius / (centrality.directImporters + centrality.blastRadius)
    : null;

  return {
    cohesion,
    memberCount,
    interfaceWidth,
    depthSignal,
    instability,
  };
}

function computeEvolution(
  file: string,
  churnMap: Map<string, number>,
  authorMap: Map<string, { authors: string[]; commits: number }>,
  coChangeMap: Map<string, Set<string>>,
  importGraph: Map<string, Set<string>>,
): EvolutionMeasures {
  const churn90d = churnMap.get(file) ?? 0;
  const authorData = authorMap.get(file);
  const distinctAuthors = authorData?.authors.length ?? 0;
  const commits = authorData?.commits ?? 0;
  const ownershipFragmentation = commits > 0 ? distinctAuthors / commits : 0;

  const coChangeFiles = coChangeMap.get(file) ?? new Set();
  const fileImports = importGraph.get(file) ?? new Set();
  let hiddenCouplingCount = 0;
  for (const coFile of coChangeFiles) {
    if (!fileImports.has(coFile)) {
      hiddenCouplingCount += 1;
    }
  }
  const hiddenCouplingShare = coChangeFiles.size > 0 ? hiddenCouplingCount / coChangeFiles.size : 0;

  return { churn90d, distinctAuthors, ownershipFragmentation, hiddenCouplingShare };
}

function computeProtection(
  file: string,
  coverage: ReturnType<typeof computeCoverage>,
  backward: Map<string, string[]>,
): ProtectionMeasures {
  const testReach = coverage.reached.includes(file);
  const dependents = backward.get(file) ?? [];
  const testedDependents = dependents.filter((d) => coverage.reached.includes(d)).length;
  const testedDependentsShare = dependents.length > 0 ? testedDependents / dependents.length : 1;

  return { testReach, testedDependentsShare };
}

function buildImportGraph(graph: Graph): Map<string, Set<string>> {
  const { forward } = buildAdjacency(graph);
  const importGraph = new Map<string, Set<string>>();
  for (const [source, targets] of forward) {
    const filtered = new Set(targets.filter((t) => graph.edges.some((e) => e.source === source && e.target === t && e.role !== 'declare')));
    importGraph.set(source, filtered);
  }
  return importGraph;
}

function computePercentiles(modules: ModuleQuality[]): QualityPercentile {
  const result: QualityPercentile = {
    complexity: {},
    shape: {},
    centrality: {},
    evolution: {},
    protection: {},
  };

  const complexityEntries: [string, (m: ModuleQuality) => number, boolean][] = [
    ['loc', (m) => m.complexity.loc, true],
    ['functionCount', (m) => m.complexity.functionCount, true],
    ['sumDecisionPoints', (m) => m.complexity.sumDecisionPoints, true],
    ['maxDecisionPoints', (m) => m.complexity.maxDecisionPoints, true],
    ['maxNestingDepth', (m) => m.complexity.maxNestingDepth, true],
    ['signalShare', (m) => m.complexity.signalShare, true],
  ];
  const shapeEntries: [string, (m: ModuleQuality) => number, boolean][] = [
    ['interfaceWidth', (m) => m.shape.interfaceWidth, true],
    ['memberCount', (m) => m.shape.memberCount, true],
  ];
  const centralityEntries: [string, (m: ModuleQuality) => number, boolean][] = [
    ['directImporters', (m) => m.centrality.directImporters, true],
    ['blastRadius', (m) => m.centrality.blastRadius, true],
    ['transitiveDependencies', (m) => m.centrality.transitiveDependencies, true],
  ];
  const evolutionEntries: [string, (m: ModuleQuality) => number, boolean][] = [
    ['churn90d', (m) => m.evolution.churn90d, false],
    ['distinctAuthors', (m) => m.evolution.distinctAuthors, true],
    ['ownershipFragmentation', (m) => m.evolution.ownershipFragmentation, false],
    ['hiddenCouplingShare', (m) => m.evolution.hiddenCouplingShare, false],
  ];
  const protectionEntries: [string, (m: ModuleQuality) => number, boolean][] = [
    ['testedDependentsShare', (m) => m.protection.testedDependentsShare, true],
  ];

  for (const [key, getter, higherIsBetter] of complexityEntries) {
    const values = modules.map(getter);
    result.complexity[key] = percentileOf(values, higherIsBetter);
  }
  for (const [key, getter, higherIsBetter] of shapeEntries) {
    const values = modules.map(getter);
    result.shape[key] = percentileOf(values, higherIsBetter);
  }
  for (const [key, getter, higherIsBetter] of centralityEntries) {
    const values = modules.map(getter);
    result.centrality[key] = percentileOf(values, higherIsBetter);
  }
  for (const [key, getter, higherIsBetter] of evolutionEntries) {
    const values = modules.map(getter);
    result.evolution[key] = percentileOf(values, higherIsBetter);
  }
  for (const [key, getter, higherIsBetter] of protectionEntries) {
    const values = modules.map(getter);
    result.protection[key] = percentileOf(values, higherIsBetter);
  }

  return result;
}

function percentileOf(values: number[], higherIsBetter: boolean): PercentileMeasure {
  if (values.length === 0) {
    return { percentile: 0, value: 0 };
  }

  const validValues = values.filter((v) => v !== null && v !== undefined);
  if (validValues.length === 0) {
    return { percentile: 0, value: 0 };
  }

  const max = Math.max(...validValues);
  const min = Math.min(...validValues);
  const sum = validValues.reduce((s, v) => s + v, 0);
  const mean = sum / validValues.length;

  if (max === min) {
    return { percentile: 100, value: mean };
  }

  let percentile: number;
  if (higherIsBetter) {
    percentile = Math.round(((mean - min) / (max - min)) * 100);
  } else {
    percentile = Math.round(((max - mean) / (max - min)) * 100);
  }

  return { percentile, value: mean };
}

async function computeChurn(
  root: string,
  files: readonly string[],
  days = 90,
): Promise<Map<string, number>> {
  const churnMap = new Map<string, number>();
  for (const file of files) {
    try {
      const { stdout } = await run('git', ['log', '--oneline', `--since="${days}d ago"`, '--', file], {
        cwd: root,
        maxBuffer: 4 * 1024 * 1024,
      });
      churnMap.set(file, stdout.split('\n').filter(Boolean).length);
    } catch {
      churnMap.set(file, 0);
    }
  }
  return churnMap;
}

async function computeAuthors(
  root: string,
  files: readonly string[],
): Promise<Map<string, { authors: string[]; commits: number }>> {
  const history = await getFileAuthorHistory(root, files);
  const map = new Map<string, { authors: string[]; commits: number }>();
  for (const h of history) {
    map.set(h.file, { authors: h.authors, commits: h.commits });
  }
  return map;
}

async function computeCoChange(
  root: string,
  files: readonly string[],
): Promise<Map<string, Set<string>>> {
  const coChangeMap = new Map<string, Set<string>>();
  for (const file of files) {
    try {
      const { stdout } = await run('git', ['log', '--oneline', '--name-only', '-z', '--', file], {
        cwd: root,
        maxBuffer: 8 * 1024 * 1024,
      });
      const tokens = stdout.split('\0');
      const commitFiles = new Set<string>();
      for (const token of tokens) {
        if (token === '' || token === file) continue;
        if (/^[a-f0-9]{7,40}$/.test(token) || token.startsWith('commit')) continue;
        commitFiles.add(token);
      }
      coChangeMap.set(file, commitFiles);
    } catch {
      coChangeMap.set(file, new Set());
    }
  }
  return coChangeMap;
}
