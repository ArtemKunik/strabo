import type {
  DataEdge,
  DataProduct,
  DataProductCandidate,
  LineageEdge,
} from '../../types.ts';

export interface DataImpactInput {
  /** Files in the pending change set (Phase 17 Q8), repository-relative. */
  changedFiles: readonly string[];
  edges: readonly DataEdge[];
  products: readonly DataProduct[];
  candidates: readonly DataProductCandidate[];
  governedBy: ReadonlyMap<string, string[]>;
  lineage: readonly LineageEdge[];
  /** The unit a file belongs to, so a consumer is named by repository and unit. */
  unitOf?: (repository: string, file: string) => string;
  /** Datasets a schema/compat diff marks as changed, when the caller computed one. */
  schemaChanges?: ReadonlyArray<{ dataset: string; severity: 'breaking' | 'conditional' | 'safe'; detail: string }>;
}

/** A data change and the downstream it can reach, with the recorded evidence. */
export interface DataImpactFinding {
  dataset: string;
  severity: 'critical' | 'high' | 'moderate';
  reason: string;
  /** Products whose output port is the dataset. */
  products: string[];
  /** Contracts that govern the dataset. */
  governedBy: string[];
  /** Recorded readers of the dataset, downstream of the change. */
  consumers: Array<{ repository: string; unit: string; file: string; line: number }>;
  /** Downstream datasets reached over recorded `derives` edges. */
  downstream: string[];
}

/**
 * Data change impact (J9): a schema change on a dataset is more severe when the dataset is a
 * data product's output port or is governed by a contract. A pending change that edits a writer
 * of a shared dataset names the downstream consumers.
 */
export function computeDataImpact(input: DataImpactInput): DataImpactFinding[] {
  const touched = new Set<string>();
  const changed = new Set(input.changedFiles);
  for (const edge of input.edges) {
    if (edge.kind === 'writes' && changed.has(edge.source)) {
      touched.add(edge.target);
    }
  }
  for (const change of input.schemaChanges ?? []) {
    touched.add(change.dataset);
  }

  const productPorts = new Map<string, string[]>();
  for (const product of input.products) {
    for (const port of product.outputPorts) {
      const list = productPorts.get(port.dataset) ?? [];
      list.push(product.name);
      productPorts.set(port.dataset, list);
    }
  }
  const candidatePorts = new Set(
    input.candidates.filter((candidate) => candidate.kind === 'output-port' || candidate.kind === 'no-single-writer').map((candidate) => candidate.dataset),
  );
  const readers = new Map<string, DataImpactFinding['consumers']>();
  for (const edge of input.edges) {
    if (edge.kind !== 'reads' || !edge.evidence) {
      continue;
    }
    const list = readers.get(edge.target) ?? [];
    list.push({
      repository: edge.evidence.repository,
      unit: input.unitOf?.(edge.evidence.repository, edge.source) ?? edge.evidence.repository,
      file: edge.source,
      line: edge.evidence.line,
    });
    readers.set(edge.target, list);
  }
  const downstreamOf = new Map<string, string[]>();
  for (const edge of input.lineage) {
    const list = downstreamOf.get(edge.source) ?? [];
    list.push(edge.target);
    downstreamOf.set(edge.source, list);
  }

  const findings: DataImpactFinding[] = [];
  for (const dataset of [...touched].sort()) {
    const schemaChange = (input.schemaChanges ?? []).find((entry) => entry.dataset === dataset);
    const products = productPorts.get(dataset) ?? [];
    const contracts = input.governedBy.get(dataset) ?? [];
    const isPort = products.length > 0 || candidatePorts.has(dataset);
    const severity: DataImpactFinding['severity'] =
      schemaChange?.severity === 'breaking' && isPort
        ? 'critical'
        : schemaChange?.severity === 'breaking' && contracts.length > 0
          ? 'high'
          : isPort || contracts.length > 0
            ? 'high'
            : 'moderate';
    const reason = schemaChange
      ? `${schemaChange.severity} schema change: ${schemaChange.detail}`
      : touchedByChange(dataset, input.edges, changed)
        ? 'a changed file writes this dataset'
        : 'recorded as a data change';
    findings.push({
      dataset,
      severity,
      reason,
      products,
      governedBy: contracts,
      consumers: dedupe(readers.get(dataset) ?? []),
      downstream: reachable(dataset, downstreamOf),
    });
  }
  return findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.dataset.localeCompare(b.dataset));
}

function touchedByChange(dataset: string, edges: readonly DataEdge[], changed: Set<string>): boolean {
  return edges.some((edge) => edge.kind === 'writes' && edge.target === dataset && changed.has(edge.source));
}

function reachable(dataset: string, downstreamOf: Map<string, string[]>): string[] {
  const seen = new Set<string>();
  const stack = [...(downstreamOf.get(dataset) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (seen.has(next)) {
      continue;
    }
    seen.add(next);
    stack.push(...(downstreamOf.get(next) ?? []));
  }
  return [...seen].sort();
}

function severityRank(severity: DataImpactFinding['severity']): number {
  return severity === 'critical' ? 0 : severity === 'high' ? 1 : 2;
}

function dedupe(list: DataImpactFinding['consumers']): DataImpactFinding['consumers'] {
  const seen = new Set<string>();
  return list
    .sort((a, b) => a.repository.localeCompare(b.repository) || a.file.localeCompare(b.file) || a.line - b.line)
    .filter((entry) => {
      const key = `${entry.repository}\u0000${entry.file}\u0000${entry.line}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}
