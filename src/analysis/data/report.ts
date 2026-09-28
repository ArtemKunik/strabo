import type {
  ClassificationTag,
  CodeDataUse,
  ContractDefinition,
  ContractField,
  DataEdge,
  DataPort,
  DataProduct,
  DataReport,
  DatasetNode,
  EventContract,
  EventEndpoint,
  Graph,
  LineageEdge,
  SchemaSnapshot,
} from '../../types.ts';
import { assignUnits, detectUnits } from '../units.ts';
import { buildCandidates } from './candidates.ts';
import { propagateClassification } from './classification.ts';
import { readCodeowners } from './codeowners.ts';
import { buildConformance } from './conformance.ts';
import { buildEvents, eventContractId, topicDatasetId } from './events.ts';
import { identifyContracts, shapeTwins } from './identity.ts';
import { buildModel } from './model.ts';
import type { DbtExtraction, DbtModelReference } from '../../workspace/dbt.ts';
import type { RawLineage, RawPathIo } from '../../workspace/lineage.ts';
import type { CatalogDeclaration } from '../../types.ts';

/** One workspace repository and its recorded graph, for the data analysis. */
export interface DataRepository {
  name: string;
  root: string;
  graph: Graph;
}

export interface DataReportInput {
  repositories: readonly DataRepository[];
  schemas: readonly SchemaSnapshot[];
  usage: readonly CodeDataUse[];
  contracts: readonly ContractDefinition[];
  eventEndpoints: readonly EventEndpoint[];
  eventContracts: readonly EventContract[];
  products: readonly DataProduct[];
  rawLineage: readonly RawLineage[];
  dbt: DbtExtraction;
  pathIo: readonly RawPathIo[];
  catalogs: readonly CatalogDeclaration[];
  /** Turn qualified contract ids on (`contracts.identity: qualified`); bare ids remain reported. */
  qualifiedContracts?: boolean;
}

const DATASET_PREFIX = 'db:';

/** The dataset id a repository's table or model carries. */
export function datasetId(repository: string, table: string): string {
  return `${DATASET_PREFIX}${repository}/${table}`;
}

function pathDatasetId(literal: string): string {
  return `path:${literal}`;
}

function productNodeId(id: string): string {
  return `product:${id}`;
}

function contractNodeId(id: string): string {
  return `contract:${id}`;
}

/**
 * Compose the data report (Phase 33) from the facts the workspace analysis already extracted.
 *
 * Pure over its inputs apart from reading each repository's CODEOWNERS and build units, so a
 * single repository and a multi-repository workspace run the same code. Every array is empty
 * rather than absent when nothing was recorded; `summary.modeled` is false when there was no
 * schema and no data use to assemble.
 */
