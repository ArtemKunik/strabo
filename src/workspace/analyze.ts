import type { ResolvedRepository } from '../boundary/repository-root.ts';
import { getCachedGraph } from '../cache/graph-cache.ts';
import { openWorkspaceCache, type WorkspaceCache } from '../cache/workspace-cache.ts';
import { describeRepository } from '../repository.ts';
import type {
  CatalogDeclaration,
  CodeDataUse,
  ContractDefinition,
  DataProduct,
  DataReport,
  EventContract,
  EventEndpoint,
  Graph,
  SchemaSnapshot,
  ServiceCall,
  ServiceEndpoint,
  WorkspaceReport,
  WorkspaceRepository,
} from '../types.ts';
import { buildDataReport } from '../analysis/data/report.ts';
import { extractCatalogDeclarations } from './catalog.ts';
import { computeContractDrift, extractContracts } from './contracts.ts';
import { readPublishedCoordinate } from './coordinate.ts';
import { extractDataUses } from './data-usage.ts';
import { extractDbt, type DbtExtraction } from './dbt.ts';
import { extractLanguageContracts } from './dto.ts';
import { extractEventContracts, extractEventEndpoints } from './events.ts';
import { computeCrossRepoFlows, type RepoFlowFact } from './flows.ts';
import { extractPathIo, extractSqlLineage, type RawLineage, type RawPathIo } from './lineage.ts';
import { extractDeclaredProducts } from './products.ts';
import { extractSchema } from './schema.ts';
import { computeSchemaUsage } from './schema-usage.ts';
import {
  computeServiceFlows,
  extractServiceCalls,
  extractServiceEndpoints,
  type RepoServiceFact,
} from './services.ts';

export interface AnalyzeWorkspaceOptions {
  /** Injectable fact cache; defaults to the persisted one beside the graph cache. */
  cache?: WorkspaceCache;
  /** Use qualified contract ids alongside bare names (`contracts.identity: qualified`). */
  qualifiedContracts?: boolean;
}

interface RepoAnalysis extends RepoFlowFact, RepoServiceFact, RepositoryFacts {
  descriptor: WorkspaceRepository;
}

/** The cached per-repository facts a single repository's data layer is assembled from. */
export interface RepositoryFacts {
  graph: Graph;
  publishes: ReturnType<typeof readPublishedCoordinate>;
  contracts: ContractDefinition[];
  endpoints: ServiceEndpoint[];
  calls: ServiceCall[];
  schema: SchemaSnapshot | null;
  dataUses: CodeDataUse[];
  eventEndpoints: EventEndpoint[];
  eventContracts: EventContract[];
  products: DataProduct[];
  lineage: RawLineage[];
  pathIo: RawPathIo[];
  catalogs: CatalogDeclaration[];
  dbt: DbtExtraction;
}

/**
 * Read one repository's cached graph and per-fingerprint data facts, extracting only when the
 * fingerprint changed. Shared by the multi-repository workspace analysis and the single-
 * repository data layer, so both read the same facts from the same cache.
 */
export async function collectRepositoryFacts(
  root: string,
  name: string,
  cache: WorkspaceCache,
): Promise<RepositoryFacts> {
  const cached = await getCachedGraph(root);
  const stored = cache.get(root, cached.fingerprint);
  const facts = stored ?? {
    publishes: readPublishedCoordinate(root),
    contracts: [...extractContracts(root, name), ...extractLanguageContracts(root, name)],
    endpoints: extractServiceEndpoints(root, name),
    calls: extractServiceCalls(root),
    schema: extractSchema(root, name),
    dataUses: extractDataUses(root, name),
    eventEndpoints: extractEventEndpoints(root, name),
    eventContracts: extractEventContracts(root, name),
    products: extractDeclaredProducts(root, name),
    lineage: extractSqlLineage(root, name),
    pathIo: extractPathIo(root, name),
    catalogs: extractCatalogDeclarations(root, name),
    dbt: extractDbt(root, name),
  };
  if (!stored) {
    cache.set(root, cached.fingerprint, facts);
  }
  return { graph: cached.report.graph, ...facts };
}

/**
 * Assemble the data layer for one repository and return it as a `DataReport`. The report
 * composition reuses this so a single-repository report and a workspace report agree.
 */
