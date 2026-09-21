import type { ResolvedRepository } from '../boundary/repository-root.ts';
import { getCachedGraph } from '../cache/graph-cache.ts';
import { openWorkspaceCache, type WorkspaceCache } from '../cache/workspace-cache.ts';
import { describeRepository } from '../repository.ts';
import type {
  CodeDataUse,
  ContractDefinition,
  SchemaSnapshot,
  ServiceCall,
  ServiceEndpoint,
  WorkspaceReport,
  WorkspaceRepository,
} from '../types.ts';
import { computeContractDrift, extractContracts } from './contracts.ts';
import { readPublishedCoordinate } from './coordinate.ts';
import { extractDataUses } from './data-usage.ts';
import { extractLanguageContracts } from './dto.ts';
import { computeCrossRepoFlows, type RepoFlowFact } from './flows.ts';
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
}

interface RepoAnalysis extends RepoFlowFact, RepoServiceFact {
  descriptor: WorkspaceRepository;
  contracts: ContractDefinition[];
  endpoints: ServiceEndpoint[];
  calls: ServiceCall[];
  schema: SchemaSnapshot | null;
  dataUses: CodeDataUse[];
}

/**
 * Analyze several repositories together.
 *
 * Each repository's graph comes from the shared graph cache, so an unchanged repository is
 * never rescanned. Its published coordinate and data contracts are cached per fingerprint
 * in the workspace fact cache and re-extracted only when that fingerprint changes. Flows and
 * contract drift are then computed from those facts, which is cheap and always current.
 */
export async function analyzeWorkspace(
  name: string,
  repositories: ResolvedRepository[],
  options: AnalyzeWorkspaceOptions = {},
): Promise<WorkspaceReport> {
  const cache = options.cache ?? openWorkspaceCache();
  const analyses: RepoAnalysis[] = [];

  for (const repository of repositories) {
    const cached = await getCachedGraph(repository.root);
    const info = await describeRepository(repository.root);
    const stored = cache.get(repository.root, cached.fingerprint);
    const facts = stored ?? {
      publishes: readPublishedCoordinate(repository.root),
      contracts: [
        ...extractContracts(repository.root, repository.name),
        ...extractLanguageContracts(repository.root, repository.name),
      ],
      endpoints: extractServiceEndpoints(repository.root, repository.name),
      calls: extractServiceCalls(repository.root),
      schema: extractSchema(repository.root, repository.name),
      dataUses: extractDataUses(repository.root, repository.name),
    };
    if (!stored) {
      cache.set(repository.root, cached.fingerprint, facts);
    }
    analyses.push({
      name: repository.name,
      publishes: facts.publishes,
      graph: cached.report.graph,
      contracts: facts.contracts,
      endpoints: facts.endpoints,
      calls: facts.calls,
      schema: facts.schema,
      dataUses: facts.dataUses,
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
