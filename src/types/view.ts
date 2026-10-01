import type { TierEndpointSite, TierIntentReport, TierSpine } from '../analysis/tiers/types.ts';
import type {
  TierDataFlowDiagnostic,
  TierDataFlowEvidence,
  TierDataFlowSummary,
  TierFlowKind,
  TierGovernance,
} from '../analysis/tiers/data-flow.ts';
import type { DataStrength, DatasetKind } from './data.ts';
import type { Diagnostic, Exclusion, GraphEdge, GraphNode } from './graph.ts';
import type { RepositoryDescriptor, ScanCacheMetadata } from './scan.ts';

/** A graph node enriched with workspace-relative paths for presentation. */
export interface ViewNode extends GraphNode {
  workspacePath: string;
  fanIn: number;
  fanOut: number;
  transitiveDependencies: number;
  transitiveDependents: number;
  /** Box size for a System-view unit (component files); defaults to blast radius. */
  size?: number;
  /** Component files in a System-view unit. */
  files?: number;
  /** Support files folded into a System-view unit's shelf. */
  periphery?: number;
  /** The "why grouped" caption for a System-view unit. */
  why?: string;
  /** The open unit this file belongs to in a System drill-down. */
  systemUnit?: string;
  /** Layer lane of a file inside its open unit. */
  systemLayer?: string;
  /** Community of a file inside its layer. */
  systemCommunity?: string;
  /** Transitive dependents that stay inside the open unit (L17 split). */
  inUnitDependents?: number;
  /** Transitive dependents outside the open unit (L17 split). */
  outsideDependents?: number;
  /** True for the collapsed boxes of the units that are not open. */
  collapsed?: boolean;
  /** The shelf a drill-down shelf node folds, for its hover card. */
  shelf?: UnitShelfFact;
  /** The role tier a Structure-view band/shelf node stands for (Phase 35 Y3). */
  tier?: string;
  /** Share of codebase files in this tier (0..1). */
  fileShare?: number;
  /** Of a band's files, how many the classifier flagged mixed, drawn as a badge. */
  mixed?: number;
  /** In a Structure grid (Y4), the build unit a cell node stands for, and its display name. */
  unit?: string;
  unitName?: string;
  /** In a Structure grid (Y4), the cell's own id `<unit>|<tier>` for selection. */
  cell?: string;
  /** In Structure mode (Y7), true when the band is declared in intent but has no files. */
  ghost?: boolean;
  /** In a Structure view, recorded imports that stay inside this tier (or grid cell). */
  internalImports?: number;
  /** In a Structure comparison, files gained (+) or lost (−) since the baseline. */
  filesDelta?: number;
  /**
   * In a Structure data-flow reading (Phase 37), the hub's dataset kind. Present makes the node
   * a data hub the stack routes through rather than a role tier.
   */
  dataKind?: DatasetKind;
  /** In a Structure data-flow reading, a recorded contract governs this hub. */
  dataGoverned?: boolean;
  /** In a Structure data-flow reading, the tier role of a hub that is the endpoint of a flow. */
  dataTier?: string;
  /**
   * In a Structure data-flow reading of the grid (Phase 37), a cell's data ports: how many
   * distinct hubs its files write and read, so a cell is read as a producer/consumer too.
   */
  dataPorts?: { writes: number; reads: number };
}

