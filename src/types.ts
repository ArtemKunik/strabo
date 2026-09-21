/**
 * Shared contracts for Strabo.
 *
 * These types are the stable boundary between the scanner, analysis, cache, API, and
 * browser app. They are intentionally data-only so they can be serialised over HTTP.
 */

/** The kind of a graph node. `unit` and `shelf` are the System-view roll-ups. */
export type NodeKind = 'module' | 'test' | 'entry' | 'unit' | 'shelf';

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
  /** Why this node is an entry point, when a manifest declares it as one. */
  entryReason?: string;
  /** Line count of the file as read during the scan; absent on aggregate nodes. */
  lines?: number;
}

/** The kind of relationship an edge represents. */
export type EdgeKind =
  | 'import'
  | 'require'
  | 'dynamic-import'
  | 're-export'
  | 'call'
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
  resolution:
    | 'exact'
    | 'extension'
    | 'index'
    | 'index-of-package'
    | 'module-tree'
    | 'index-packed'
    | 'alias'
    | 'root'
    | 'subpath-import';
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
  /**
   * Whether the edge is a real dependency (`use`) or only a declaration of the module tree
   * (`declare`): a Rust `mod x;`, a Python `__init__.py` re-export, or a TypeScript barrel
   * `index.ts` re-export. A `declare` edge is drawn but never counted, so it cannot inflate
   * blast radius or impact. Absent means `use`.
   */
  role?: 'use' | 'declare';
}

/** A fact Strabo could not turn into an edge. Diagnostics are evidence, not errors. */
export interface Diagnostic {
  file: string;
  line: number;
  message: string;
  severity: 'info' | 'warning' | 'error';
  kind: 'unresolved' | 'ambiguous' | 'parse-failure' | 'unsupported' | 'read-failure';
  specifier?: string;
}

/** Why a path was left out of the graph. */
export interface Exclusion {
  path: string;
  reason:
    | 'generated'
    | 'vendor'
    | 'build'
    | 'fixture'
    | 'gitignored'
    | 'minified'
    | 'unsupported'
    | 'symlink';
  detail?: string;
}

/** A complete repository scan. */
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
  excluded: Exclusion[];
  /**
   * Bare imports of external packages, recorded per file.
   *
   * These are deliberately not edges: their target is outside the repository, so an edge
   * would violate the graph contract. They exist so a dependency-level finding can name
   * the files that actually import the affected package.
   */
  externalImports?: ExternalImport[];
}

/** The package ecosystem a dependency belongs to. */
export type DependencyEcosystem = 'npm' | 'maven' | 'cargo';

/** One external package reference, as authored in a source file. */
export interface ExternalImport {
  file: string;
  line: number;
  /** The specifier as written, e.g. `lodash/fp` or `serde::Deserialize`. */
  specifier: string;
  /** The package or crate the specifier belongs to, e.g. `lodash` or `serde`. */
  package: string;
  ecosystem: DependencyEcosystem;
  kind: EdgeKind | 'use' | 'extern-crate';
}

/** A dependency recorded by a manifest or lockfile. */
export interface Dependency {
  ecosystem: DependencyEcosystem;
  /** npm `name`, Maven `groupId:artifactId`, Cargo crate name. */
  name: string;
  /** Resolved version, or null when only an unresolved range was available. */
  version: string | null;
  /** Where it was found, repository-relative. */
  source: string;
  direct: boolean;
  dev?: boolean;
}

export type AdvisorySeverity = 'low' | 'moderate' | 'high' | 'critical' | 'unknown';

/** A known vulnerability affecting one resolved dependency. */
export interface DependencyAdvisory {
  id: string;
  aliases: string[];
  summary: string;
  severity: AdvisorySeverity;
  /** Versions the advisory records as fixed, when any. */
  fixed: string[];
  url: string;
  dependency: { ecosystem: DependencyEcosystem; name: string; version: string | null };
  /** Files in the scanned graph that import the affected package. */
  importedBy: string[];
  /** Reverse-reachability from the importing files, by distance. */
  impactedFiles: Array<{ id: string; distance: number }>;
}

/** How an SPDX license is classified for policy purposes. */
export type LicenseRisk = 'permissive' | 'weak-copyleft' | 'strong-copyleft' | 'unknown' | 'unavailable';