export function buildDataReport(input: DataReportInput): DataReport {
  const model = buildModel(input.schemas, input.usage);
  const identities = identifyContracts(input.contracts, input.qualifiedContracts === true);
  const events = buildEvents(input.eventEndpoints, input.eventContracts);

  const datasets = new Map<string, DatasetNode>();
  for (const dataset of model.datasets) {
    datasets.set(dataset.id, dataset);
  }
  for (const dataset of events.datasets) {
    datasets.set(dataset.id, dataset);
  }

  const edges: DataEdge[] = [...model.edges, ...events.edges];
  const governs: DataEdge[] = [...events.governs];

  addPathDatasets(datasets, edges, input.pathIo);
  addDbtModelDatasets(datasets, input.dbt);
  const lineage = buildLineage(input);
  for (const edge of lineage) {
    if (!datasets.has(edge.source)) {
      datasets.set(edge.source, {
        id: edge.source,
        kind: 'table',
        label: edge.source.replace(DATASET_PREFIX, ''),
        repository: edge.evidence.repository,
        strength: 'weak',
      });
    }
  }

  const byLabel = labelIndex(datasets);
  const { resolvedProducts, exposes } = resolveProducts(input.products, byLabel);
  edges.push(...exposes);

  // A Phase 11 contract governs a dataset only when its bare name matches the dataset label;
  // that is a name match, so it is recorded `weak` and never treated as a declaration.
  for (const identity of identities) {
    for (const dataset of byLabel.get(identity.bareId.toLowerCase()) ?? []) {
      if (dataset.kind === 'table' || dataset.kind === 'view' || dataset.kind === 'materialized-view') {
        governs.push({
          kind: 'governs',
          source: contractNodeId(identity.id),
          target: dataset.id,
          strength: 'weak',
          evidence: { repository: identity.repository, file: identity.source, line: 1 },
          detail: 'bare-name contract match',
        });
      }
    }
  }

  const governedBy = new Map<string, string[]>();
  for (const edge of governs) {
    const list = governedBy.get(edge.target) ?? [];
    list.push(edge.source);
    governedBy.set(edge.target, list);
  }

  const unitOf = buildUnitResolver(input.repositories);
  const codeowners = new Map(input.repositories.map((repository) => [repository.name, readCodeowners(repository.root)]));
  const productOwner = productOwnerIndex(resolvedProducts);
  const candidates = buildCandidates({
    datasets: [...datasets.values()],
    edges,
    unitOf,
    codeownerOf: (repository, file) => codeowners.get(repository)?.ownerOf(file) ?? null,
    productOwnerOf: (dataset) => productOwner(dataset),
    governedBy,
  });

  const implementationColumns = buildImplementationColumns(datasets, input.dbt);
  // A product port is resolved to a dataset id above, so a later lookup accepts a label or an id.
  const resolveDataset = (name: string): DatasetNode | null =>
    resolveByName(byLabel, name) ?? datasets.get(name) ?? null;
  const conformance = buildConformance({
    products: resolvedProducts,
    contracts: identities,
    resolveDataset,
    implementationColumns,
  });

  const declaredClassifications = buildDeclaredClassifications(resolvedProducts, resolveDataset);
  const classifications = [
    ...declaredClassifications,
    ...propagateClassification({ declared: declaredClassifications, lineage }),
  ];

  const catalogs = input.catalogs.map((declaration) => ({
    ...declaration,
    observed: [...datasets.values()].some(
      (dataset) =>
        dataset.label === declaration.dataset ||
        dataset.label === declaration.dataset.split('.').pop() ||
        dataset.id === declaration.dataset,
    ),
  }));

  const allDatasets = [...datasets.values()].sort((a, b) => a.id.localeCompare(b.id));
  const allEdges = dedupeEdges([...edges, ...governs]);

  const unavailable: string[] = [];
  if (input.schemas.length === 0 && input.usage.length === 0 && input.eventEndpoints.length === 0) {
    unavailable.push('no schema, data use, or event was recorded, so no data layer was assembled');
  }

  return {
    datasets: allDatasets,
    edges: allEdges,
    model: model.model,
    contracts: identities,
    shapeTwins: shapeTwins(identities),
    events: events.flows,
    eventContracts: [...input.eventContracts],
    products: resolvedProducts,
    candidates,
    conformance,
    lineage,
    classifications,
    catalogs,
    dbt: input.dbt.projects,
    summary: {
      datasets: allDatasets.length,
      tables: allDatasets.filter((dataset) => dataset.kind === 'table' || dataset.kind === 'view' || dataset.kind === 'materialized-view').length,
      topics: allDatasets.filter((dataset) => dataset.kind === 'topic' || dataset.kind === 'queue').length,
      contracts: identities.length,
      products: resolvedProducts.length,
      candidates: candidates.length,
      conformance: conformance.length,
      lineage: lineage.length,
      modeled: input.schemas.length > 0 || input.usage.length > 0,
    },
    unavailable,
  };
}

function labelIndex(datasets: Map<string, DatasetNode>): Map<string, DatasetNode[]> {
  const index = new Map<string, DatasetNode[]>();
  for (const dataset of datasets.values()) {
    const key = dataset.label.toLowerCase();
    const list = index.get(key) ?? [];
    list.push(dataset);
    index.set(key, list);
  }
  return index;
}

function resolveByName(index: Map<string, DatasetNode[]>, name: string): DatasetNode | null {
  const list = index.get(name.toLowerCase());
  return list && list.length > 0 ? (list[0] as DatasetNode) : null;
}

