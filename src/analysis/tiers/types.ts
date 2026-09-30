import type { FileCoverageAggregate } from '../file-coverage.ts';
import type { ApiSchemaRef } from '../../types/workspace.ts';
import type {
  TierIntentGhostBand,
  TierIntentGhostEdge,
  TierIntentReport,
  TierIntentViolation,
} from './intent.ts';

export type {
  TierIntentGhostBand,
  TierIntentGhostEdge,
  TierIntentReport,
  TierIntentViolation,
};

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
  /** The build unit this file belongs to (Phase 35 Y5). */
  unit?: string;
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
    /** Of `files`, how many the classifier pinned while flagging them mixed. */
    mixed: number;
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

/** One recorded import behind a tier-flow edge: the file pair and where it is written. */
export interface TierFlowImport {
  source: string;
  target: string;
  line: number;
  specifier: string;
  /** True when the import brings in types only. */
  typeOnly?: boolean;
}

/** One aggregated flow between two role tiers, read from recorded imports (calls excluded). */
export interface TierFlowEdge {
  source: Tier;
  target: Tier;
  /** `down` follows the tier order; `upward` and `skip-layer` are the wrong-way reads. */
  kind: 'down' | 'upward' | 'skip-layer';
  /** Recorded edges rolled into this tier pair. */
  weight: number;
  /** Contributing edges whose two ends sit in different build units. */
  crossUnit: number;
  /** Contributing edges that import types only (erased at compile time; TypeScript). */
  typeOnly?: number;
  /** The contributing imports themselves, capped at `TIER_FLOW_SAMPLE_LIMIT`, file order. */
  imports?: TierFlowImport[];
  /** The build units the contributing edges start in, for scope. */
  units: string[];
  /** True when this edge is declared in intent but has 0 observed imports (Phase 35 Y7). */
  ghost?: boolean;
  /** True when this edge matches a declared allowed rule. */
  intended?: boolean;
  /** True when this edge breaks declared intent or tier order. */
  violation?: boolean;
  /** The declared rule id behind this intent or violation. */
  ruleId?: string;
}

/**
 * The whole-repository flow between role tiers: the structure the tier classification
 * becomes once recorded imports are collapsed across it.
 *
 * Same-tier edges are kept apart because a self-edge is not a layer relationship, and a
 * high `intraRatio` means the code is not really layered.
 */
export interface TierFlow {
  /** The ranked tiers present, in dependency order (frontend first). */
  tiers: Tier[];
  edges: TierFlowEdge[];
  /** Ranked edges whose two ends share a tier, per tier. */
  intraByTier: Array<{ tier: Tier; weight: number }>;
  /** Ranked edges read: the summed edge weights plus the same-tier edges. */
  total: number;
  /** Share of `total` that stays inside one tier, rounded to three places. */
  intraRatio: number;
}

/** One cell of the unit × tier grid: a build unit's files in one role tier (Phase 35 Y4). */
export interface TierGridCell {
  /** Stable id, `<unit>|<tier>`, so a surface can name a cell without inventing one. */
  id: string;
  unit: string;
  unitName: string;
  tier: Tier;
  files: number;
  lines: number;
  /** Of `files`, how many the classifier pinned while flagging them mixed. */
  mixed: number;
  /** Coverage over the cell's files from one source: measured, or the reach fallback. */
  coverage: FileCoverageAggregate;
  /** Member files in this cell, sorted by path (Phase 35 Y5). */
  members?: string[];
}

/** One aggregated recorded edge between two grid cells. */
export interface TierGridEdge {
  source: string;
  target: string;
  sourceUnit: string;
  targetUnit: string;
  sourceTier: Tier;
  targetTier: Tier;
  /** `down` follows the tier order; `upward`/`skip-layer` are the wrong-way reads. */
  kind: TierFlowEdge['kind'];
  weight: number;
  /** Contributing imports that bring in types only. */
  typeOnly?: number;
  /** The contributing imports themselves, capped like the tier-flow edges' list. */
  imports?: TierFlowImport[];
  /** True when the two ends sit in different build units, so the drawing styles it apart. */
  crossUnit: boolean;
  /** True when this edge is declared in intent but has 0 observed imports (Phase 35 Y7). */
  ghost?: boolean;
  /** True when this edge matches a declared allowed rule. */
  intended?: boolean;
  /** True when this edge breaks declared intent or tier order. */
  violation?: boolean;
  /** The declared rule id behind this intent or violation. */
  ruleId?: string;
}

