import { computeGraphMetrics } from '../analysis/analysis.ts';
import { computeCycles } from '../analysis/cycles.ts';
import { detectCoverageEcosystems } from '../analysis/coverage-refresh.ts';
import { DEFAULT_COVERAGE_REPORT_PATHS, type MeasuredCoverageSummary } from '../analysis/measured-coverage.ts';
import { computeRepositoryPassport, computeUntested } from '../analysis/passport.ts';
import type { DataReport, DependencyAdvisory, Graph, RiskReport } from '../types.ts';
import type { ContractBoundaryReport } from '../analysis/data/contracts-graph.ts';
import type { SmellRule, SmellsReport } from '../analysis/quality.ts';
import type { HotspotReport } from '../analysis/hotspots.ts';
import type { OwnershipContext } from '../analysis/ownership.ts';
import type { TierReport } from '../analysis/tiers/types.ts';
import { buildTierDataFlow, type TierDataFlow } from '../analysis/tiers/data-flow.ts';
import {
  DEFAULT_REPORT_LIMITS,
  SEVERITY_ORDER,
  type PainPoint,
  type RepositoryContractsSection,
  type RepositoryCoverageSection,
  type RepositoryDataFlowSection,
  type RepositoryDataSection,
  type RepositoryReportDocument,
  type RepositoryReportInputs,
  type RepositoryStructureSection,
  type ReportLimits,
  type Severity,
} from './report-types.ts';
import { suggestionFor } from './suggestions.ts';

export * from './report-types.ts';

/** The smell rules with a fixed severity. `cyclic` is left out; cycles are one point each. */
const SMELL_SEVERITY: Record<Exclude<SmellRule, 'cyclic'>, Severity> = {
  'god-module': 'high',
  'hub-dependency': 'medium',
  'unstable-dependency': 'medium',
  'shotgun-surgery': 'medium',
  'hidden-coupling': 'medium',
  'tier-leak': 'high',
  dead: 'low',
  'pass-through': 'low',
};

const ADVISORY_SEVERITY: Record<DependencyAdvisory['severity'], Severity> = {
  critical: 'critical',
  high: 'high',
  moderate: 'medium',
  low: 'low',
  unknown: 'medium',
};

/**
 * Build the whole-repository report from the recorded graph and the analyses a caller already
 * computed. Pure: no I/O, no Git, no network. A section whose input is absent is named in
 * `evidence.unavailable` rather than shown as empty.
 */
export function buildRepositoryReport(inputs: RepositoryReportInputs): RepositoryReportDocument {
  const { graph } = inputs;
  const limits: ReportLimits = { ...DEFAULT_REPORT_LIMITS, ...inputs.limits };
  const unavailable: string[] = [];
  const warnings: string[] = [];

  const measured = inputs.coverage && 'summary' in inputs.coverage ? inputs.coverage : null;
  const passport = computeRepositoryPassport(
    inputs.repository,
    graph,
    inputs.extensionCounts ?? {},
    10,
    measured,
  );

  const painPoints: PainPoint[] = [];
  painPoints.push(...cyclePoints(graph));
  painPoints.push(...untestedPoints(graph, limits.untested, measured));

  if (inputs.smells) {
    painPoints.push(...smellPoints(inputs.smells));
  } else {
    unavailable.push('quality smells were not computed');
  }
  if (inputs.hotspots) {
    painPoints.push(...hotspotPoints(inputs.hotspots, limits.hotspots));
  } else {
    unavailable.push('function hotspots were not computed');
  }
  if (inputs.ownership) {
    painPoints.push(...busFactorPoints(inputs.ownership, limits.busFactor));
  } else {
    unavailable.push('ownership history was not computed');
  }
  if (inputs.risk) {
    if (!inputs.risk.online) {
      warnings.push('dependency advisories require the opt-in online lookup (STRABO_RISK)');
    }
    painPoints.push(...riskPoints(inputs.risk));
  } else {
    unavailable.push('dependency risk was not computed');
  }
  painPoints.push(...diagnosticPoints(graph));
  if (inputs.revision?.stale) {
    painPoints.push({
      id: 'stale-graph',
      kind: 'stale-graph',
      severity: 'low',
      location: [],
      summary: 'the served graph is older than the working tree',
      inputs: { fingerprint: inputs.revision.fingerprint ?? 'none' },
    });
  }

  painPoints.sort(comparePainPoints);
  const truncated = painPoints.length > limits.painPoints;
  const shown = truncated ? painPoints.slice(0, limits.painPoints) : painPoints;

  let data: RepositoryDataSection | null = null;
  if (inputs.data) {
    data = dataSection(inputs.data);
  } else {
    unavailable.push('the data layer was not computed');
  }

  let contracts: RepositoryContractsSection | null = null;
  if (inputs.contracts) {
    contracts = contractsSection(inputs.contracts);
  } else {
    unavailable.push('contract boundaries were not computed');
  }

  let coverage: RepositoryCoverageSection | null = null;
  if (inputs.coverage) {
    coverage = coverageSection(inputs.coverage, inputs.root);
  }

  let structure: RepositoryStructureSection | null = null;
  if (inputs.structure) {
    structure = structureSection(inputs.structure, inputs.data);
  } else {
    unavailable.push('logical structure was not computed');
  }

  return {
    schema: 'strabo-report-1',
    repository: inputs.repository,
    root: inputs.root ?? null,
    generatedAt: inputs.generatedAt ?? new Date().toISOString(),
    revision: inputs.revision ?? { head: null, fingerprint: null, scannedAt: null, stale: false },
    overview: passport,
    painPoints: shown,
    change: inputs.change ?? null,
    drift: inputs.drift ?? null,
    data,
    contracts,
    coverage,
    structure,
    suggestions: shown.map(suggestionFor),
    evidence: {
      files: graph.nodes.length,
      edges: graph.edges.length,
      diagnostics: graph.diagnostics.length,
      excluded: graph.excluded.length,
      painPointsBySeverity: countBySeverity(shown),
      truncated,
      unavailable,
      warnings,
    },
  };
}

