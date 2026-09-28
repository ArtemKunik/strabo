import type {
  DataEdge,
  DatasetNode,
  EventContract,
  EventEndpoint,
  EventFlow,
} from '../../types.ts';

/** The contract node id a payload contract carries when it governs a topic. */
export function eventContractId(topic: string): string {
  return `contract:event/${topic}`;
}

/** The dataset id a topic or queue carries. */
export function topicDatasetId(topic: string, kind: 'topic' | 'queue'): string {
  return `${kind}:${topic}`;
}

/**
 * Join producers and consumers of the same topic across repositories, in the way service flows
 * join an HTTP call to a declared endpoint. A topic one side produces to and another consumes
 * is one flow; a topic with only one side keeps that side as evidence, never as a flow.
 */
export function buildEvents(
  endpoints: readonly EventEndpoint[],
  contracts: readonly EventContract[],
): { datasets: DatasetNode[]; edges: DataEdge[]; flows: EventFlow[]; governs: DataEdge[] } {
  const datasets = new Map<string, DatasetNode>();
  const edges: DataEdge[] = [];
  const governs: DataEdge[] = [];
  const byTopic = new Map<string, EventEndpoint[]>();

  for (const endpoint of endpoints) {
    const id = topicDatasetId(endpoint.topic, endpoint.kind);
    if (!datasets.has(id)) {
      datasets.set(id, {
        id,
        kind: endpoint.kind,
        label: endpoint.topic,
        repository: null,
        strength: 'strong',
      });
    }
    edges.push({
      kind: endpoint.direction === 'produce' ? 'writes' : 'reads',
      source: endpoint.file,
      target: id,
      strength: 'strong',
      evidence: { repository: endpoint.repository, file: endpoint.file, line: endpoint.line },
      detail: endpoint.evidence,
    });
    const key = `${endpoint.kind}\u0000${endpoint.topic}`;
    const list = byTopic.get(key) ?? [];
    list.push(endpoint);
    byTopic.set(key, list);
  }

  for (const contract of contracts) {
    const id = topicDatasetId(contract.topic, 'topic');
    if (!datasets.has(id)) {
      datasets.set(id, {
        id,
        kind: 'topic',
        label: contract.topic,
        repository: contract.repository,
        declared: { repository: contract.repository, file: contract.source },
        columns: contract.fields,
        strength: 'declared',
      });
    }
    governs.push({
      kind: 'governs',
      source: eventContractId(contract.topic),
      target: id,
      strength: 'declared',
      evidence: { repository: contract.repository, file: contract.source, line: 1 },
      detail: `${contract.format} payload`,
    });
  }

  const flows: EventFlow[] = [];
  for (const [key, group] of byTopic) {
    const kind = (key.split('\u0000')[0] ?? 'topic') as 'topic' | 'queue';
    const topic = key.split('\u0000')[1] ?? '';
    const producers = group.filter((entry) => entry.direction === 'produce');
    const consumers = group.filter((entry) => entry.direction === 'consume');
    if (producers.length === 0 && consumers.length === 0) {
      continue;
    }
    const contract = contracts.find((entry) => entry.topic === topic) ?? null;
    flows.push({
      topic,
      kind,
      producers: sortEndpoints(producers),
      consumers: sortEndpoints(consumers),
      contract: contract ? eventContractId(topic) : null,
    });
  }

  return {
    datasets: [...datasets.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.sort(
      (a, b) =>
        a.source.localeCompare(b.source) ||
        a.target.localeCompare(b.target) ||
        (a.evidence?.line ?? 0) - (b.evidence?.line ?? 0),
    ),
    flows: flows.sort((a, b) => a.topic.localeCompare(b.topic)),
    governs: governs.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)),
  };
}

function sortEndpoints(list: EventEndpoint[]): EventEndpoint[] {
  return [...list].sort(
    (a, b) => a.repository.localeCompare(b.repository) || a.file.localeCompare(b.file) || a.line - b.line,
  );
}
