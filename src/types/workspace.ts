import type { DataReport } from './data.ts';
import type { DependencyEcosystem } from './enums.ts';
import type { PublishedCoordinate } from './scan.ts';
import type { SchemaSnapshot, SchemaUsageReport } from './schema.ts';

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

/**
 * A schema an OpenAPI operation declares for its request body or a response.
 *
 * `schema` names the `components.schemas` entry when the operation `$ref`s one, so a reader can
 * jump to the shared contract; it is null for an inline schema, which is kept with its fields
 * rather than dropped.
 */
export interface ApiSchemaRef {
  /** The `components.schemas` name, or null when the schema is inline. */
  schema: string | null;
  /** The schema's fields, normalised like a data contract's. */
  fields: ContractField[];
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
  /** OpenAPI `operationId`, when the operation names one. */
  operationId?: string | null;
  /** The request body's JSON schema, when the operation declares one. */
  request?: ApiSchemaRef | null;
  /** The first recorded 2xx JSON response schema, when the operation declares one. */
  response?: ApiSchemaRef | null;
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
  /** Protobuf field number, when the format records one. */
  number?: number;
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
  /** The data layer as a graph of datasets, contracts, products, and lineage (Phase 33). */
  data: DataReport;
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