function addPathDatasets(
  datasets: Map<string, DatasetNode>,
  edges: DataEdge[],
  pathIo: readonly RawPathIo[],
): void {
  for (const item of pathIo) {
    const id = pathDatasetId(item.path);
    if (!datasets.has(id)) {
      datasets.set(id, { id, kind: 'path', label: item.path, repository: null, strength: 'strong' });
    }
    edges.push({
      kind: item.direction === 'read' ? 'reads' : 'writes',
      source: item.file,
      target: id,
      strength: 'strong',
      evidence: { repository: item.repository, file: item.file, line: item.line },
      detail: item.evidence,
    });
  }
}

function addDbtModelDatasets(datasets: Map<string, DatasetNode>, dbt: DbtExtraction): void {
  const columnsByModel = new Map<string, ContractField[]>();
  for (const column of dbt.columns) {
    const key = `${column.repository}\u0000${column.model}`;
    const list = columnsByModel.get(key) ?? [];
    list.push({ name: column.name, type: 'unknown', required: false });
    columnsByModel.set(key, list);
  }
  for (const [key, columns] of columnsByModel) {
    const [repository, modelName] = key.split('\u0000');
    if (!repository || !modelName) {
      continue;
    }
    const id = datasetId(repository, modelName);
    if (datasets.has(id)) {
      continue;
    }
    datasets.set(id, {
      id,
      kind: 'table',
      label: modelName,
      repository,
      columns: columns.sort((a, b) => a.name.localeCompare(b.name)),
      strength: 'strong',
    });
  }
}

function buildLineage(input: DataReportInput): LineageEdge[] {
  const edges: LineageEdge[] = [];

  for (const raw of input.rawLineage) {
    edges.push({
      source: datasetId(raw.repository, raw.sourceTable),
      target: datasetId(raw.repository, raw.targetTable),
      strength: 'strong',
      evidence: { repository: raw.repository, file: raw.file, line: raw.line },
      detail: raw.evidence,
      ...(raw.columns.length > 0 ? { columns: raw.columns } : {}),
    });
  }

  for (const schema of input.schemas) {
    for (const table of schema.tables) {
      for (const dependency of table.viewDependencies ?? []) {
        edges.push({
          source: datasetId(schema.repository, dependency),
          target: datasetId(schema.repository, table.name),
          strength: 'strong',
          evidence: { repository: schema.repository, file: table.declared.file, line: table.declared.line },
          detail: `view ${table.name} selects from ${dependency}`,
        });
      }
    }
  }

  for (const reference of input.dbt.references) {
    edges.push(dbtLineage(reference));
  }

  return dedupeLineage(edges);
}