/** Map measured coverage (or reachability fallback) into the report's coverage section. */
function coverageSection(
  coverage: MeasuredCoverageSummary | RepositoryCoverageSection,
  root?: string,
): RepositoryCoverageSection {
  if ('filesMeasured' in coverage && !('summary' in coverage)) {
    return coverage as RepositoryCoverageSection;
  }
  const measured = coverage as MeasuredCoverageSummary;
  const suggestions =
    !measured.available && root
      ? detectCoverageEcosystems(root)
      : measured.refresh?.command
        ? [{ ecosystem: measured.refresh.runner ?? 'package', command: measured.refresh.command }]
        : [];

  return {
    available: measured.available,
    basis: measured.basis,
    format: measured.format,
    reportPath: measured.reportPath,
    reportModified: measured.reportModified,
    reportAgeMs: measured.reportAgeMs,
    lineCoverage: measured.summary.lineCoverage,
    linesFound: measured.summary.linesFound,
    linesHit: measured.summary.linesHit,
    filesMeasured: measured.summary.filesMeasured,
    stale: measured.stale,
    outOfGraph: measured.outOfGraph,
    ...(measured.reason ? { reason: measured.reason } : {}),
    ...(measured.detail ? { detail: measured.detail } : {}),
    refreshCommand: measured.refresh?.command ?? null,
    checkedLocations: measured.available ? undefined : [...DEFAULT_COVERAGE_REPORT_PATHS],
    suggestedCommands: suggestions.length > 0 ? suggestions : undefined,
  };
}

/** Trim a computed tier report into the report's structure section. */
function structureSection(
  report: TierReport | RepositoryStructureSection,
  data?: DataReport,
): RepositoryStructureSection {
  if ('summary' in report && 'classified' in report.summary) {
    const section = report as RepositoryStructureSection;
    return { ...section, dataFlow: section.dataFlow ?? null };
  }
  const tierReport = report as TierReport;
  return {
    tierFlow: tierReport.tierFlow,
    shelf: tierReport.shelf,
    summary: {
      classified: tierReport.summary.total - tierReport.summary.unclassified,
      unclassified: tierReport.summary.unclassified,
      mixed: tierReport.summary.mixed,
    },
    directions: tierReport.directions.map((d) => ({
      source: d.source,
      target: d.target,
      sourceTier: d.sourceTier,
      targetTier: d.targetTier,
      kind: d.kind,
      unit: d.unit,
      line: d.line,
    })),
    // The Phase 37 data-flow reading needs the Data layer; without it the section says null
    // rather than showing an empty reading as if nothing flowed.
    dataFlow: data ? dataFlowSection(buildTierDataFlow(tierReport, data)) : null,
  };
}

