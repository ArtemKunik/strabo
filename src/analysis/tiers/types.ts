import type { FileCoverageAggregate } from '../file-coverage.ts';

/**
 * The role code plays, cutting across build units.
 *
 * A unit answers "what is deployed"; a tier answers "what this code does". `unclassified`
 * is a real answer: a file with no recorded evidence is never forced into a tier.
 */
export type Tier =
  | 'frontend'
  | 'api'
  | 'domain'
  | 'data'
  | 'integration'
  | 'infra'
  | 'build'
  | 'tests'
  | 'unclassified';

/** How strong the evidence for a tier is, strongest first. */
export type TierStrength =
  | 'declared'
  | 'framework'
  | 'annotation'
  | 'endpoint'
  | 'file-kind'
  | 'path-token'
  | 'graph';

/** The order a mixed file's primary tier is chosen in: the upper layer wins. */
export const TIER_ORDER: Tier[] = [
  'frontend',
  'api',
  'domain',
  'integration',
  'data',
  'infra',
  'build',
  'tests',
  'unclassified',
];

/**
 * Dependency rank for the direction check: a higher rank may depend on a lower one. Tiers
 * outside this map (infra, build, tests, unclassified) are not part of the layer order.
 */
export const TIER_RANK: Partial<Record<Tier, number>> = {
  frontend: 5,
  api: 4,
  domain: 3,
  integration: 2,
  data: 1,
};

/** The dependency rank of a tier, or null when it sits outside the layer order. */
export function tierRank(tier: Tier): number | null {
  return TIER_RANK[tier] ?? null;
}

export interface TierEvidence {
  tier: Tier;
  strength: TierStrength;
  detail: string;
}

/** One place a data table is named, with the rule that read it. */
export interface TableReference {
  table: string;
  file: string;
  line: number;
  evidence: string;
}

export interface TierClassification {
  file: string;
  tier: Tier;
  /** True when two tiers share the strongest evidence, so no single tier is claimed. */
  mixed: boolean;
  evidence: TierEvidence[];
  /** Source lines counted directly, the one complexity input this pass records. */
  lines: number;
  /** Data tables named in the file, from SQL, ORM annotations, or string-literal SQL. */
  tables: TableReference[];
}

export interface DeclaredTier {
  tier: Tier;
  globs: string[];
}

export type UnitRole = 'app' | 'service' | 'library' | 'tool';

/** A build unit seen through the tier lens, with its role from the same evidence. */
export interface TierUnitReport {
  id: string;
  name: string;
  role: UnitRole;
  roleEvidence: string;
  files: number;
  tiers: Record<Tier, number>;
}

/** One cell of the tier × unit matrix: file count, directly counted lines, and coverage. */
export interface TierMatrixCell {
  unit: string;
  tier: Tier;
  files: number;
  lines: number;
  /** Coverage over the cell's files from one source: measured, or the reach fallback. */
  coverage: FileCoverageAggregate;
}

export interface TierMatrix {
  /** Row order: dependency order, frontend on top, unclassified last. */
  tiers: Tier[];
  units: string[];
  cells: TierMatrixCell[];
  perTier: Array<{
    tier: Tier;
    files: number;
    lines: number;
    fileShare: number;
    /** Coverage over the tier's files from one source: measured, or the reach fallback. */
    coverage: FileCoverageAggregate;
  }>;
  /** Coverage over every classified file, so the matrix names its own basis and report age. */
  coverage: FileCoverageAggregate;
}

/** A recorded dependency that runs the wrong way through the tier order. */
export interface TierDirection {
  unit: string;
  source: string;
  target: string;
  sourceTier: Tier;
  targetTier: Tier;
  kind: 'upward' | 'skip-layer';
  line: number;
  specifier: string;
}

/** One recorded reference to a table, joined to the file's tier and unit. */
export interface TableTraceEntry {
  table: string;
  file: string;
  tier: Tier;
  unit: string;
  line: number;
  evidence: string;
}

/** A recorded outbound HTTP call in a classified file, joined to its tier and unit. */
export interface TierCallSite {
  file: string;
  tier: Tier;
  unit: string;
  line: number;
  method: string | null;
  target: string;
  host: string | null;
  path: string | null;
}

/** A declared HTTP endpoint, joined to the tier and unit of the document that declares it. */
export interface TierEndpointSite {
  file: string;
  tier: Tier;
  unit: string;
  method: string;
  path: string;
}

/** The top half of the end-to-end trace: a call site and the endpoint it reaches here. */
export interface TierTrace {
  call: TierCallSite;
  endpoint: TierEndpointSite | null;
}

export interface TierReport {
  files: TierClassification[];
  units: TierUnitReport[];
  matrix: TierMatrix;
  directions: TierDirection[];
  tables: TableReference[];
  /** The bottom half of the end-to-end trace: a table joined to the files that name it. */
  tableTrace: TableTraceEntry[];
  /** The top half: outbound calls and the endpoints a document in this repository declares. */
  calls: TierCallSite[];
  endpoints: TierEndpointSite[];
  /** A call site joined to the endpoint it reaches here by method and path, when one matches. */
  traces: TierTrace[];
  summary: Record<Tier, number> & { total: number; mixed: number; unclassified: number };
  skipped: string[];
  /** Files beyond the scan ceiling; not read, so they are not claimed as unclassified. */
  truncated: number;
}