function dbtLineage(reference: DbtModelReference): LineageEdge {
  const model = reference.file.replace(/^.*\//, '').replace(/\.sql$/, '');
  return {
    source: datasetId(reference.repository, reference.target),
    target: datasetId(reference.repository, model),
    strength: 'strong',
    evidence: { repository: reference.repository, file: reference.file, line: reference.line },
    detail: reference.evidence,
  };
}

function resolveProducts(
  products: readonly DataProduct[],
  byLabel: Map<string, DatasetNode[]>,
): { resolvedProducts: DataProduct[]; exposes: DataEdge[] } {
  const exposes: DataEdge[] = [];
  const resolvedProducts = products.map((product) => {
    const outputPorts = resolvePorts(product, product.outputPorts, byLabel, exposes, 'output');
    const inputPorts = resolvePorts(product, product.inputPorts, byLabel, exposes, 'input');
    return { ...product, outputPorts, inputPorts };
  });
  return { resolvedProducts, exposes };
}

function resolvePorts(
  product: DataProduct,
  ports: DataPort[],
  byLabel: Map<string, DatasetNode[]>,
  exposes: DataEdge[],
  direction: 'input' | 'output',
): DataPort[] {
  return ports.map((port) => {
    const dataset = resolveByName(byLabel, port.dataset);
    if (!dataset) {
      return port;
    }
    exposes.push({
      kind: 'exposes',
      source: productNodeId(product.id),
      target: dataset.id,
      strength: 'declared',
      evidence: { repository: product.repository, file: product.source, line: 1 },
      detail: direction === 'output' ? 'output port' : 'input port',
    });
    return { ...port, dataset: dataset.id };
  });
}

function productOwnerIndex(products: readonly DataProduct[]): (dataset: string) => string | null {
  const owners = new Map<string, string>();
  for (const product of products) {
    if (!product.owner) {
      continue;
    }
    for (const port of product.outputPorts) {
      if (!owners.has(port.dataset)) {
        owners.set(port.dataset, product.owner);
      }
    }
  }
  return (dataset) => owners.get(dataset) ?? null;
}

function buildImplementationColumns(
  datasets: Map<string, DatasetNode>,
  dbt: DbtExtraction,
): (datasetId: string) => ContractField[] | null {
  const byId = new Map<string, ContractField[]>();
  for (const dataset of datasets.values()) {
    if (dataset.columns && dataset.columns.length > 0 && dataset.columns.some((column) => column.type !== 'unknown')) {
      byId.set(dataset.id, dataset.columns);
    }
  }
  // A dbt model's projection proves the columns exist even when their types are not read.
  for (const column of dbt.columns) {
    const id = datasetId(column.repository, column.model);
    if (!byId.has(id)) {
      const list = byId.get(id) ?? [];
      list.push({ name: column.name, type: 'unknown', required: false });
      byId.set(id, list);
    }
  }
  return (id) => (byId.has(id) ? (byId.get(id) as ContractField[]) : null);
}

function buildDeclaredClassifications(
  products: readonly DataProduct[],
  resolveDataset: (name: string) => DatasetNode | null,
): ClassificationTag[] {
  const tags: ClassificationTag[] = [];
  for (const product of products) {
    if (product.classification.length === 0) {
      continue;
    }
    const port = product.outputPorts[0] ?? product.inputPorts[0];
    const dataset = port ? resolveDataset(port.dataset) : null;
    if (!dataset) {
      continue;
    }
    for (const entry of product.classification) {
      tags.push({
        dataset: dataset.id,
        field: entry.field === '' ? null : entry.field,
        tag: entry.tag,
        source: 'declared',
        path: [{ dataset: dataset.id, file: product.source, detail: `declared ${entry.tag} on ${entry.field || 'the dataset'}` }],
      });
    }
  }
  return tags;
}

function buildUnitResolver(repositories: readonly DataRepository[]): (repository: string, file: string) => string {
  const assignments = new Map<string, Map<string, string>>();
  for (const repository of repositories) {
    const files = repository.graph.nodes.map((node) => node.id);
    const units = detectUnits(repository.root, files, repository.name);
    assignments.set(repository.name, assignUnits(files, units));
  }
  return (repository, file) => assignments.get(repository)?.get(file) ?? '.';
}

function dedupeEdges(edges: DataEdge[]): DataEdge[] {
  const seen = new Set<string>();
  return edges
    .sort(
      (a, b) =>
        a.source.localeCompare(b.source) ||
        a.target.localeCompare(b.target) ||
        a.kind.localeCompare(b.kind) ||
        (a.evidence?.line ?? 0) - (b.evidence?.line ?? 0),
    )
    .filter((edge) => {
      const key = `${edge.kind}\u0000${edge.source}\u0000${edge.target}\u0000${edge.evidence?.repository ?? ''}\u0000${edge.evidence?.file ?? ''}\u0000${edge.evidence?.line ?? 0}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function dedupeLineage(edges: LineageEdge[]): LineageEdge[] {
  const seen = new Set<string>();
  return edges
    .sort(
      (a, b) =>
        a.source.localeCompare(b.source) ||
        a.target.localeCompare(b.target) ||
        a.evidence.file.localeCompare(b.evidence.file) ||
        a.evidence.line - b.evidence.line,
    )
    .filter((edge) => {
      const key = `${edge.source}\u0000${edge.target}\u0000${edge.evidence.repository}\u0000${edge.evidence.file}\u0000${edge.evidence.line}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

// Re-exported so the API and tests can name the event dataset ids without importing events.ts.
export { topicDatasetId, eventContractId };
