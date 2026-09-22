import type { Periphery, SystemUnitEcosystem } from './units.ts';

/** A unit as the System view draws it, with the evidence for its grouping. */
export interface SystemNode {
  id: string;
  name: string;
  ecosystem: SystemUnitEcosystem;
  manifest: string | null;
  parent: string | null;
  /** The "why grouped" caption: which manifest named it. */
  why: string;
  files: number;
  /** Files folded into the support shelf for this unit. */
  periphery: number;
  /** True when `strabo.groups.yml` declared the group rather than a manifest. */
  declared?: boolean;
  /** Derived units whose files this declared group took over. */
  overrides?: string[];
}

/** One recorded relationship between units. */
export interface SystemEdge {
  source: string;
  target: string;
  kind: 'import';
  /** Number of file-to-file edges rolled into this unit pair. */
  weight: number;
  /** Example specifiers, for evidence. */
  samples: string[];
}

/** A file's layer inside its unit: direction orders it, a path token names it. */
export interface SystemLayer {
  unit: string;
  name: string;
  order: number;
  files: string[];
  why: string;
}

/** A connected region inside one layer, detected on the import graph. */
export interface SystemCommunity {
  id: string;
  unit: string;
  layer: string;
  members: string[];
  /** Share of member edges that stay inside the community, as a signal. */
  internalRatio: number;
  why: string;
}

/** A support file, with the unit whose shelf it folds into. */
export interface SystemPeriphery extends Periphery {
  unit: string;
}

export interface SystemReport {
  units: SystemNode[];
  edges: SystemEdge[];
  layers: SystemLayer[];
  communities: SystemCommunity[];
  periphery: SystemPeriphery[];
  summary: {
    units: number;
    edges: number;
    layers: number;
    communities: number;
    periphery: number;
  };
}
