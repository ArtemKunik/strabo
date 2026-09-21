import fs from 'node:fs';

import type { Graph } from '../types.ts';
import { buildAdjacency, computeGraphMetrics } from './analysis.ts';
import { computeCoverage } from './coverage.ts';
import { computeCycles } from './cycles.ts';
import { analyzeModuleDepth } from './depth.ts';
import { computeMemberCohesion } from './file-health.ts';
import { buildFunctions } from './functions.ts';
import { collectHistory } from './history.ts';
import { symbolExtractorFor } from '../scan/languages/registry.ts';
import { assertReadable } from '../boundary/repository-root.ts';

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

/** What the evolution measures read from Git, so a skipped mass commit is visible. */
export interface HistoryMeta {
  available: boolean;
  windowDays: number;
  commitsScanned: number;
  skippedCommits: Array<{ hash: string; files: number }>;
}

export interface QualityScorecard {
  repository: string;
  modules: ModuleQuality[];
  percentiles: QualityPercentile;
  history: HistoryMeta;
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

  const history = await collectHistory(
    root,
    nodes.map((n) => n.id),
  );
  const churnMap = history.churn;
  const authorMap = history.authors;
  const coChangeMap = history.coChange;

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
    history: {
      available: history.available,
      windowDays: history.windowDays,
      commitsScanned: history.commitsScanned,
      skippedCommits: history.skippedCommits,
    },
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
