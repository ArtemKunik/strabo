import type { DriftReport } from '../analysis/drift.ts';
import type { MeasuredCoverageSummary } from '../analysis/measured-coverage.ts';
import type { RepositoryPassport } from '../analysis/passport.ts';
import type { StructuralDiffResult } from '../analysis/structural-diff.ts';
import type { ReviewStatus } from '../analysis/review-types.ts';
import type { HotspotReport } from '../analysis/hotspots.ts';
import type { OwnershipContext } from '../analysis/ownership.ts';
import type { SmellsReport } from '../analysis/quality.ts';
import type { Tier, TierFlow, TierShelfEntry, TierReport } from '../analysis/tiers/types.ts';
import type { CoverageCommandSuggestion } from '../analysis/coverage-refresh.ts';
import type { DataReport, Graph, RiskReport } from '../types.ts';

/**
 * The report contract, kept apart from the builder so `suggestions.ts` can name a pain point
 * without importing the builder back — a type-only cycle still registers as a strongly
 * connected component in Strabo's own graph, so the shared shapes live here.
 */

/**
 * The whole-repository report: one document over the same recorded graph the canvas draws.
 *
 * It is a composition layer, not an analysis engine. `buildRepositoryReport` is pure — it
 * takes the cached graph and the analyses a caller already computed and ranks them into one
 * pain-point list. JSON, Markdown, and HTML are three views of this one contract, so the
 * browser and the report cannot disagree.
 */
export interface RepositoryReportDocument {
  schema: 'strabo-report-1';
  repository: string;
  root: string | null;
  generatedAt: string;
  revision: ReportRevision;
  overview: RepositoryPassport;
  painPoints: PainPoint[];
  change: RepositoryChangeSection | null;
  /** Architecture drift over recent revisions (Phase 31 O3); null when not computed. */
  drift: DriftReport | null;
  /** The data layer, contract, and product facts (Phase 33 J10); null when not computed. */
  data: RepositoryDataSection | null;
  /** Code coverage from measured report or reachability fallback (Phase 34 U7); null when not computed. */
  coverage: RepositoryCoverageSection | null;
  /** Logical structure across role tiers (Phase 35 Y8); null when not computed. */
  structure: RepositoryStructureSection | null;
  suggestions: Suggestion[];
  evidence: ReportEvidence;
}

/**
 * The data-layer part of the repository report: the recorded datasets, contracts, and
 * products with the conformance gaps between a declared port and what the code records.
 * Present only when the caller computed the data layer.
 */
export interface RepositoryDataSection {
  datasets: number;
  edges: number;
  products: DataReport['products'];
  contracts: DataReport['contracts'];
  candidates: DataReport['candidates'];
  conformance: DataReport['conformance'];
  classifications: DataReport['classifications'];
  events: number;
  /** Coverage of the data layer, stated so an empty section is never read as "no data". */
  gaps: {
    noSingleWriter: number;
    contractlessPort: number;
    unconformant: number;
  };
}

/**
 * The code coverage part of the repository report: measured line coverage when available,
 * or the reachability fallback with next steps when unavailable.
 */
export interface RepositoryCoverageSection {
  available: boolean;
  basis: 'measured' | 'reachable';
  format: string | null;
  reportPath: string | null;
  reportModified: string | null;
  reportAgeMs: number | null;
  lineCoverage: number | null;
  linesFound: number;
  linesHit: number;
  filesMeasured: number;
  stale: string[];
  outOfGraph: string[];
  reason?: string;
  detail?: string;
  refreshCommand?: string | null;
  checkedLocations?: string[];
  suggestedCommands?: CoverageCommandSuggestion[];
}

/**
 * The logical structure across role tiers (Phase 35 Y8): tier flow between ranked tiers,
 * support tiers on the shelf, and recorded wrong-way dependencies.
 */
