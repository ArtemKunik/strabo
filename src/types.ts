/**
 * Shared contracts for Strabo.
 *
 * These types are the stable boundary between the scanner, analysis, cache, API, and
 * browser app. They are intentionally data-only so they can be serialised over HTTP.
 */

/** The kind of a graph node. */
export type NodeKind = 'module' | 'test';

/** A node in the repository graph. `id` is repository-relative and POSIX-normalised. */
export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** Parent directory, or the repository root marker. */
  directory: string;
  /** Optional display label; falls back to the file name when absent. */
  label?: string;
  /** Optional language tag derived during scanning. */
  language?: string;
  /** Optional palette index assigned by the server; colours are theme-owned. */
  paletteIndex?: number;
}

/** The kind of relationship an edge represents. */
export type EdgeKind =
  | 'import'
  | 'require'
  | 'dynamic-import'
  | 're-export'
  | 'package'
  | 'namespace'
  | 'table'
  | 'program'
  | 'copybook'
  | 'propath';

/** Evidence attached to an edge so the UI can explain why the link exists. */
export interface EdgeEvidence {
  /** 1-based line where the reference was found. */
  line: number;
  /** The raw specifier or symbol as authored. */
  specifier: string;
  /** How the reference was resolved, for transparency. */
  resolution: 'exact' | 'extension' | 'index' | 'index-of-package' | 'module-tree' | 'index-packed';
}

/**
 * A resolved, directed relationship. An edge exists only when both endpoints resolve
 * inside the scanned repository.
 */
export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  evidence: EdgeEvidence;
}

/** A fact Strabo could not turn into an edge. Diagnostics are evidence, not errors. */
export interface Diagnostic {
  file: string;
  line: number;
  message: string;
  severity: 'info' | 'warning' | 'error';
  kind: 'unresolved' | 'ambiguous' | 'parse-failure' | 'unsupported';
  specifier?: string;
}

/** Why a path was left out of the graph. */
export interface Exclusion {
  path: string;
  reason: 'generated' | 'vendor' | 'build' | 'gitignored' | 'minified' | 'unsupported' | 'symlink';
  detail?: string;
}

/** A complete repository scan. */
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
  excluded: Exclusion[];
}

/** Extra scan metadata returned alongside the graph. */
export interface ScanReport {
  graph: Graph;
  /** Count of retained source files per extension, e.g. `{ ".ts": 42 }`. */
  extensionCounts: Record<string, number>;
  /** Count of skipped non-source files per extension, e.g. `{ ".png": 320 }`. */
  unsupportedExtensionCounts: Record<string, number>;
  parseFailures: number;
  unresolvedReferences: number;
  scannedAt: string;
  durationMs: number;
}

export type CacheStatus = 'memory' | 'disk' | 'refreshed' | 'miss';

export interface ScanCacheMetadata {
  status: CacheStatus;
  fingerprint: string | null;
  artifactVersion: string;
  generatedAt: string;
  /** True when a stale entry was served while a refresh runs in the background. */
  stale?: boolean;
}

export interface RepositoryDescriptor {
  name: string;
  root: string;
  head: string | null;
  dirty: boolean;
  gitUrl: string | null;
}

/** A graph node enriched with workspace-relative paths for presentation. */
export interface ViewNode extends GraphNode {
  workspacePath: string;
  fanIn: number;
  fanOut: number;
  transitiveDependencies: number;
  transitiveDependents: number;
}

export interface ViewEdge extends GraphEdge {
  semanticSource: string;
  semanticTarget: string;
}

export interface ViewPosition {
  id: string;
  x: number;
  y: number;
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
}

/** A path-prefix aggregate used for block-level (directory) navigation. */
export interface BlockViewModel {
  prefixLength: number;
  repository?: RepositoryDescriptor;
  nodes: ViewNode[];
  edges: ViewEdge[];
  positions: ViewPosition[];
  cache?: ScanCacheMetadata;
}

export type UnavailableReason =
  | 'not-configured'
  | 'not-authenticated'
  | 'provider-error'
  | 'no-domain-pack';

export interface Unavailable {
  available: false;
  reason: UnavailableReason;
  detail?: string;
}

/** Optional integration seams. Absence is explicit, never an implicit default. */
export interface StraboIntegrations {
  catalogueFetcher?: CatalogueFetcher;
  createVulnerabilityClient?: VulnerabilityClientFactory;
  lineagePack?: LineagePack;
}

export type CatalogueFetcher = (root: string) => Promise<RepositoryDescriptor[]>;

export interface VulnerabilityFinding {
  id: string;
  severity: 'low' | 'moderate' | 'high' | 'critical' | 'unknown';
  title: string;
  nodeId?: string;
}

export interface VulnerabilityClient {
  fetch(repository: RepositoryDescriptor): Promise<VulnerabilityFinding[]>;
}

export type VulnerabilityClientFactory = (
  root: string,
) => Promise<VulnerabilityClient> | VulnerabilityClient;

export interface LineagePack {
  name: string;
  /** Repositories the pack deliberately inspects. Never inferred implicitly. */
  repositories: string[];
  build(graphs: Map<string, Graph>): Promise<Graph>;
}

/** Configuration for the standalone server or an embedding host. */
export interface StraboConfig {
  workspaceRoot: string;
  configPath?: string;
  scanCeiling?: string;
  integrations?: StraboIntegrations;
  serverLog?: (message: string, error?: unknown) => void;
}

/** Options accepted by the graph endpoint. */
export interface GraphRequestOptions {
  repository?: string;
  path?: string;
  refresh?: boolean;
  blockDepth?: number;
  blockPrefix?: string;
}