/**
 * The unit × tier grid (Phase 35 Y4): the tier matrix with adjacency added.
 *
 * Columns are build units, rows are ranked tiers in dependency order, and each cell is a
 * build unit's files in that tier. Every recorded edge between two cells is kept, including
 * cross-unit ones, so a monorepo with several services can be read as one picture.
 */
export interface TierGrid {
  /** Column order: build units, sorted by id. */
  units: Array<{ id: string; name: string; files: number }>;
  /** Row order: ranked tiers present, in dependency order (frontend first). */
  tiers: Tier[];
  cells: TierGridCell[];
  edges: TierGridEdge[];
  /** Support tiers outside the layer order, as a shelf beside the grid. */
  shelf: TierShelfEntry[];
  /** Cells per unit and tier for a fast lookup; always `<units> × <tiers>`. */
  summary: {
    units: number;
    tiers: number;
    cells: number;
    edges: number;
    crossUnitEdges: number;
  };
}

/**
 * A support tier outside the layer order, folded onto a shelf rather than a band.
 *
 * `infra`, `build`, `tests`, and `unclassified` have no dependency rank, so they cannot sit in
 * the stack; the drawing keeps them beside it, exactly as the System view shelves periphery.
 */
export interface TierShelfEntry {
  tier: Tier;
  files: number;
  lines: number;
  /** Of `files`, how many the classifier pinned while flagging them mixed. */
  mixed: number;
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
  /** OpenAPI `operationId`, when the operation names one (API contract view). */
  operationId?: string | null;
  /** Request body schema, when the operation declares one (API contract view). */
  request?: ApiSchemaRef | null;
  /** First recorded 2xx response schema, when the operation declares one (API contract view). */
  response?: ApiSchemaRef | null;
}

/** The top half of the end-to-end trace: a call site and the endpoint it reaches here. */
export interface TierTrace {
  call: TierCallSite;
  endpoint: TierEndpointSite | null;
}

/** One hop along an end-to-end spine: call, endpoint, handler, or table (Phase 35 Y6). */
export interface TierSpineHop {
  tier: Tier;
  role: 'call' | 'endpoint' | 'handler' | 'table';
  file: string;
  unit: string;
  label: string;
  detail: string;
  line?: number;
}

/**
 * One recorded table downstream of a spine's handler, with its evidence.
 *
 * The lineage is the set of tables the handler reaches through recorded imports and table
 * references, not a claim about runtime data flow. `matched` is the one the call's path token
 * picked for the spine's TABLE hop; the rest are the other recorded tables on the same path.
 */
export interface TierTableLineage {
  table: string;
  file: string;
  unit: string;
  line: number;
  evidence: string;
  matched: boolean;
}

/**
 * An end-to-end behavioral spine through the role tiers (Phase 35 Y6):
 * `call site (frontend) → endpoint (api) → handler (domain) → table (data)`
 *
 * Missing hops stay as null / dangling stubs, never fabricated.
 */
export interface TierSpine {
  id: string;
  call: TierCallSite;
  endpoint: TierEndpointSite | null;
  handler: {
    file: string;
    tier: Tier;
    unit: string;
    label: string;
  } | null;
  table: TableTraceEntry | null;
  hops: TierSpineHop[];
  /** Recorded tables downstream of the handler, matched first (Phase 35 lineage). */
  lineage: TierTableLineage[];
}

export interface TierReport {
  files: TierClassification[];
  units: TierUnitReport[];
  matrix: TierMatrix;
  directions: TierDirection[];
  /** The edges between role tiers collapsed across the repository (Phase 35 Y1). */
  tierFlow: TierFlow;
  /** The unit × tier grid with adjacency (Phase 35 Y4). */
  grid: TierGrid;
  /** Support tiers outside the layer order (Phase 35 Y2): infra, build, tests, unclassified. */
  shelf: TierShelfEntry[];
  tables: TableReference[];
  /** The bottom half of the end-to-end trace: a table joined to the files that name it. */
  tableTrace: TableTraceEntry[];
  /** The top half: outbound calls and the endpoints a document in this repository declares. */
  calls: TierCallSite[];
  endpoints: TierEndpointSite[];
  /** A call site joined to the endpoint it reaches here by method and path, when one matches. */
  traces: TierTrace[];
  /** The end-to-end spines connecting call → endpoint → handler → table (Phase 35 Y6). */
  spines: TierSpine[];
  /** Intended vs observed architecture facts (Phase 35 Y7). */
  intent?: TierIntentReport;
  summary: Record<Tier, number> & { total: number; mixed: number; unclassified: number };
  skipped: string[];
  /** Files beyond the scan ceiling; not read, so they are not claimed as unclassified. */
  truncated: number;
}