export interface ViewEdge extends GraphEdge {
  semanticSource: string;
  semanticTarget: string;
  /** In a System drill-down, whether the edge stays in the unit or crosses its frame. */
  scope?: 'unit' | 'outside';
  /**
   * File-to-file edges rolled into a System-view unit edge. Its stroke widens with the
   * count, so a unit pair joined by 40 imports reads heavier than one joined by a single
   * import. Absent or 1 on a file edge.
   */
  weight?: number;
  /**
   * In a Structure view, how a tier-to-tier edge runs through the layer order: `down`
   * follows it, `upward` and `skip-layer` are the wrong-way reads (Phase 35 Y3).
   */
  tierKind?: 'down' | 'upward' | 'skip-layer';
  /** In a Structure view, contributing edges whose two ends sit in different build units. */
  crossUnit?: number;
  /** In a Structure grid, true when the edge's two endpoints sit in different build units. */
  crossUnitEdge?: boolean;
  /** In Structure mode (Y7), true when the edge is declared in intent but has 0 observed imports. */
  ghost?: boolean;
  /** In Structure mode (Y7), true when every import on the edge is covered by a declared rule. */
  intended?: boolean;
  /** In Structure mode, imports on the edge a declared rule covers; the rest are unexplained. */
  allowedCount?: number;
  /** Of `allowedCount`, how many are type-only. */
  allowedTypeOnly?: number;
  /** The declared rules that cover imports on the edge, most imports first. */
  allowedRules?: string[];
  /** In Structure mode (Y7), true when the edge breaks declared intent or layer order. */
  violation?: boolean;
  /** The declared rule id behind this intent or violation. */
  ruleId?: string;
  /** In a Structure comparison, imports gained (+) or lost (−) on this edge since the baseline. */
  weightDelta?: number;
  /** In a Structure comparison, true for an edge that existed at the baseline and is gone now. */
  baselineOnly?: boolean;
  /** In a Structure view, how many of the rolled-up imports bring in types only. */
  typeOnlyCount?: number;
  /** In a Structure view, the rolled-up imports themselves (capped), for the edge panel. */
  tierImports?: Array<{ source: string; target: string; line: number; specifier: string; typeOnly?: boolean; allowed?: boolean }>;
  /**
   * In a Structure data-flow reading (Phase 37), the recorded flow the edge draws: a file
   * reading or writing a data hub. Absent on an ordinary import edge.
   */
  flowKind?: TierFlowKind;
  /** In a Structure data-flow reading, the strength of the recorded access. */
  flowStrength?: DataStrength;
  /** In a Structure data-flow reading, a contract governs the hub this edge touches. */
  flowGoverned?: boolean;
  /** In a Structure data-flow reading, the governed hub's contract health. */
  flowConformance?: TierGovernance;
  /** In a Structure data-flow reading, the recorded evidence sites behind the edge (capped). */
  flowEvidence?: TierDataFlowEvidence[];
}

export interface ViewPosition {
  id: string;
  x: number;
  y: number;
}

/** One file outside the open unit that a selected file reaches, for the count badge. */
export interface OutsideTargetFile {
  file: string;
  specifier: string | null;
  line: number | null;
}

/** Cross-unit relationships of one selected file, grouped by target unit. */
export interface OutsideLink {
  file: string;
  targetUnit: string;
  targetName: string;
  count: number;
  files: OutsideTargetFile[];
}

/** One layer inside a build unit, for the unit card's layer bars. */
export interface UnitLayerFact {
  name: string;
  order: number;
  files: number;
}

/** The support files folded into a unit's shelf, by category. */
export interface UnitShelfFact {
  test: number;
  script: number;
  generated: number;
  fixture: number;
  total: number;
}

/**
 * The facts a System-view unit card shows (L22).
 *
 * `hotspots` is left null by the server: the signal count is only known after the
 * function analysis runs, so the browser fills it from `/analysis/functions`.
 */
export interface UnitCard {
  id: string;
  name: string;
  ecosystem: string;
  manifest: string | null;
  /** The unit's largest layer name, used as its role in the card header. */
  role: string | null;
  files: number;
  loc: number;
  languages: Record<string, number>;
  layers: UnitLayerFact[];
  shelf: UnitShelfFact;
  hotspots: number | null;
  testReach: { reached: number; total: number };
  /** Measured line coverage over the unit's files the report names; null with no report. */
  coverage: UnitCoverageFact | null;
  dependsOn: number;
  usedBy: number;
  why: string;
}

/** A unit's measured coverage, summed over the member files the report names. */
export interface UnitCoverageFact {
  basis: 'measured';
  linesHit: number;
  linesFound: number;
  /** 0-100, or null when the named files record no line counts. */
  value: number | null;
  filesMeasured: number;
  /** Member files the report does not name: `not in report`, never counted as 0%. */
  notInReport: number;
}

