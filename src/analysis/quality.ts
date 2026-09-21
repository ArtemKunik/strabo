import fs from 'node:fs';

import type { Graph, NodeKind } from '../types.ts';
import { buildAdjacency, computeGraphMetrics } from './analysis.ts';
import { computeCoverage } from './coverage.ts';
import { computeCycles } from './cycles.ts';
import { analyzeModuleDepth } from './depth.ts';
import { computeMemberCohesion } from './file-health.ts';
import { buildFunctions } from './functions.ts';
import { collectHistory } from './history.ts';
import { classifyTierContent, tierRank, type Tier } from './tiers.ts';
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
  /** Files that changed in the same commits, in the window. */
  coChangePartners: number;
  /** Of those, the ones this file does not import. */
  unimportedPartners: number;
}

export interface ProtectionMeasures {
  testReach: boolean;
  testedDependentsShare: number;
}

/** A smell rule over the measures. A signal, not a verdict; each carries its tripping inputs. */
export type SmellRule =
  | 'god-module'
  | 'hub-dependency'
  | 'unstable-dependency'
  | 'shotgun-surgery'
  | 'hidden-coupling'
  | 'cyclic'
  | 'tier-leak'
  | 'dead'
  | 'pass-through';

export interface Smell {
  rule: SmellRule;
  detail: string;
  inputs: Record<string, number | string | boolean>;
}

/**
 * The composite scores. Each input is a repository percentile (0-100); the products answer
 * "where would a change here hurt" (hotspot) and "how bad would it be" (risk).
 */
export interface CompositeScores {
  /** Mean of the complexity sub-percentiles. */
  complexity: number;
  /** Churn percentile: a hot file is high. */
  churn: number;
  /** complexity × churn / 100, after Tornhill. */
  hotspot: number;
  /** Blast-radius percentile. */
  blastRadius: number;
  /** 100 when a test reaches the module, else 0. */
  testReach: number;
  /** hotspot × blastRadius × (1 − testReach), 0-100. */
  risk: number;
}

export interface ModuleQuality {
  file: string;
  complexity: ComplexityMeasures;
  shape: ShapeMeasures;
  centrality: CentralityMeasures;
  evolution: EvolutionMeasures;
  protection: ProtectionMeasures;
  /** The role tier this file mostly plays, from the Phase 16 classification. */
  tier: Tier;
  /** True when two tiers shared the strongest evidence, so no single tier was claimed. */
  tierMixed: boolean;
  scores: CompositeScores;
  smells: Smell[];
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
    // Read the file once: complexity, shape, and the tier classification all read it.
    const content = readSource(root, file);
    const centrality = computeCentrality(file, metrics, cycleMembers);
    const complexity = await computeComplexity(file, content);
    const shape = await computeShape(file, content, depthByFile, centrality);
    const evolution = computeEvolution(file, churnMap, authorMap, coChangeMap, importGraph);
    const protection = computeProtection(file, coverage, backward);
    const classification = content === null ? null : classifyTierContent(file, content);

