import { computeCycles } from '../analysis/cycles.ts';
import { computeArchitectureHealth } from '../analysis/health.ts';
import { computeQualityScorecard, smellsFromScorecard } from '../analysis/quality.ts';
import { checkDeclaredRules, readDeclaredRules } from '../analysis/rules.ts';
import { computeStringEdges } from '../analysis/string-edges.ts';
import { buildTierReport } from '../analysis/tiers.ts';
import { resolveRepositoryRoot } from '../boundary/repository-root.ts';
import { getCachedGraph } from '../cache/graph-cache.ts';
import { revisionFromFingerprint } from '../status.ts';
import type { Graph, StraboConfig } from '../types.ts';
import { analyzeWorkspace } from '../workspace/analyze.ts';
import { resolveWorkspaceRepositories } from '../workspace/config.ts';
import { BASELINE_VERSION, type CheckBaseline } from './baseline.ts';
import { computeMeasuredCoverage } from '../analysis/measured-coverage.ts';
import { diffFile } from '../analysis/diff.ts';
import { computeChangedLineCoverage } from '../analysis/changed-coverage.ts';
import { reviewWorkingTree } from '../analysis/review.ts';
import { readWorkingFile } from '../analysis/git-content.ts';
import { symbolExtractorFor } from '../scan/languages/registry.ts';
import { buildFunctions } from '../analysis/functions.ts';

export type CheckRule =
  | 'cycles'
  | 'layer-violations'
  | 'new-smells'
  | 'health-regression'
  | 'data-contract-breaking'
  | 'data-no-single-writer'
  | 'data-unconformant'
  | 'uncovered-change'
  | 'coverage-stale';

export const CHECK_RULES: readonly CheckRule[] = [
  'cycles',
  'layer-violations',
  'new-smells',
  'health-regression',
  'data-contract-breaking',
  'data-no-single-writer',
  'data-unconformant',
  'uncovered-change',
  'coverage-stale',
];

/**
 * Names a `--fail-on` list may use, mapped onto the check rules. The short names are what a
 * CI author writes (`--fail-on cycle,tier`); the long names are accepted so a caller can
 * spell the rule out.
 */
export const FAIL_ON_ALIASES: Readonly<Record<string, CheckRule>> = {
  cycle: 'cycles',
  cycles: 'cycles',
  tier: 'layer-violations',
  layer: 'layer-violations',
  'layer-violations': 'layer-violations',
  smell: 'new-smells',
  smells: 'new-smells',
  'new-smells': 'new-smells',
  health: 'health-regression',
  'health-regression': 'health-regression',
  data: 'data-unconformant',
  'data-contract': 'data-contract-breaking',
  'data-breaking': 'data-contract-breaking',
  'data-contract-breaking': 'data-contract-breaking',
  'data-writer': 'data-no-single-writer',
  'data-no-writer': 'data-no-single-writer',
  'data-no-single-writer': 'data-no-single-writer',
  'data-conformance': 'data-unconformant',
  'data-unconformant': 'data-unconformant',
  'uncovered-change': 'uncovered-change',
  'uncovered-changes': 'uncovered-change',
  'coverage-stale': 'coverage-stale',
  'stale-coverage': 'coverage-stale',
};

/**
 * Resolve `--fail-on` values (each a comma-separated list) into check rules, in the stable
 * `CHECK_RULES` order. An unknown token is ignored rather than failing the build: only the
 * rules actually named can fail it.
 */
export function parseFailOnRules(values: readonly string[]): CheckRule[] {
  const named = new Set<CheckRule>();
  for (const value of values) {
    for (const token of value.split(',')) {
      const trimmed = token.trim().toLowerCase();
      const baseToken = trimmed.includes(':') ? trimmed.slice(0, trimmed.indexOf(':')) : trimmed;
      const rule = FAIL_ON_ALIASES[baseToken];
      if (rule) {
        named.add(rule);
      }
    }
  }
  return CHECK_RULES.filter((rule) => named.has(rule));
}

export function parseUncoveredChangeThreshold(values: readonly string[]): number | undefined {
  for (const value of values) {
    for (const token of value.split(',')) {
      const trimmed = token.trim().toLowerCase();
      if (trimmed.startsWith('uncovered-change:') || trimmed.startsWith('uncovered-changes:')) {
        const colon = trimmed.indexOf(':');
        const parsed = Number.parseInt(trimmed.slice(colon + 1), 10);
        if (Number.isFinite(parsed)) {
          return Math.max(0, Math.min(100, parsed));
        }
      }
    }
  }
  return undefined;
}