/** Most cross-tier pairs listed before the report says it truncated. */
const DATA_FLOW_PAIR_LIMIT = 40;

function dataFlowSection(flow: TierDataFlow): RepositoryDataFlowSection {
  return {
    hubs: flow.summary.hubs,
    reads: flow.summary.reads,
    writes: flow.summary.writes,
    crossTier: flow.summary.crossTier,
    governed: flow.summary.governed,
    uncontracted: flow.summary.uncontracted,
    unclassified: flow.summary.unclassified,
    pairs: flow.pairs.slice(0, DATA_FLOW_PAIR_LIMIT).map((pair) => ({
      source: pair.source,
      target: pair.target,
      hub: pair.hub,
      governed: pair.governed,
    })),
    diagnostics: flow.diagnostics.map((diagnostic) => diagnostic.detail),
  };
}

/** Trim a computed contract boundary into the report's section, keeping every edge. */
function contractsSection(boundary: ContractBoundaryReport): RepositoryContractsSection {
  const drifting = new Set(
    boundary.governedEdges.filter((edge) => edge.conformance === 'drifting').map((edge) => edge.contract),
  );
  return {
    definitions: boundary.definitions,
    governedEdges: boundary.governedEdges,
    uncontractedBoundaries: boundary.uncontractedBoundaries,
    conformance: boundary.conformanceDeviations,
    orphaned: boundary.orphanedContracts,
    unverified: boundary.unverifiedEdges,
    gaps: {
      governed: boundary.governedEdges.length,
      uncontracted: boundary.uncontractedBoundaries.length,
      drifting: drifting.size,
      orphaned: boundary.orphanedContracts.length,
      unverified: boundary.unverifiedEdges.length,
    },
  };
}

/** Trim a computed data layer into the report's section, keeping counts and every finding. */
function dataSection(data: DataReport): RepositoryDataSection {
  return {
    datasets: data.datasets.length,
    edges: data.edges.length,
    products: data.products,
    contracts: data.contracts,
    candidates: data.candidates,
    conformance: data.conformance,
    classifications: data.classifications,
    events: data.events.length,
    gaps: {
      noSingleWriter: data.candidates.filter((entry) => entry.kind === 'no-single-writer').length,
      contractlessPort: data.candidates.filter((entry) => entry.kind === 'output-port').length,
      unconformant: data.conformance.length,
    },
  };
}

function comparePainPoints(a: PainPoint, b: PainPoint): number {
  return (
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    a.location.join('\u0000').localeCompare(b.location.join('\u0000')) ||
    a.id.localeCompare(b.id)
  );
}

function countBySeverity(points: readonly PainPoint[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const point of points) {
    counts[point.severity] += 1;
  }
  return counts;
}

function cyclePoints(graph: Graph): PainPoint[] {
  return computeCycles(graph).map((cycle) => ({
    id: `cycle:${cycle.members.join('+')}`,
    kind: 'cycle',
    severity: 'critical',
    location: cycle.members,
    summary: `${cycle.members.length} files form a dependency cycle`,
    inputs: { size: cycle.members.length },
  }));
}

function untestedPoints(graph: Graph, limit: number, measured: MeasuredCoverageSummary | null): PainPoint[] {
  const untested = computeUntested(graph, measured, limit);
  const metrics = computeGraphMetrics(graph);
  return untested.figures.map((figure) => ({
    id: `untested:${figure.file}`,
    kind: 'untested-reach',
    severity: 'medium',
    location: [figure.file],
    summary:
      untested.basis === 'measured'
        ? `measured ${figure.value}% line coverage, under ${untested.threshold}%, yet other files depend on it${figure.stale ? ' (report is stale for this file)' : ''}`
        : 'no test reaches this file, yet other files depend on it',
    inputs: {
      dependents: metrics.fanIn.get(figure.file) ?? 0,
      ...(untested.basis === 'measured' ? { measuredCoverage: figure.value ?? 0 } : {}),
    },
  }));
}