/** The deterministic, server-computed presentation model. */
export interface ViewModel {
  repository: RepositoryDescriptor;
  nodes: ViewNode[];
  edges: ViewEdge[];
  positions: ViewPosition[];
  hubs: string[];
  diagnostics: Diagnostic[];
  excluded: Exclusion[];
  cache: ScanCacheMetadata;
  /**
   * The revision the map was read at, so the viewer can show a file that has since left the
   * working tree from the version the map actually describes. Absent when it was not recorded.
   */
  scannedRef?: string;
  /** True when the model is a build-unit roll-up (Phase 16 System view), not files. */
  system?: boolean;
  /** Compressed, unit-anchored label per directory, for the islands and block nodes. */
  directoryLabels?: Record<string, string>;
  /** The open unit in a System drill-down; absent at L0. */
  systemUnit?: string;
  /** The declared name of the open unit, for the breadcrumb. */
  systemUnitName?: string;
  /** Layers of the open unit, in lane order. */
  systemLayers?: Array<{ unit: string; name: string; order: number; files: string[]; why: string }>;
  /** Communities of the open unit. */
  systemCommunities?: Array<{ id: string; unit: string; layer: string; members: string[]; internalRatio: number; why: string }>;
  /** Cross-unit edges of the selected file, grouped by target unit (L17). */
  outsideLinks?: OutsideLink[];
  /** Unit ids whose badge is expanded in place. */
  expandedUnits?: string[];
  /** The unit cards drawn over the System L0 map (L22). */
  unitCards?: UnitCard[];
  /** The only build unit, so the browser can auto-open it at L1 (L19). */
  systemSingleUnit?: string;
  /** True when the model is a role-tier structure (Phase 35 Y3), not files or units. */
  structure?: boolean;
  /** The structure's own reading numbers: ranked edges read and the same-tier share. */
  /** The structure's own reading numbers, plus files the scan ceiling left unread (Y9). */
  structureSummary?: {
    total: number;
    intraRatio: number;
    /** Files beyond `MAX_TIER_FILES`: not read, so never drawn as unclassified (Y9). */
    truncated?: number;
    /** Files the classifier pinned while flagging them mixed, for the honesty note. */
    mixed?: number;
    /** Files with no recorded tier evidence; a real answer, never an empty band (Y9). */
    unclassified?: number;
  };
  /**
   * The structure drawing on screen: `bands` is the tier stack (Y3), `grid` the unit × tier
   * grid (Y4). Absent means `bands`, so an older client still reads.
   */
  structureLevel?: 'bands' | 'grid' | 'cell';
  /** The orientation of the tier stack in Structure view: 'vertical' (top to bottom) or 'horizontal' (left to right). */
  structureDirection?: 'vertical' | 'horizontal';
  /** In a grid, the rows (ranked tiers) and columns (build units), for axis labels. */
  structureGrid?: {
    tiers: string[];
    units: Array<{ id: string; name: string; files: number }>;
    crossUnitEdges: number;
  };
  /** In a Structure cell drill-down (Phase 35 Y5), the unit id and display name. */
  structureUnit?: string;
  structureUnitName?: string;
  /** In a Structure cell drill-down, the role tier. */
  structureTier?: string;
  /** The cell's own id `<unit>|<tier>`, for breadcrumb and state restore. */
  structureCell?: string;
  /** The end-to-end spines connecting call → endpoint → handler → table (Phase 35 Y6). */
  structureSpines?: TierSpine[];
  /** The declared endpoints in this structure, with their request/response contracts. */
  structureEndpoints?: TierEndpointSite[];
  /** Intended vs observed architecture facts (Phase 35 Y7). */
  structureIntent?: TierIntentReport;
  /**
   * In the Structure view, which edge reading is drawn: the recorded imports (default) or the
   * Phase 37 data-flow reading (reads/writes routed through data hubs). Absent means `imports`.
   */
  structureFlow?: 'imports' | 'data';
  /** In the data-flow reading, the reading's own numbers (Phase 37). */
  structureDataFlow?: TierDataFlowSummary;
  /** In the data-flow reading, facts the reading could not turn into edges (Phase 37). */
  structureDataFlowDiagnostics?: TierDataFlowDiagnostic[];
  /**
   * In the Structure stack, the revision the deltas are read against (`?since=`), or why
   * it could not be read. Absent when no comparison was asked for.
   */
  structureBaseline?:
    | { available: true; ref: string; revision: string; upwardDelta: number; skipDelta: number }
    | { available: false; ref: string; detail: string };
}

/** A path-prefix aggregate used for block-level (directory) navigation. */
export interface BlockViewModel {
  prefixLength: number;
  repository?: RepositoryDescriptor;
  nodes: ViewNode[];
  edges: ViewEdge[];
  positions: ViewPosition[];
  cache?: ScanCacheMetadata;
  /** Compressed, unit-anchored label per block id. */
  directoryLabels?: Record<string, string>;
}