/**
 * The `--fail-on` tokens that are not built-in aliases: declared-architecture rule ids from
 * `strabo.rules.yml` (Phase 30 H4). Unknown ids are carried through and simply match nothing,
 * so only a rule the operator actually named can fail the build.
 */
export function parseDeclaredRuleIds(values: readonly string[]): string[] {
  const known = new Set(Object.keys(FAIL_ON_ALIASES));
  const ids: string[] = [];
  for (const value of values) {
    for (const token of value.split(',')) {
      const trimmed = token.trim();
      if (trimmed && !known.has(trimmed.toLowerCase()) && !ids.includes(trimmed)) {
        ids.push(trimmed);
      }
    }
  }
  return ids;
}

export interface CheckFinding {
  /** A built-in `CheckRule`, or a declared-rule id (Phase 30 H4). */
  rule: string;
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
  /** Workspace config path (`STRABO_CONFIG`), so the data rules see the declared repositories. */
  configPath?: string;
  requested?: string;
  rules?: readonly string[];
  baseline?: CheckBaseline | null;
  healthRegressionPct?: number;
  uncoveredChangeThreshold?: number;
  now?: () => Date;
}

export interface CheckResult {
  repository: string;
  root: string;
  revision: string | null;
  fingerprint: string | null;
  generatedAt: string;
  rules: string[];
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
    const flowNote = `[tierFlow: ${tiers.tierFlow.edges.length} cross-tier edges, intra-ratio ${Math.round(tiers.tierFlow.intraRatio * 100)}%]`;
    findings.push({
      rule: 'layer-violations',
      key: `layer:${direction.unit}:${direction.source}->${direction.target}:${direction.kind}`,
      node: `${direction.source} -> ${direction.target}`,
      detail: `${direction.sourceTier} depends on ${direction.targetTier} (${direction.kind}) in unit ${direction.unit} ${flowNote}`,
      inputs: {
        unit: direction.unit,
        source: direction.source,
        target: direction.target,
        kind: direction.kind,
        line: direction.line,
        crossTierEdges: tiers.tierFlow.edges.length,
        intraRatio: tiers.tierFlow.intraRatio,
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

  // Declared architecture (Phase 30 H4): a rule id from strabo.rules.yml becomes a finding,
  // so `strabo check --fail-on <rule-id>` fails on the edges the operator forbade.
  const declaredRules = readDeclaredRules(root);
  if (declaredRules.length > 0) {
    const stringEdges = await computeStringEdges(root, graph);
    const report = checkDeclaredRules(declaredRules, graph, { stringEdges });
    for (const violation of report.violations) {
      findings.push({
        rule: violation.rule,
        key: `rule:${violation.rule}:${violation.edge.source}->${violation.edge.target}:${violation.edge.line}`,
        node: `${violation.edge.source} -> ${violation.edge.target}`,
        detail: violation.detail,
        inputs: {
          rule: violation.rule,
          kind: violation.edge.kind,
          line: violation.edge.line,
          specifier: violation.edge.specifier,
        },
      });
    }
  }

  return findings.sort((a, b) => a.key.localeCompare(b.key));
}

/** The check rules that read the workspace data layer (Phase 33 J10) rather than one graph. */
const DATA_RULES: ReadonlySet<string> = new Set(['data-contract-breaking', 'data-no-single-writer', 'data-unconformant']);

/**
 * Findings from the recorded data layer: a dataset shared with no single writer, a dataset
 * read across a repository boundary with no contract, and a declared contract that does not
 * match its implementation. Each names only what the scan recorded.
 */
export async function collectDataFindings(options: CheckOptions): Promise<CheckFinding[]> {
  const scanCeiling = options.scanCeiling ?? options.workspaceRoot;
  const config: StraboConfig = {
    workspaceRoot: options.workspaceRoot,
    scanCeiling,
    ...(options.configPath ? { configPath: options.configPath } : {}),
  };
  const { name, repositories } = resolveWorkspaceRepositories(config);
  const workspace = await analyzeWorkspace(name, repositories);
  const governed = new Set(
    workspace.data.edges.filter((edge) => edge.kind === 'governs').map((edge) => edge.target),
  );
  const findings: CheckFinding[] = [];

  for (const candidate of workspace.data.candidates) {
    if (candidate.kind === 'no-single-writer') {
      findings.push({
        rule: 'data-no-single-writer',
        key: `data-writer:${candidate.dataset}`,
        node: candidate.dataset,
        detail: candidate.detail,
        inputs: { writers: candidate.writers.length, readers: candidate.readers.length },
      });
    } else if (candidate.kind === 'shared-without-contract') {
      findings.push({
        rule: 'data-contract-breaking',
        key: `data-breaking:${candidate.dataset}`,
        node: candidate.dataset,
        detail: candidate.detail,
        inputs: { readers: candidate.readers.length },
      });
    }
  }

  for (const finding of workspace.data.conformance) {
    const rule = finding.dataset && governed.has(finding.dataset) ? 'data-contract-breaking' : 'data-unconformant';
    findings.push({
      rule,
      key: `data-conformance:${finding.contract}:${finding.dataset ?? ''}:${finding.field}:${finding.kind}`,
      node: finding.dataset ?? finding.contract,
      detail: finding.detail,
      inputs: { kind: finding.kind, field: finding.field, contract: finding.contract },
    });
  }

  return findings;
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
  if (rules.some((rule) => DATA_RULES.has(rule))) {
    collected.push(...(await collectDataFindings({ ...options, workspaceRoot: options.workspaceRoot })));
  }

  const warnings: CheckWarning[] = [];
  if (rules.includes('coverage-stale') || rules.includes('uncovered-change')) {
    const measured = await computeMeasuredCoverage(repository.root, graph);

    if (rules.includes('coverage-stale')) {
      if (!measured.available) {
        warnings.push({
          rule: 'coverage-stale',
          detail: `no coverage report available (${measured.reason ?? 'missing'}) to assess staleness`,
        });
      } else {
        for (const file of measured.files) {
          if (file.stale === true) {
            collected.push({
              rule: 'coverage-stale',
              key: `coverage-stale:${file.file}`,
              node: file.file,
              detail: `coverage report predates last commit on ${file.file}`,
              inputs: { file: file.file, reportModified: measured.reportModified ?? '' },
            });
          }
        }
      }
    }

    if (rules.includes('uncovered-change')) {
      const review = await reviewWorkingTree(repository.root, graph);
      const reviewFiles = review.available ? review.files : [];
      const threshold = options.uncoveredChangeThreshold ?? 100;

      for (const file of reviewFiles) {
        if (file.status === 'deleted') continue;
        const diffResult = await diffFile(repository.root, {
          file: file.path,
          untracked: file.status === 'untracked',
        });
        if (diffResult.available) {
          const extractor = symbolExtractorFor(file.path);
          let functions;
          if (extractor) {
            const content = readWorkingFile(repository.root, file.path);
            if (content !== null) {
              try {
                const extraction = await extractor.extract(file.path, content);
                functions = buildFunctions(file.path, extraction.symbols, extraction.calls ?? []).functions;
              } catch {
                // ignore
              }
            }
          }
          const item = computeChangedLineCoverage(diffResult.diff, measured, { functions });
          if (item.linesChanged > 0) {
            if (item.basis === 'stale') {
              collected.push({
                rule: 'uncovered-change',
                key: `uncovered-change:${file.path}:stale`,
                node: file.path,
                detail: `cannot verify changed-line coverage: coverage report predates the change`,
                inputs: { file: file.path, linesChanged: item.linesChanged, basis: 'stale' },
              });
            } else if (item.basis === 'unavailable') {
              collected.push({
                rule: 'uncovered-change',
                key: `uncovered-change:${file.path}:uncovered`,
                node: file.path,
                detail: `${item.linesChanged} changed lines with no coverage report (${item.note ?? 'unavailable'})`,
                inputs: { file: file.path, linesChanged: item.linesChanged, percent: 0, threshold },
              });
            } else if (item.coveragePercent !== null && item.coveragePercent < threshold) {
              const fnNames = item.uncoveredFunctions.map((fn) => `\`${fn.name}\``).join(', ');
              const fnDetail = fnNames ? `; changed and uncovered: ${fnNames}` : '';
              collected.push({
                rule: 'uncovered-change',
                key: `uncovered-change:${file.path}:${item.coveragePercent}`,
                node: file.path,
                detail: `${item.linesCovered} of ${item.linesChanged} changed lines covered (${item.coveragePercent}% < ${threshold}% threshold)${fnDetail}`,
                inputs: {
                  file: file.path,
                  linesCovered: item.linesCovered,
                  linesChanged: item.linesChanged,
                  percent: item.coveragePercent,
                  threshold,
                },
              });
            }
          }
        }
      }
    }
  }

  const healthScore = computeArchitectureHealth(graph).score;
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
