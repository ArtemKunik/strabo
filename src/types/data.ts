import type { ContractField } from './workspace.ts';
import type { DataAccess } from './schema.ts';

/**
 * The data layer as a graph of its own (Phase 33).
 *
 * Four node kinds and the edges between them: datasets (tables, views, topics, queues, paths,
 * API resources), contracts (shape promises), producers/consumers (the files that write and
 * read a dataset), and data products (named, owned groups of ports). Every fact carries its
 * evidence and a strength, in the same way as the tier lens; nothing is inferred from a name.
 */

/** How firmly a fact is established: a descriptor said so, the scan proved it, or it is a hint. */
export type DataStrength = 'declared' | 'strong' | 'weak';

export type DatasetKind =
  | 'table'
  | 'view'
  | 'materialized-view'
  | 'topic'
  | 'queue'
  | 'path'
  | 'api-resource'
  | 'store';

/** One dataset, identified by a qualified id so it can join across repositories. */
export interface DatasetNode {
  /** `db:<repo>/<table>`, `topic:<name>`, `queue:<name>`, `path:<literal>`, or `api:<host><path>`. */
  id: string;
  kind: DatasetKind;
  /** The bare name: table, topic, path, or endpoint.
   *
   * A dataset is a WHERE (its id), and this is the WHAT a reader recognises. */
  label: string;
  /** Repository that declares the dataset, when one does; never inferred from a name. */
  repository: string | null;
  /** Where the dataset was declared (a migration, an AsyncAPI document), when known. */
  declared?: { repository: string; file: string; line?: number };
  /** Normalised shape, when the snapshot or a contract records columns. */
  columns?: ContractField[];
  strength: DataStrength;
}

export type DataEdgeKind = 'reads' | 'writes' | 'governs' | 'derives' | 'exposes';

/**
 * A recorded edge between two nodes.
 *
 * A `reads`/`writes` edge runs from a file id to a dataset id; `governs` from a contract id to
 * a dataset; `derives` from one dataset to another (lineage); `exposes` from a product to an
 * output port. The endpoints are the ids the caller already draws, so a surface never invents
 * a node to hang an edge on.
 */
export interface DataEdge {
  kind: DataEdgeKind;
  source: string;
  target: string;
  strength: DataStrength;
  evidence: { repository: string; file: string; line: number } | null;
  detail?: string;
}

/** An ORM entity linked to a table only through a declared mapping, never name similarity. */
export interface DataEntityMapping {
  repository: string;
  file: string;
  line: number;
  /** The declared entity or model name, as written. */
  entity: string;
  /** The table it declares, normalised. */
  table: string;
  /** The rule that read the mapping. */
  evidence: string;
}

export type DataModelFindingKind = 'no-primary-key' | 'foreign-key-undeclared' | 'orphan-table';

/** A structural statement about the schema, each naming what was and was not recorded. */
export interface DataModelFinding {
  kind: DataModelFindingKind;
  repository: string;
  /** Dataset id the finding is about. */
  dataset: string;
  detail: string;
  evidence?: { file: string; line: number };
  inputs?: Record<string, string | number>;
}

/** The entity-relationship view of the workspace's schema snapshot. */
export interface DataModelReport {
  entities: DataEntityMapping[];
  findings: DataModelFinding[];
}

/** One field of a contract with the format-specific detail the identity pass records. */
export type QualifiedContractField = ContractField;

/** A contract after identity and fingerprinting (Phase 33 J3). */
export interface ContractIdentity {
  /** The id the matcher uses: the qualified id when qualified matching is on, else the bare id. */
  id: string;
  /** The bare-name id (A13), always available as a weak match. */
  bareId: string;
  /** The qualified id the format allows: `package.Message`, `doc#/components/schemas/Name`, `$id`. */
  qualifiedId: string;
  format: string;
  repository: string;
  source: string;
  /** Hash of the normalised fields; two contracts with the same fingerprint have the same shape. */
  fingerprint: string;
  fields: QualifiedContractField[];
}

/** A topic or queue a repository produces to or consumes from, with its evidence. */
export interface EventEndpoint {
  topic: string;
  kind: 'topic' | 'queue';
  repository: string;
  file: string;
  line: number;
  direction: 'produce' | 'consume';
  /** The rule that read the site. */
  evidence: string;
}

/** A payload contract declared for a topic (AsyncAPI, Avro, or a schema-registry subject). */
export interface EventContract {
  /** The topic or subject the contract governs. */
  topic: string;
  format: 'asyncapi' | 'avro' | 'schema-registry';
  repository: string;
  source: string;
  fields: ContractField[];
}

/** A producer and consumer of one topic joined across repositories, like a service flow. */
export interface EventFlow {
  topic: string;
  kind: 'topic' | 'queue';
  producers: EventEndpoint[];
  consumers: EventEndpoint[];
  /** The payload contract id when one could be resolved, else null. */
  contract: string | null;
}

