import { computeCycles } from '../analysis/cycles.ts';
import { computeArchitectureHealth } from '../analysis/health.ts';
import { computeQualityScorecard, smellsFromScorecard } from '../analysis/quality.ts';
import { buildTierReport } from '../analysis/tiers.ts';
import { resolveRepositoryRoot } from '../boundary/repository-root.ts';
import { getCachedGraph } from '../cache/graph-cache.ts';
import { revisionFromFingerprint } from '../status.ts';
import type { Graph } from '../types.ts';
import { BASELINE_VERSION, type CheckBaseline } from './baseline.ts';

export type CheckRule = 'cycles' | 'layer-violations' | 'new-smells' | 'health-regression';

export const CHECK_RULES: readonly CheckRule[] = [
  'cycles',
  'layer-violations',
  'new-smells',
  'health-regression',
];

export interface CheckFinding {
  rule: CheckRule;
  key: string;
  node: string;
  detail: string;
  inputs?: Record<string, number | string | boolean>;
}

export interface CheckWarning {
  rule: string;
  detail: string;
}

export interface CheckOptions {
  workspaceRoot: string;
  scanCeiling?: string;
  requested?: string;
  rules?: readonly CheckRule[];
  baseline?: CheckBaseline | null;
  healthRegressionPct?: number;
  now?: () => Date;
}

export interface CheckResult {
  repository: string;
  root: string;
  revision: string | null;
  fingerprint: string | null;
  generatedAt: string;
  rules: CheckRule[];
  findings: CheckFinding[];
  baselined: string[];
  warnings: CheckWarning[];
  passed: boolean;
  healthScore: number | null;
  baselineHealthScore: number | null;
}

export async function collectFindings(
  root: string,
  repository: string,
  graph: Graph,
  includeSmells: boolean,
): Promise<CheckFinding[]> {
  const findings: CheckFinding[] = [];

  for (const group of computeCycles(graph)) {
    findings.push({
      rule: 'cycles',
      key: `cycles:${group.id}`,
      node: group.id,
      detail: `${group.members.length} files form a dependency cycle`,
      inputs: { members: group.members.length },
    });
  }

  const tiers = buildTierReport(root, repository, graph);
  for (const direction of tiers.directions) {
    findings.push({
      rule: 'layer-violations',
      key: `layer:${direction.unit}:${direction.source}->${direction.target}:${direction.kind}`,
      node: `${direction.source} -> ${direction.target}`,
      detail: `${direction.sourceTier} depends on ${direction.targetTier} (${direction.kind}) in unit ${direction.unit}`,
      inputs: {
        unit: direction.unit,
        source: direction.source,
        target: direction.target,
        kind: direction.kind,
        line: direction.line,
      },
    });
  }

  if (includeSmells) {
    const scorecard = await computeQualityScorecard(graph, root, repository);
    for (const entry of smellsFromScorecard(scorecard).files) {
      for (const smell of entry.smells) {
        findings.push({
          rule: 'new-smells',
          key: `smell:${entry.file}:${smell.rule}`,
          node: entry.file,
          detail: smell.detail,
          inputs: { rule: smell.rule, ...smell.inputs },
        });
      }
    }
  }

  return findings.sort((a, b) => a.key.localeCompare(b.key));
}

export async function runCheck(options: CheckOptions): Promise<CheckResult> {
  const now = options.now ?? (() => new Date());
  const repository = resolveRepositoryRoot({
    workspaceRoot: options.workspaceRoot,
    scanCeiling: options.scanCeiling ?? options.workspaceRoot,
    requested: options.requested,
  });
  const cached = await getCachedGraph(repository.root);
  const graph = cached.report.graph;
  const rules = [...(options.rules ?? [])];

  const collected = await collectFindings(
    repository.root,
    repository.name,
    graph,
    rules.includes('new-smells'),
  );
  const healthScore = computeArchitectureHealth(graph).score;

  const warnings: CheckWarning[] = [];
  if (rules.length === 0) {
    warnings.push({ rule: 'check', detail: 'no rules enabled; nothing can fail this build' });
  }

  const enabled = collected.filter((finding) => rules.includes(finding.rule));
  const baselineKeys = new Set(options.baseline?.findings ?? []);
  const baselined = enabled.filter((finding) => baselineKeys.has(finding.key));
  const findings = enabled.filter((finding) => !baselineKeys.has(finding.key));

  const baselineHealthScore = options.baseline?.healthScore ?? null;
  if (rules.includes('health-regression')) {
    if (baselineHealthScore === null) {
      warnings.push({
        rule: 'health-regression',
        detail: 'no baseline health score recorded; run check --write-baseline first',
      });
    } else if (healthScore !== null) {
      const threshold = baselineHealthScore - Math.abs(options.healthRegressionPct ?? 0);
      if (healthScore < threshold) {
        findings.push({
          rule: 'health-regression',
          key: 'health:score',
          node: repository.name,
          detail: `health score ${healthScore} is below the baseline ${baselineHealthScore}`,
          inputs: { healthScore, baselineHealthScore },
        });
      }
    }
  }

  findings.sort((a, b) => a.key.localeCompare(b.key));
  return {
    repository: repository.name,
    root: repository.root,
    revision: revisionFromFingerprint(cached.fingerprint),
    fingerprint: cached.fingerprint,
    generatedAt: now().toISOString(),
    rules,
    findings,
    baselined: baselined.map((finding) => finding.key),
    warnings,
    passed: findings.length === 0,
    healthScore,
    baselineHealthScore,
  };
}

export async function buildBaseline(options: CheckOptions): Promise<CheckBaseline> {
  const now = options.now ?? (() => new Date());
  const repository = resolveRepositoryRoot({
    workspaceRoot: options.workspaceRoot,
    scanCeiling: options.scanCeiling ?? options.workspaceRoot,
    requested: options.requested,
  });
  const cached = await getCachedGraph(repository.root);
  const findings = await collectFindings(repository.root, repository.name, cached.report.graph, true);
  return {
    version: BASELINE_VERSION,
    repository: repository.name,
    revision: revisionFromFingerprint(cached.fingerprint),
    fingerprint: cached.fingerprint,
    generatedAt: now().toISOString(),
    findings: [...new Set(findings.map((finding) => finding.key))].sort(),
    healthScore: computeArchitectureHealth(cached.report.graph).score,
  };
}