function smellPoints(report: SmellsReport): PainPoint[] {
  const points: PainPoint[] = [];
  for (const entry of report.files) {
    for (const smell of entry.smells) {
      // `cyclic` is already one pain point per cycle group, so it is not repeated per file.
      if (smell.rule === 'cyclic') {
        continue;
      }
      points.push({
        id: `smell:${smell.rule}:${entry.file}`,
        kind: smell.rule,
        severity: SMELL_SEVERITY[smell.rule],
        location: [entry.file],
        summary: smell.detail,
        inputs: { rule: smell.rule, ...smell.inputs },
      });
    }
  }
  return points;
}

function hotspotPoints(report: HotspotReport, limit: number): PainPoint[] {
  return report.hotspots.slice(0, limit).map((hotspot) => ({
    id: `hotspot:${hotspot.file}:${hotspot.owner}.${hotspot.name}:${hotspot.line}`,
    kind: 'hotspot',
    severity: hotspot.signals.length >= 3 ? 'high' : 'medium',
    location: [hotspot.file],
    summary: `${hotspot.owner ? `${hotspot.owner}.` : ''}${hotspot.name} trips ${hotspot.signals.length} recorded cost signal(s)`,
    inputs: {
      signals: hotspot.signals.length,
      signalKinds: hotspot.signals.map((signal) => signal.kind).join(', '),
      decisionPoints: hotspot.decisionPoints,
      line: hotspot.line,
    },
  }));
}

function busFactorPoints(ownership: readonly OwnershipContext[], limit: number): PainPoint[] {
  return ownership
    .filter((entry) => entry.distinctAuthors === 1 && entry.transitiveDependents > 0)
    .sort(
      (a, b) => b.transitiveDependents - a.transitiveDependents || a.file.localeCompare(b.file),
    )
    .slice(0, limit)
    .map((entry) => ({
      id: `bus-factor:${entry.file}`,
      kind: 'bus-factor',
      severity: 'medium',
      location: [entry.file],
      summary: `one recorded author, ${entry.transitiveDependents} transitive dependent(s)`,
      inputs: { distinctAuthors: entry.distinctAuthors, transitiveDependents: entry.transitiveDependents },
    }));
}

function riskPoints(report: RiskReport): PainPoint[] {
  const points: PainPoint[] = [];
  for (const advisory of report.advisories) {
    const { dependency } = advisory;
    points.push({
      id: `advisory:${advisory.id}:${dependency.name}:${dependency.version ?? 'unresolved'}`,
      kind: 'advisory',
      severity: ADVISORY_SEVERITY[advisory.severity],
      location: advisory.importedBy,
      summary: `${advisory.summary} (${dependency.name}${dependency.version ? `@${dependency.version}` : ''})`,
      inputs: {
        advisory: advisory.id,
        package: dependency.name,
        version: dependency.version ?? 'unresolved',
        severity: advisory.severity,
        importedBy: advisory.importedBy.length,
      },
    });
  }
  for (const license of report.licenses) {
    if (!license.denied) {
      continue;
    }
    const { dependency } = license;
    points.push({
      id: `license:${dependency.name}:${dependency.version ?? 'unresolved'}`,
      kind: 'denied-license',
      severity: 'high',
      location: [],
      summary: `${dependency.name} carries a denied licence (${license.licenses.join(', ') || 'unknown'})`,
      inputs: {
        package: dependency.name,
        version: dependency.version ?? 'unresolved',
        license: license.licenses.join(', '),
        risk: license.risk,
      },
    });
  }
  return points;
}

function diagnosticPoints(graph: Graph): PainPoint[] {
  const byFile = new Map<string, { count: number; kinds: Set<string> }>();
  for (const diagnostic of graph.diagnostics) {
    if (diagnostic.kind !== 'parse-failure' && diagnostic.kind !== 'read-failure') {
      continue;
    }
    const entry = byFile.get(diagnostic.file) ?? { count: 0, kinds: new Set<string>() };
    entry.count += 1;
    entry.kinds.add(diagnostic.kind);
    byFile.set(diagnostic.file, entry);
  }
  return [...byFile.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([file, entry]) => ({
      id: `parse-failure:${file}`,
      kind: 'parse-failure' as const,
      severity: 'high' as const,
      location: [file],
      summary: `${entry.count} recorded ${[...entry.kinds].join('/')} diagnostic(s)`,
      inputs: { count: entry.count, kinds: [...entry.kinds].join(', ') },
    }));
}