/** The license of one resolved dependency, and whether policy denies it. */
export interface DependencyLicense {
  dependency: { ecosystem: DependencyEcosystem; name: string; version: string | null };
  licenses: string[];
  risk: LicenseRisk;
  denied: boolean;
}

/** A complete dependency-risk report for one repository. */
export interface RiskReport {
  available: true;
  /** False when the opt-in online lookup is disabled; inventory still works. */
  online: boolean;
  inventory: {
    total: number;
    byEcosystem: Record<string, number>;
    /** Names cited by source imports but absent from every manifest. */
    undeclared: string[];
  };
  advisories: DependencyAdvisory[];
  licenses: DependencyLicense[];
  /** External packages cited by source imports, with the files that cite them. */
  imports: Array<{
    ecosystem: DependencyEcosystem;
    package: string;
    files: string[];
    /** True when a manifest also declares the package. */
    declared: boolean;
  }>;
  summary: Record<AdvisorySeverity, number> & { deniedLicenses: number };
  /** Set when a manifest was present but could not be parsed completely. */
  caveats: string[];
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

/** The coordinate a repository publishes, read from its own manifest. */
export interface PublishedCoordinate {
  ecosystem: DependencyEcosystem;
  /** npm package name, Cargo crate name, or Maven `groupId:artifactId`. */
  name: string;
  /** Manifest that declared it, repository-relative. */
  source: string;
}

/** One repository included in a workspace analysis. */
export interface WorkspaceRepository {
  name: string;
  root: string;
  head: string | null;
  dirty: boolean;
  gitUrl: string | null;
  /** The coordinate this repository publishes, or null when no manifest names one. */
  publishes: PublishedCoordinate | null;
}

/** A recorded package reference from one workspace repository to another. */
export interface CrossRepoFlow {
  /** Repository whose source imports the package. */
  from: string;
  /** Repository whose manifest publishes it. */
  to: string;
  ecosystem: DependencyEcosystem;
  /** The coordinate that joined them. */
  package: string;
  /** Files in `from` that cite the package, with the authored specifier. */
  files: Array<{ file: string; line: number; specifier: string }>;
  /** Manifest in `to` that published the coordinate, for evidence. */
  publishedBy: string;
}

/** A recorded outbound HTTP call in a repository's source. */
export interface ServiceCall {
  /** Repository-relative source file. */
  file: string;
  line: number;
  /** Uppercase HTTP method when the call names one, else null. */
  method: string | null;
  /** The URL or path as written. */
  target: string;
  /** Lowercased host with port when the target is absolute, else null. */
  host: string | null;
  /** Normalised request path, or null when it could not be read (an interpolated URL). */
  path: string | null;
}

/** An HTTP endpoint a repository declares in an OpenAPI document. */
export interface ServiceEndpoint {
  /** Repository name. */
  repository: string;
  /** Repository-relative source file. */
  source: string;
  /** Uppercase HTTP method. */
  method: string;
  /** Full path: the server's path prefix plus the operation path. */
  path: string;
  /** Lowercased host with port from the first server, else null. */
  host: string | null;
}

/** A recorded call from one repository to an endpoint another repository declares. */
export interface ServiceFlow {
  /** Repository whose source makes the call. */
  from: string;
  /** Repository that declares the endpoint. */
  to: string;
  method: string;
  path: string;
  host: string;
  /** Calls in `from` that matched, with the authored target. */
  calls: Array<{ file: string; line: number; target: string; method: string | null }>;
  /** OpenAPI file in `to` that declared the endpoint, for evidence. */
  declaredBy: string;
}

/** One field of a data contract, normalised across formats. */
export interface ContractField {
  name: string;
  type: string;
  required: boolean;
}

/** A data contract definition found in one repository. */
export interface ContractDefinition {
  /** Stable id used to match the same contract across repositories. */
  id: string;
  format:
    | 'protobuf'
    | 'openapi'
    | 'json-schema'
    | 'typescript'
    | 'javascript'
    | 'python'
    | 'kotlin'
    | 'java'
    | 'csharp'
    | 'rust'
    | 'cpp';
  /** Repository name. */
  repository: string;
  /** Repository-relative source file. */
  source: string;
  /** Contract version when the format records one (OpenAPI `info.version`). */
  version?: string;
  fields: ContractField[];
}

/** One field of a shared contract that is not identical in every repository. */
export interface ContractDeviation {
  name: string;
  /** One entry per repository that declares the field. */
  declared: Array<{ repository: string; type: string; required: boolean }>;
  issue: 'missing' | 'type' | 'required';
}

/** A contract id defined by more than one repository, with its divergences. */
export interface ContractDrift {
  id: string;
  format: ContractDefinition['format'];
  /** Repositories that define this contract id. */
  repositories: string[];
  /** Fields that diverge. Empty means the definitions match field-for-field. */
  deviations: ContractDeviation[];
}

/** Where a schema fact was declared, for evidence. */
export interface SchemaLocation {
  /** Repository-relative file. */
  file: string;
  line: number;
}

/** One column of a table, after every migration has been replayed. */
export interface SchemaColumn {
  name: string;
  /** Normalised type: `integer`, `varchar(255)`, `numeric(10,2)`, `timestamptz`. */
  type: string;
  /** False when the column is NOT NULL or part of the primary key. */
  nullable: boolean;
  /** The default expression as written, `serial`/`identity`/`auto-increment` for generated keys. */
  default?: string;
  /** Where the column was last declared or redefined. */
  declared: SchemaLocation;
}

/** A table-level rule: a key, a uniqueness rule, a foreign key, or a check. */
export interface SchemaConstraint {
  kind: 'primary-key' | 'unique' | 'foreign-key' | 'check';
  /** The name given in the migration, when there is one. */
  name?: string;
  /** Constrained columns; empty for a check that names none. */
  columns: string[];
  /** The referenced table and columns of a foreign key. */
  references?: { table: string; columns: string[]; onDelete?: string; onUpdate?: string };
  /** The expression of a check, as written. */
  expression?: string;
  declared: SchemaLocation;
}

export interface SchemaIndex {
  name?: string;
  columns: string[];
  unique: boolean;
  /** The predicate of a partial index, as written. */
  where?: string;
  declared: SchemaLocation;
}

export interface SchemaTable {
  /** Lower-case name; the default schema (`public`, `dbo`) is dropped. */
  name: string;
  columns: SchemaColumn[];
  constraints: SchemaConstraint[];
  indexes: SchemaIndex[];
  declared: SchemaLocation;
}

/** A statement the parser saw but could not apply, so the snapshot may be incomplete there. */
export interface SchemaGap {
  file: string;
  line: number;
  /** The statement's first words, e.g. `ALTER TABLE orders`. */
  statement: string;
  reason: string;
}

/** The schema a repository's SQL files describe once replayed in order. */
export interface SchemaSnapshot {
  repository: string;
  /** `live` is introspected from a running database, the others come from repository files. */
  origin: 'migrations' | 'dump' | 'live';
  /** The engine the SQL reads as, judged from its syntax; absent when there is no clue. */
  dialect?: SqlDialect;
  /** The SQL files applied, in the order they were replayed. */
  files: string[];
  tables: SchemaTable[];
  gaps: SchemaGap[];
  /** ISO time a live introspection was taken; absent for repository files. */
  capturedAt?: string;
}

/** One place source code names a data table, with the columns it names there. */
export interface CodeDataUse {
  repository: string;
  file: string;
  line: number;
  /** Lower-case table name, without the default schema. */
  table: string;
  /** Columns the code names for this table; only those the scan could attribute to it. */
  columns: string[];
  /** The rule that read it: string-literal SQL, an ORM annotation, or a macro. */
  evidence: string;
  /** `strong` for a statement shape or a mapping declaration, `weak` for a bare SELECT literal. */
  confidence: 'strong' | 'weak';
}

/** Code that names a table or column no SQL file in the workspace declares. */
export interface SchemaUsageFinding {
  kind: 'unknown-table' | 'unknown-column';
  repository: string;
  file: string;
  line: number;
  table: string;
  column?: string;
  evidence: string;
  confidence: CodeDataUse['confidence'];
  /** Repositories whose schema declares the table, for an unknown column. */
  definedIn?: string[];
}

/** A table declared by more than one repository, with the columns that disagree. */
export interface SchemaDrift {
  table: string;
  repositories: string[];
  deviations: Array<{
    column: string;
    declared: Array<{ repository: string; type: string; nullable: boolean }>;
    issue: 'missing' | 'type' | 'nullable';
  }>;
}

export interface SchemaUsageReport {
  /** False when no repository declares a schema, so there was nothing to check against. */
  checked: boolean;
  uses: CodeDataUse[];
  findings: SchemaUsageFinding[];
  drift: SchemaDrift[];
}

/**
 * How a change treats the systems that already depend on the old shape.
 *
 * `breaking` fails an existing reader or writer whatever its role; `conditional` is safe for
 * one direction only and the reason names which; `safe` needs nothing from anyone.
 */
export type Compatibility = 'breaking' | 'conditional' | 'safe';

/** One difference between two revisions of a contract or a database schema. */
export interface CompatChange {
  subject: 'contract' | 'schema';
  /** The contract id, or the table name. */
  id: string;
  target: 'contract' | 'field' | 'table' | 'column' | 'constraint' | 'index';
  /** The field, column, constraint or index the change is about. */
  name?: string;
  change: 'added' | 'removed' | 'type-changed' | 'required-changed' | 'nullability-changed' | 'default-changed' | 'modified';
  compatibility: Compatibility;
  before?: string;
  after?: string;
  /** Why it is classified this way, naming the direction when the answer depends on one. */
  reason: string;
  /** Where the element is declared: at head, or at base for a removal. */
  file?: string;
  line?: number;
  /** Code that still names a removed element, or writes without a newly required one. */
  references?: Array<{ repository: string; file: string; line: number }>;
  /** Other repositories that declare the same contract and would see the change. */
  consumers?: string[];
}

/** The compatibility of one repository between two revisions. */
export interface CompatReport {
  repository: string;
  /** The revision changes are measured from. */
  base: string;
  /** The revision measured to; `working tree` when none was given. */
  head: string;
  changes: CompatChange[];
  summary: { breaking: number; conditional: number; safe: number };
  /** Set when a side could not be read; the report then holds no changes. */
  unavailable?: string;
}

export type SqlDialect = 'postgres' | 'mysql' | 'sqlite';

/**
 * A database the operator lets Strabo probe, read-only. The connection string is never in the
 * config: `urlEnv` names the environment variable that holds it.
 */
export interface DatabaseConfig {
  name: string;
  dialect: 'postgres';
  urlEnv: string;
}

/**
 * A database the operator lets Strabo probe, read-only. The connection string is never in the
 * config:  names the environment variable that holds it.
 */
export interface DatabaseConfig {
  name: string;
  dialect: 'postgres';
  urlEnv: string;
}

/** What running a preflight query against a real database found. */
export interface PreflightResult {
  /** `ok` means zero rows would break it; `violations` that some would; `error` that it did not run. */
  status: 'ok' | 'violations' | 'error';
  violations?: number;
  error?: string;
  /** ISO time the query ran. */
  ranAt: string;
  durationMs?: number;
  /** The declared database it ran against. */
  database: string;
}

/** A read-only query that counts the rows one operation of a migration would trip over. */
export interface PreflightCheck {
  id: string;
  table: string;
  column?: string;
  operation:
    | 'add-not-null-column'
    | 'set-not-null'
    | 'add-unique'
    | 'add-primary-key'
    | 'add-foreign-key'
    | 'add-check'
    | 'convert-type'
    | 'drop-column'
    | 'drop-table';
  description: string;
  /** `blocks`: a count above zero makes the migration fail. `data-loss`: the count is what is lost. */
  severity: 'blocks' | 'data-loss';
  /** What a non-zero `violations` means for this operation, in words. */
  failsWhen: string;
  /** One row, one column named `violations`. Read-only; no user text reaches it unquoted. */
  sql: string;
  /** True when the query stands in for the database's own cast or engine rules. */
  approximate?: boolean;
  /** Where the migration declares the operation. */
  file?: string;
  line?: number;
  /** Code that still names what a drop removes. */
  references?: Array<{ repository: string; file: string; line: number }>;
  result?: PreflightResult;
}

/** An operation the preflight could not turn into a query, and why. */
export interface PreflightSkip {
  table: string;
  column?: string;
  operation: string;
  reason: string;
  file?: string;
  line?: number;
}

/** One place a live database and a repository's migrations disagree. */
export interface LiveDrift {
  /** The repository whose migrations were compared. */
  repository: string;
  table: string;
  column?: string;
  kind:
    | 'table-not-in-live'
    | 'table-not-in-repository'
    | 'column-not-in-live'
    | 'column-not-in-repository'
    | 'type'
    | 'nullability';
  /** The value in the live database, where the kind has one. */
  live?: string;
  /** The value the repository's migrations declare, where the kind has one. */
  declared?: string;
}

/** A live database's schema, and where it disagrees with each repository's migrations. */
export interface LiveSchemaReport {
  database: string;
  capturedAt: string;
  tables: number;
  /** The live schema in the same shape as a repository's; null when the database has no tables. */
  snapshot: SchemaSnapshot | null;
  drift: LiveDrift[];
}

export interface PreflightReport {
  repository: string;
  base: string;
  head: string;
  dialect: SqlDialect;
  checks: PreflightCheck[];
  skipped: PreflightSkip[];
  unavailable?: string;
}

/** The combined multi-repository analysis. */
export interface WorkspaceReport {
  name: string;
  repositories: WorkspaceRepository[];
  flows: CrossRepoFlow[];
  contracts: ContractDefinition[];
  drift: ContractDrift[];
  /** HTTP endpoints repositories declare, from their OpenAPI documents. */
  serviceEndpoints: ServiceEndpoint[];
  /** Recorded calls joined to a declared endpoint in another repository. */
  serviceFlows: ServiceFlow[];
  /** The database schema each repository's SQL files describe; repositories with none are absent. */
  schemas: SchemaSnapshot[];
  /** Code that names tables and columns, checked against every declared schema. */
  usage: SchemaUsageReport;
  /** Totals for the status line; never a verdict. */
  summary: {
    repositories: number;
    flows: number;
    contracts: number;
    drifting: number;
    serviceFlows: number;
    tables: number;
  };
}

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
  dependsOn: number;
  usedBy: number;
  why: string;
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
  /**
   * Interface the standalone server binds. Defaults to loopback; set it (via
   * `STRABO_HOST` / `--host`) only to expose the server deliberately. Embedded hosts
   * listen themselves and leave this unset.
   */
  host?: string;
  /**
   * Permit `PUT /settings` to widen `scanCeiling` beyond its startup value.
   *
   * Startup-only: `STRABO_ALLOW_CEILING_WIDENING` or `--allow-ceiling-widening`. It is
   * reported by `GET /settings` but never accepted by `PUT /settings` and never read
   * from the persisted settings, so a request cannot grant itself a wider boundary —
   * not directly, and not by surviving a restart. Off by default, so a fresh process
   * cannot grow its own read boundary without an explicit opt-in.
   */
  allowCeilingWidening?: boolean;
  /**
   * Rebuild a stale graph in the background when a request observes that HEAD moved.
   * Defaults to true; `STRABO_AUTO_REBUILD=0` turns it off so a scan only runs on demand.
   */
  autoRebuild?: boolean;
  integrations?: StraboIntegrations;
  /**
   * Dependency-risk lookup. Online advisory/license calls are opt-in and off by default;
   * inventory and file mapping work without them.
   */
  risk?: RiskConfig;
  /**
   * Optional LLM narrator. Off unless an endpoint and model are supplied; only recorded
   * evidence is sent, and the API key is read from the environment, never the config.
   */
  narrator?: NarratorConfig;
  serverLog?: (message: string, error?: unknown) => void;
}