    moduleQualities.push({
      file,
      complexity,
      shape,
      centrality,
      evolution,
      protection,
      tier: classification?.tier ?? 'unclassified',
      tierMixed: classification?.mixed ?? false,
      scores: emptyScores(),
      smells: [],
    });
  }

  const scores = computeCompositeScores(moduleQualities);
  const smellContext = buildSmellContext(graph, importGraph, moduleQualities);
  for (const module of moduleQualities) {
    module.scores = scores.get(module.file) ?? emptyScores();
    module.smells = computeSmells(module, smellContext);
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
  file: string,
  content: string | null,
): Promise<ComplexityMeasures> {
  let loc = 0;
  let functionCount = 0;
  let sumDecisionPoints = 0;
  let maxDecisionPoints = 0;
  let maxNestingDepth = 0;
  let signalFunctions = 0;

  const extractor = content === null ? null : symbolExtractorFor(file);

  if (extractor && content !== null) {
    try {
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
  file: string,
  content: string | null,
  depthByFile: Map<string, { interfaceWidth: number; signal: string }>,
  centrality: CentralityMeasures,
): Promise<ShapeMeasures> {
  const depth = depthByFile.get(file);
  const depthSignal = depth?.signal ?? 'ok';
  const interfaceWidth = depth?.interfaceWidth ?? 0;

  const extractor = content === null ? null : symbolExtractorFor(file);
  let cohesion: number | null = null;
  let memberCount = 0;

  if (extractor && content !== null) {
    try {
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

  return {
    churn90d,
    distinctAuthors,
    ownershipFragmentation,
    hiddenCouplingShare,
    coChangePartners: coChangeFiles.size,
    unimportedPartners: hiddenCouplingCount,
  };
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

function readSource(root: string, file: string): string | null {
  try {
    const resolved = assertReadable(root, file);
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) {
      return null;
    }
    const content = fs.readFileSync(resolved);
    return content.includes(0) ? null : content.toString('utf8');
  } catch {
    return null;
  }
}

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

function emptyScores(): CompositeScores {
  return { complexity: 0, churn: 0, hotspot: 0, blastRadius: 0, testReach: 0, risk: 0 };
}

/** Share of the values below this one, 0-100; the maximum is 100 and the minimum is 0. */
function rankPercentile(values: readonly number[], value: number): number {
  if (values.length <= 1) {
    return 100;
  }
  let less = 0;
  for (const candidate of values) {
    if (candidate < value) {
      less += 1;
    }
  }
  return Math.round((less / (values.length - 1)) * 100);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Hotspot (complexity × churn) and risk (hotspot × blast radius × untested share) per file. */
function computeCompositeScores(modules: readonly ModuleQuality[]): Map<string, CompositeScores> {
  const loc = modules.map((m) => m.complexity.loc);
  const functions = modules.map((m) => m.complexity.functionCount);
  const sumDecision = modules.map((m) => m.complexity.sumDecisionPoints);
  const maxDecision = modules.map((m) => m.complexity.maxDecisionPoints);
  const nesting = modules.map((m) => m.complexity.maxNestingDepth);
  const signals = modules.map((m) => m.complexity.signalShare);
  const churn = modules.map((m) => m.evolution.churn90d);
  const blast = modules.map((m) => m.centrality.blastRadius);

  const scores = new Map<string, CompositeScores>();
  for (const module of modules) {
    const complexity = Math.round(
      mean([
        rankPercentile(loc, module.complexity.loc),
        rankPercentile(functions, module.complexity.functionCount),
        rankPercentile(sumDecision, module.complexity.sumDecisionPoints),
        rankPercentile(maxDecision, module.complexity.maxDecisionPoints),
        rankPercentile(nesting, module.complexity.maxNestingDepth),
        rankPercentile(signals, module.complexity.signalShare),
      ]),
    );
    const churnScore = rankPercentile(churn, module.evolution.churn90d);
    const blastScore = rankPercentile(blast, module.centrality.blastRadius);
    const testReach = module.protection.testReach ? 100 : 0;
    const hotspot = Math.round((complexity * churnScore) / 100);
    const risk = Math.round((hotspot * blastScore * (100 - testReach)) / 10000);
    scores.set(module.file, { complexity, churn: churnScore, hotspot, blastRadius: blastScore, testReach, risk });
  }
  return scores;
}

interface SmellContext {
  kind: Map<string, NodeKind>;
  importGraph: Map<string, Set<string>>;
  tierOf: Map<string, Tier>;
  /** Instability out / (in + out), or null when the file has no edges either way. */
  stability: Map<string, number | null>;
  inRank: Map<string, number>;
  outRank: Map<string, number>;
}

function buildSmellContext(
  graph: Graph,
  importGraph: Map<string, Set<string>>,
  modules: readonly ModuleQuality[],
): SmellContext {
  const kind = new Map<string, NodeKind>();
  for (const node of graph.nodes) {
    kind.set(node.id, node.kind);
  }
  const tierOf = new Map(modules.map((m) => [m.file, m.tier]));
  const stability = new Map<string, number | null>();
  for (const module of modules) {
    const incoming = module.centrality.directImporters;
    const outgoing = (importGraph.get(module.file) ?? new Set()).size;
    stability.set(module.file, incoming + outgoing > 0 ? outgoing / (incoming + outgoing) : null);
  }
  const importers = modules.map((m) => m.centrality.directImporters);
  const dependencies = modules.map((m) => m.centrality.transitiveDependencies);
  const inRank = new Map(modules.map((m) => [m.file, rankPercentile(importers, m.centrality.directImporters)]));
  const outRank = new Map(
    modules.map((m) => [m.file, rankPercentile(dependencies, m.centrality.transitiveDependencies)]),
  );
  return { kind, importGraph, tierOf, stability, inRank, outRank };
}

/** The targets this file imports that sit in a higher tier, the direction-check violation. */
function upwardTargets(file: string, context: SmellContext): string[] {
  const own = tierRank(context.tierOf.get(file) ?? 'unclassified');
  if (own === null) {
    return [];
  }
  const upward: string[] = [];
  for (const target of context.importGraph.get(file) ?? []) {
    const rank = tierRank(context.tierOf.get(target) ?? 'unclassified');
    if (rank !== null && rank > own) {
      upward.push(target);
    }
  }
  return upward;
}

function computeSmells(module: ModuleQuality, context: SmellContext): Smell[] {
  const smells: Smell[] = [];
  const { centrality, shape, evolution, scores, file } = module;

  if (
    scores.complexity >= 80 &&
    shape.memberCount >= 20 &&
    (shape.cohesion === null || shape.cohesion < 0.3) &&
    centrality.directImporters >= 3
  ) {
    smells.push({
      rule: 'god-module',
      detail: 'large and many-membered, with low cohesion, and imported by others',
      inputs: {
        complexityPercentile: scores.complexity,
        memberCount: shape.memberCount,
        cohesion: shape.cohesion ?? 'unavailable',
        directImporters: centrality.directImporters,
      },
    });
  }

  if ((context.inRank.get(file) ?? 0) >= 80 && (context.outRank.get(file) ?? 0) >= 80) {
    smells.push({
      rule: 'hub-dependency',
      detail: 'depends on many modules and is depended on by many',
      inputs: {
        importerPercentile: context.inRank.get(file) ?? 0,
        dependencyPercentile: context.outRank.get(file) ?? 0,
        directImporters: centrality.directImporters,
        transitiveDependencies: centrality.transitiveDependencies,
      },
    });
  }

  const ownStability = context.stability.get(file);
  if (ownStability !== null && ownStability !== undefined) {
    let worst: { target: string; stability: number } | null = null;
    for (const target of context.importGraph.get(file) ?? []) {
      const targetStability = context.stability.get(target);
      if (
        targetStability !== null &&
        targetStability !== undefined &&
        targetStability > ownStability + 0.2 &&
        (worst === null || targetStability > worst.stability)
      ) {
        worst = { target, stability: targetStability };
      }
    }
    if (worst !== null) {
      smells.push({
        rule: 'unstable-dependency',
        detail: `depends on ${worst.target}, which is less stable than it is`,
        inputs: {
          instability: Number(ownStability.toFixed(3)),
          dependency: worst.target,
          dependencyInstability: Number(worst.stability.toFixed(3)),
        },
      });
    }
  }

  if (evolution.unimportedPartners >= 5) {
    smells.push({
      rule: 'shotgun-surgery',
      detail: 'usually changes with files it does not import',
      inputs: {
        unimportedPartners: evolution.unimportedPartners,
        coChangePartners: evolution.coChangePartners,
        hiddenCouplingShare: Number(evolution.hiddenCouplingShare.toFixed(3)),
      },
    });
  }

  if (evolution.hiddenCouplingShare >= 0.5 && evolution.coChangePartners >= 2) {
    smells.push({
      rule: 'hidden-coupling',
      detail: 'half or more of its co-change has no import path',
      inputs: {
        hiddenCouplingShare: Number(evolution.hiddenCouplingShare.toFixed(3)),
        coChangePartners: evolution.coChangePartners,
      },
    });
  }

  if (centrality.inCycle) {
    smells.push({
      rule: 'cyclic',
      detail: 'sits in a dependency cycle',
      inputs: { transitiveDependencies: centrality.transitiveDependencies },
    });
  }

  if (module.tierMixed) {
    smells.push({
      rule: 'tier-leak',
      detail: 'two tiers share the strongest evidence',
      inputs: { tier: module.tier, mixed: true },
    });
  } else {
    const upward = upwardTargets(file, context);
    if (upward.length > 0) {
      smells.push({
        rule: 'tier-leak',
        detail: 'depends on a higher tier',
        inputs: { tier: module.tier, upward: upward.slice(0, 5).join(', '), count: upward.length },
      });
    }
  }

  if ((context.kind.get(file) ?? 'module') === 'module' && centrality.directImporters === 0) {
    smells.push({
      rule: 'dead',
      detail: 'nothing imports it, and it is not an entry point or a test',
      inputs: { directImporters: 0 },
    });
  }

  if (shape.depthSignal === 'pass-through') {
    smells.push({
      rule: 'pass-through',
      detail: 'mostly re-exports, with little of its own',
      inputs: { interfaceWidth: shape.interfaceWidth, depthSignal: shape.depthSignal },
    });
  }

  return smells;
}

export const SMELL_RULES: SmellRule[] = [
  'god-module',
  'hub-dependency',
  'unstable-dependency',
  'shotgun-surgery',
  'hidden-coupling',
  'cyclic',
  'tier-leak',
  'dead',
  'pass-through',
];

export interface SmellsReport {
  repository: string;
  files: Array<{ file: string; smells: Smell[] }>;
  summary: Record<SmellRule, number>;
}

/** The repository-wide smells view, projected from a scorecard's per-module smells. */
export function smellsFromScorecard(scorecard: QualityScorecard): SmellsReport {
  const summary = Object.fromEntries(SMELL_RULES.map((rule) => [rule, 0])) as Record<SmellRule, number>;
  const files: Array<{ file: string; smells: Smell[] }> = [];
  for (const module of scorecard.modules) {
    if (module.smells.length === 0) {
      continue;
    }
    files.push({ file: module.file, smells: module.smells });
    for (const smell of module.smells) {
      summary[smell.rule] += 1;
    }
  }
  return { repository: scorecard.repository, files, summary };
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
