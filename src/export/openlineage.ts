import type { DataReport, DatasetNode } from '../types.ts';

const PRODUCER = 'https://github.com/ArtemKunik/strabo';

/** One OpenLineage dataset reference. */
export interface OpenLineageDatasetRef {
  namespace: string;
  name: string;
}

/** A static OpenLineage export: datasets with their schema/lineage facets, and jobs. */
export interface OpenLineageExport {
  producer: string;
  schemaURL: 'strabo-openlineage-1';
  eventTime: string;
  datasets: Array<OpenLineageDatasetRef & { facets: Record<string, unknown> }>;
  jobs: Array<{
    namespace: string;
    name: string;
    inputs: OpenLineageDatasetRef[];
    outputs: OpenLineageDatasetRef[];
    facets: Record<string, unknown>;
  }>;
}

export interface OpenLineageOptions {
  producer?: string;
  now?: string;
}

/** The namespace a dataset belongs to, derived from its qualified id. */
function namespaceOf(dataset: DatasetNode): string {
  const id = dataset.id;
  if (id.startsWith('db:')) {
    const rest = id.slice('db:'.length);
    return rest.split('/')[0] ?? 'db';
  }
  if (id.startsWith('topic:')) {
    return 'topic';
  }
  if (id.startsWith('queue:')) {
    return 'queue';
  }
  if (id.startsWith('path:')) {
    return 'path';
  }
  return 'data';
}

function refOf(dataset: DatasetNode): OpenLineageDatasetRef {
  return { namespace: namespaceOf(dataset), name: dataset.label };
}

/**
 * Export the recorded data layer as static OpenLineage datasets and jobs, so a catalog can
 * ingest what Strabo read without Strabo becoming a catalog (J10). Only recorded facts are
 * exported; lineage the scan did not read is absent, never invented.
 */
export function buildOpenLineage(data: DataReport, options: OpenLineageOptions = {}): OpenLineageExport {
  const byId = new Map(data.datasets.map((dataset) => [dataset.id, dataset]));
  const upstream = new Map<string, OpenLineageDatasetRef[]>();
  const downstream = new Map<string, OpenLineageDatasetRef[]>();
  const push = (map: Map<string, OpenLineageDatasetRef[]>, key: string, value: OpenLineageDatasetRef): void => {
    const list = map.get(key) ?? [];
    list.push(value);
    map.set(key, list);
  };
  for (const edge of data.lineage) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) {
      continue;
    }
    push(upstream, edge.target, refOf(source));
    push(downstream, edge.source, refOf(target));
  }

  const ownership = new Map<string, string>();
  for (const product of data.products) {
    if (!product.owner) {
      continue;
    }
    for (const port of product.outputPorts) {
      if (!ownership.has(port.dataset)) {
        ownership.set(port.dataset, product.owner);
      }
    }
  }

  const datasets = data.datasets.map((dataset) => {
    const facets: Record<string, unknown> = {
      dataSource: { name: dataset.kind, uri: dataset.id },
    };
    if (dataset.columns && dataset.columns.length > 0) {
      facets.schema = {
        fields: dataset.columns.map((column) => ({
          name: column.name,
          type: column.type,
          description: column.required ? 'required' : 'nullable',
        })),
      };
    }
    const owner = ownership.get(dataset.id);
    if (owner) {
      facets.ownership = { owners: [{ name: owner, type: 'team' }] };
    }
    const up = upstream.get(dataset.id);
    const down = downstream.get(dataset.id);
    if (up || down) {
      facets.straboLineage = { upstream: up ?? [], downstream: down ?? [] };
    }
    return { ...refOf(dataset), facets };
  });

  const jobs: OpenLineageExport['jobs'] = [];
  for (const product of data.products) {
    jobs.push({
      namespace: product.repository,
      name: product.name,
      inputs: product.inputPorts
        .map((port) => byId.get(port.dataset))
        .filter((dataset): dataset is DatasetNode => Boolean(dataset))
        .map(refOf),
      outputs: product.outputPorts
        .map((port) => byId.get(port.dataset))
        .filter((dataset): dataset is DatasetNode => Boolean(dataset))
        .map(refOf),
      facets: {
        documentation: { description: `data product ${product.name} (${product.format})` },
        ...(product.owner ? { ownership: { owners: [{ name: product.owner, type: 'team' }] } } : {}),
      },
    });
  }
  for (const flow of data.events) {
    const producers = flow.producers.filter((entry) => byId.has(`${flow.kind}:${flow.topic}`));
    const consumers = flow.consumers.filter((entry) => byId.has(`${flow.kind}:${flow.topic}`));
    if (producers.length === 0 && consumers.length === 0) {
      continue;
    }
    const dataset = byId.get(`${flow.kind}:${flow.topic}`);
    jobs.push({
      namespace: 'event',
      name: `${flow.kind}:${flow.topic}`,
      inputs: dataset ? [refOf(dataset)] : [],
      outputs: dataset ? [refOf(dataset)] : [],
      facets: {
        documentation: { description: `${producers.length} producer(s), ${consumers.length} consumer(s)` },
      },
    });
  }

  return {
    producer: options.producer ?? PRODUCER,
    schemaURL: 'strabo-openlineage-1',
    eventTime: options.now ?? new Date().toISOString(),
    datasets: datasets.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name)),
    jobs: jobs.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name)),
  };
}