export interface RiskConfig {
  /** Allow contacting OSV.dev and deps.dev. Defaults to false. */
  online?: boolean;
  /** SPDX identifiers the license policy denies, replacing the default strong-copyleft set. */
  deniedLicenses?: string[];
}

/**
 * Opt-in configuration for the LLM narrator.
 *
 * There is no default endpoint and no default model: without both, the narrator stays
 * unconfigured and nothing contacts a third party. The endpoint must be `https:` or a
 * loopback address, so a plaintext call off the machine is refused. The API key is never
 * held here — only the name of the environment variable that supplies it.
 */
export interface NarratorConfig {
  /** Chat-completions endpoint. Required to enable the narrator. Must be https: or loopback. */
  endpoint?: string;
  /** Model name to request. Required to enable the narrator. */
  model?: string;
  /** Environment variable holding the API key. Defaults to `STRABO_NARRATOR_API_KEY`. */
  apiKeyEnv?: string;
  /** Maximum narrated requests per server session. Defaults to 20. */
  requestBudget?: number;
  /** Send recorded source snippets as well as evidence. Defaults to false (evidence only). */
  sendSource?: boolean;
}

/** Options accepted by the graph endpoint. */
export interface GraphRequestOptions {
  repository?: string;
  path?: string;
  refresh?: boolean;
  blockDepth?: number;
  blockPrefix?: string;
}