export interface RepositoryStructureSection {
  tierFlow: TierFlow;
  shelf: TierShelfEntry[];
  summary: {
    classified: number;
    unclassified: number;
    mixed: number;
  };
  directions: Array<{
    source: string;
    target: string;
    sourceTier: Tier;
    targetTier: Tier;
    kind: 'upward' | 'skip-layer';
    unit: string;
    line: number;
  }>;
}

export interface ReportRevision {
  head: string | null;
  fingerprint: string | null;
  scannedAt: string | null;
  stale: boolean;
}

export type Severity = 'critical' | 'high' | 'medium' | 'low';

/** Fixed order, so a report sorts the same way every run. */
export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export type PainPointKind =
  | 'cycle'
  | 'tier-leak'
  | 'god-module'
  | 'hub-dependency'
  | 'unstable-dependency'
  | 'shotgun-surgery'
  | 'hidden-coupling'
  | 'dead'
  | 'pass-through'
  | 'untested-reach'
  | 'hotspot'
  | 'bus-factor'
  | 'advisory'
  | 'denied-license'
  | 'parse-failure'
  | 'stale-graph';

/** One recorded problem, with the evidence that produced it and a fixed severity. */
export interface PainPoint {
  /** Stable id, so a report diffs cleanly between runs. */
  id: string;
  kind: PainPointKind;
  severity: Severity;
  /** The files the point is about; empty for a repository-wide point. */
  location: string[];
  summary: string;
  /** The recorded values behind the point, never a guess. */
  inputs: Record<string, number | string | boolean>;
}

/** A deterministic action derived from one pain point. */
export interface Suggestion {
  id: string;
  painPointId: string;
  kind: PainPointKind;
  location: string[];
  text: string;
}

/** The pending change set, when the caller read one. Mirrors the Phase 26 change report. */
export interface RepositoryChangeSection {
  base: string;
  baseRevision: string | null;
  head: string | null;
  changedFiles: Array<{ path: string; previousPath?: string; status: ReviewStatus }>;
  reach: {
    changed: string[];
    affected: Array<{ id: string; distance: number }>;
    outsideGraph: string[];
  };
  untestedReach: string[];
  hotspotsTouched: Array<{ file: string; findings: Array<{ rule: string; detail: string }> }>;
  structural: StructuralDiffResult | null;
  warnings: string[];
}

export interface ReportEvidence {
  files: number;
  edges: number;
  diagnostics: number;
  excluded: number;
  painPointsBySeverity: Record<Severity, number>;
  truncated: boolean;
  /** Sections the caller did not compute, named rather than shown empty. */
  unavailable: string[];
  warnings: string[];
}

export interface ReportLimits {
  painPoints: number;
  hotspots: number;
  busFactor: number;
  untested: number;
}

export const DEFAULT_REPORT_LIMITS: ReportLimits = {
  painPoints: 200,
  hotspots: 10,
  busFactor: 10,
  untested: 25,
};

export interface RepositoryReportInputs {
  repository: string;
  root?: string;
  graph: Graph;
  extensionCounts?: Record<string, number>;
  revision?: ReportRevision;
  /** Precomputed by the caller (Git history); absent means the section was not computed. */
  smells?: SmellsReport;
  /** Precomputed by the caller (symbol extraction); absent means not computed. */
  hotspots?: HotspotReport;
  /** Precomputed by the caller (Git authorship); absent means not computed. */
  ownership?: readonly OwnershipContext[];
  /** Precomputed by the caller (opt-in online lookup); absent means not computed. */
  risk?: RiskReport;
  change?: RepositoryChangeSection;
  /** Precomputed by the caller (revision graphs); absent means the drift section was not computed. */
  drift?: DriftReport;
  /** The repository's measured coverage report; absent or unavailable means reachability. */
  coverage?: MeasuredCoverageSummary | RepositoryCoverageSection | null;
  /** The computed data layer (Phase 33 J10); absent means the section was not computed. */
  data?: DataReport;
  /** Precomputed logical structure / tier report (Phase 35 Y8); absent means not computed. */
  structure?: TierReport | RepositoryStructureSection;
  generatedAt?: string;
  limits?: Partial<ReportLimits>;
}