/** A port of a data product: a dataset the product exposes or consumes. */
export interface DataPort {
  dataset: string;
  /** The schema the descriptor declares for the port, when it names one. */
  schema?: ContractField[];
  evidence?: { file: string; line?: number };
}

export type DataProductFormat = 'odcs' | 'datacontract' | 'odps' | 'dbt' | 'strabo-groups';

/** A named, owned group of ports and the contracts that govern them (J5). */
export interface DataProduct {
  /** Stable id: `<format>:<name>` scoped by repository for a local descriptor. */
  id: string;
  name: string;
  format: DataProductFormat;
  repository: string;
  source: string;
  owner: string | null;
  outputPorts: DataPort[];
  inputPorts: DataPort[];
  /** Contract ids governing the ports, when the descriptor names them. */
  contracts: string[];
  /** Declared classifications: a field and its tag, never inferred from a name. */
  classification: Array<{ field: string; tag: string; source: string }>;
  serviceLevel?: string;
  /** A descriptor the reader could not interpret, named rather than dropped. */
  gaps?: Array<{ file: string; reason: string }>;
}

export type DataCandidateKind = 'output-port' | 'no-single-writer' | 'shared-without-contract';

/** A dataset the recorded edges show is shared, listed as evidence, never promoted to a product. */
export interface DataProductCandidate {
  dataset: string;
  kind: DataCandidateKind;
  writers: Array<{ repository: string; unit: string; file: string; line: number; access: DataAccess }>;
  readers: Array<{ repository: string; unit: string; file: string; line: number; access: DataAccess }>;
  detail: string;
  ownership: { source: 'descriptor' | 'codeowners' | 'unit'; owner: string | null };
}

/** A declared contract checked against what the code and schema actually do (J7). */
export interface DataConformanceFinding {
  contract: string;
  dataset: string | null;
  repository: string;
  kind: 'missing' | 'type' | 'required';
  field: string;
  detail: string;
  contractEvidence: { file: string; line?: number };
  implementationEvidence?: { file: string; line?: number };
}

/** A static, table-level lineage edge, from an upstream dataset to a downstream one (J8). */
export interface LineageEdge {
  source: string;
  target: string;
  strength: DataStrength;
  evidence: { repository: string; file: string; line: number };
  detail: string;
  /** Column mapping when the projection was a plain `col AS alias`; otherwise none. */
  columns?: Array<{ target: string; source: string | null; transformation: boolean }>;
}

/** A classification tag declared or propagated along lineage (J14). */
export interface ClassificationTag {
  dataset: string;
  field: string | null;
  tag: string;
  /** `declared` when a descriptor stated it; `derived` when it travelled along lineage. */
  source: 'declared' | 'derived';
  /** The evidence path, in order, from the declaration to the dataset. */
  path: Array<{ dataset: string; file: string; line?: number; detail: string }>;
}

/** One fact from an exported catalog snapshot, kept apart and never merged with recorded facts (J13). */
export interface CatalogDeclaration {
  catalog: 'datahub' | 'openmetadata' | 'unity' | 'unknown';
  repository: string;
  source: string;
  exportedAt: string | null;
  /** The product or dataset the catalog names. */
  dataset: string;
  owner: string | null;
  domain: string | null;
  classification: Array<{ field: string | null; tag: string }>;
  /** Whether the recorded scan agrees the dataset exists. */
  observed: boolean;
  detail: string;
}

/** A dbt project detected as a unit of its own (J12). */
export interface DbtProject {
  repository: string;
  /** Repository-relative directory of the dbt project (`.` for the repository root). */
  root: string;
  name: string;
  modelCount: number;
  seedCount: number;
  snapshotCount: number;
  sources: string[];
  exposures: Array<{ name: string; type: string | null; dependsOn: string[] }>;
  /** `ref()`/`source()` edges the reader could not resolve, named rather than guessed. */
  unresolved: Array<{ file: string; line: number; text: string }>;
}

/** The composed data report. Every array is empty rather than absent when nothing was recorded. */
export interface DataReport {
  datasets: DatasetNode[];
  edges: DataEdge[];
  model: DataModelReport;
  contracts: ContractIdentity[];
  /** Contracts with different ids but the same shape fingerprint (often a copied DTO). */
  shapeTwins: Array<{ fingerprint: string; contracts: string[] }>;
  events: EventFlow[];
  eventContracts: EventContract[];
  products: DataProduct[];
  candidates: DataProductCandidate[];
  conformance: DataConformanceFinding[];
  lineage: LineageEdge[];
  classifications: ClassificationTag[];
  catalogs: CatalogDeclaration[];
  dbt: DbtProject[];
  summary: {
    datasets: number;
    tables: number;
    topics: number;
    contracts: number;
    products: number;
    candidates: number;
    conformance: number;
    lineage: number;
    /** False when no schema or usage was recorded, so nothing could be assembled. */
    modeled: boolean;
  };
  /** Sections the caller could not compute, named rather than shown empty. */
  unavailable: string[];
}