export async function analyzeRepository(
  name: string,
  root: string,
  options: AnalyzeWorkspaceOptions = {},
): Promise<DataReport> {
  const cache = options.cache ?? openWorkspaceCache();
  const facts = await collectRepositoryFacts(root, name, cache);
  cache.save();
  const schemas = facts.schema ? [facts.schema] : [];
  const usage = computeSchemaUsage(schemas, facts.dataUses);
  return buildDataReport({
    repositories: [{ name, root, graph: facts.graph }],
    schemas,
    usage: usage.uses,
    contracts: facts.contracts,
    eventEndpoints: facts.eventEndpoints,
    eventContracts: facts.eventContracts,
    products: facts.products,
    rawLineage: facts.lineage,
    dbt: facts.dbt,
    pathIo: facts.pathIo,
    catalogs: facts.catalogs,
    ...(options.qualifiedContracts !== undefined ? { qualifiedContracts: options.qualifiedContracts } : {}),
  });
}

/**
 * Analyze several repositories together.
 *
 * Each repository's graph comes from the shared graph cache, so an unchanged repository is
 * never rescanned. Its published coordinate, data contracts, event contracts, declared
 * products, SQL lineage, and catalog snapshots are cached per fingerprint in the workspace
 * fact cache and re-extracted only when that fingerprint changes. Flows, contract drift, and
 * the data layer are then computed from those facts, which is cheap and always current.
 */
export async function analyzeWorkspace(
  name: string,
  repositories: ResolvedRepository[],
  options: AnalyzeWorkspaceOptions = {},
): Promise<WorkspaceReport> {
  const cache = options.cache ?? openWorkspaceCache();
  const analyses: RepoAnalysis[] = [];

  for (const repository of repositories) {
    const info = await describeRepository(repository.root);
    const facts = await collectRepositoryFacts(repository.root, repository.name, cache);
    analyses.push({
      name: repository.name,
      ...facts,
      descriptor: {
        name: repository.name,
        root: repository.root,
        head: info.head,
        dirty: info.dirty,
        gitUrl: info.gitUrl,
        publishes: facts.publishes,
      },
    });
  }
  cache.save();

  const flows = computeCrossRepoFlows(analyses);
  const contracts = analyses.flatMap((analysis) => analysis.contracts);
  const drift = computeContractDrift(contracts);
  const serviceEndpoints = analyses.flatMap((analysis) => analysis.endpoints);
  const serviceFlows = computeServiceFlows(analyses);
  const descriptor = analyses.map((analysis) => analysis.descriptor);
  const schemas = analyses.flatMap((analysis) => (analysis.schema ? [analysis.schema] : []));
  const usage = computeSchemaUsage(
    schemas,
    analyses.flatMap((analysis) => analysis.dataUses),
  );

  const data = buildDataReport({
    repositories: analyses.map((analysis) => ({ name: analysis.name, root: analysis.descriptor.root, graph: analysis.graph })),
    schemas,
    usage: usage.uses,
    contracts,
    eventEndpoints: analyses.flatMap((analysis) => analysis.eventEndpoints),
    eventContracts: analyses.flatMap((analysis) => analysis.eventContracts),
    products: analyses.flatMap((analysis) => analysis.products),
    rawLineage: analyses.flatMap((analysis) => analysis.lineage),
    dbt: mergeDbt(analyses.map((analysis) => analysis.dbt)),
    pathIo: analyses.flatMap((analysis) => analysis.pathIo),
    catalogs: analyses.flatMap((analysis) => analysis.catalogs),
    ...(options.qualifiedContracts !== undefined ? { qualifiedContracts: options.qualifiedContracts } : {}),
  });

  return {
    name,
    repositories: descriptor,
    flows,
    contracts,
    drift,
    serviceEndpoints,
    serviceFlows,
    schemas,
    usage,
    data,
    summary: {
      repositories: descriptor.length,
      flows: flows.length,
      contracts: contracts.length,
      drifting: drift.filter((entry) => entry.deviations.length > 0).length,
      serviceFlows: serviceFlows.length,
      tables: schemas.reduce((total, schema) => total + schema.tables.length, 0),
    },
  };
}

function mergeDbt(extractions: readonly DbtExtraction[]): DbtExtraction {
  return {
    projects: extractions.flatMap((entry) => entry.projects),
    references: extractions.flatMap((entry) => entry.references),
    columns: extractions.flatMap((entry) => entry.columns),
  };
}
