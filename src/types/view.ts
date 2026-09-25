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
