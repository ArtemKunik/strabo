import type {
  DataConformanceFinding,
  DataPort,
  DataProduct,
  DataProductCandidate,
  DataReport,
  DatasetNode,
} from '../../types.ts';

/** One unit of code, as the System view draws it, with the files assigned to it. */
export interface ProductUnit {
  id: string;
  name: string;
  /** The repository the unit belongs to, when known. */
  repository: string | null;
  files: readonly string[];
}

/** A port as the product level draws it: the dataset, its fields, and its contract. */
export interface ProductLevelPort {
  dataset: string;
  label: string;
  fields: string[];
  contract: string | null;
  /** The code files that write (output port) or read (input port) the dataset. */
  files: string[];
}

/** A product drawn above the units that produce its output ports (J11). */
export interface ProductLevelNode {
  id: string;
  name: string;
  format: DataProduct['format'];
  owner: string | null;
  repository: string;
  source: string;
  /** The units whose files write at least one output port; the product spans them. */
  units: string[];
  /** True when the product's producers live in more than one unit. */
  spansUnits: boolean;
  outputPorts: ProductLevelPort[];
  inputPorts: ProductLevelPort[];
  contracts: string[];
  /** Files that read an output port but do not produce it. */
  consumers: string[];
  conformance: DataConformanceFinding[];
  classification: DataProduct['classification'];
}

export type ProductLevelEdgeKind = 'produces' | 'reads' | 'derives';

/** How the product level relates to the code and to other products. */
export interface ProductLevelEdge {
  source: string;
  target: string;
  kind: ProductLevelEdgeKind;
  detail: string;
}

export interface ProductLevel {
  products: ProductLevelNode[];
  candidates: DataProductCandidate[];
  edges: ProductLevelEdge[];
  summary: {
    products: number;
    spanning: number;
    candidates: number;
    conformance: number;
  };
}

/** A file's recorded data footprint, for the data-on-code overlay (J11). */
export interface DataOverlayFile {
  file: string;
  /** Dataset ids the file writes (producer). */
  writes: string[];
  /** Dataset ids the file reads (consumer). */
  reads: string[];
  /** Product ids whose ports the file produces or consumes. */
  products: string[];
}

/** The data-on-code overlay: what every recorded file writes, reads, and feeds (J11). */
export interface DataOverlay {
  files: DataOverlayFile[];
  /** Products as the overlay rings them, with the same marks the Data lens uses. */
  products: ProductLevelNode[];
  summary: {
    files: number;
    products: number;
  };
}

/**
 * Build the data-on-code overlay: for every file, the datasets it writes and reads and the
 * products it produces or consumes. Off by default in the map; this is only the recorded
 * data, so a file that touches no dataset is simply absent rather than drawn as zero.
 */
export function buildDataOverlay(data: DataReport): DataOverlay {
  const writes = new Map<string, Set<string>>();
  const reads = new Map<string, Set<string>>();
  for (const edge of data.edges) {
    if (edge.kind !== 'writes' && edge.kind !== 'reads') {
      continue;
    }
    const target = edge.kind === 'writes' ? writes : reads;
    const list = target.get(edge.source) ?? new Set<string>();
    list.add(edge.target);
    target.set(edge.source, list);
  }

  const products = buildProductLevel(data, []).products;
  const productsByDataset = new Map<string, Set<string>>();
  for (const product of products) {
    for (const port of [...product.outputPorts, ...product.inputPorts]) {
      const list = productsByDataset.get(port.dataset) ?? new Set<string>();
      list.add(product.id);
      productsByDataset.set(port.dataset, list);
    }
  }

  const files = [...new Set([...writes.keys(), ...reads.keys()])].sort();
  const overlayFiles: DataOverlayFile[] = files.map((file) => {
    const written = [...(writes.get(file) ?? [])].sort();
    const read = [...(reads.get(file) ?? [])].sort();
    const productIds = new Set<string>();
    for (const dataset of [...written, ...read]) {
      for (const id of productsByDataset.get(dataset) ?? []) {
        productIds.add(id);
      }
    }
    return { file, writes: written, reads: read, products: [...productIds].sort() };
  });

  return {
    files: overlayFiles,
    products,
    summary: { files: overlayFiles.length, products: products.length },
  };
}

/** The empty level, so a System view with no data analysis still reports a products level. */
export function emptyProductLevel(): ProductLevel {
  return {
    products: [],
    candidates: [],
    edges: [],
    summary: { products: 0, spanning: 0, candidates: 0, conformance: 0 },
  };
}

/**
 * Draw declared data products as a level above the units of code (J11).
 *
 * A product sits above the units whose files write its output ports, and a product whose
 * producers live in more than one unit draws across them rather than being forced into one.
 * Only recorded facts are used: a producer is a `writes` edge, a consumer a `reads` edge, and
 * a product-to-product edge is a recorded lineage edge between two products' ports.
 */
export function buildProductLevel(data: DataReport, units: readonly ProductUnit[]): ProductLevel {
  const unitByFile = new Map<string, ProductUnit>();
  for (const unit of units) {
    for (const file of unit.files) {
      unitByFile.set(file, unit);
    }
  }

  const writersByDataset = new Map<string, string[]>();
  const readersByDataset = new Map<string, string[]>();
  for (const edge of data.edges) {
    if (edge.kind === 'writes') {
      const list = writersByDataset.get(edge.target) ?? [];
      list.push(edge.source);
      writersByDataset.set(edge.target, list);
    } else if (edge.kind === 'reads') {
      const list = readersByDataset.get(edge.target) ?? [];
      list.push(edge.source);
      readersByDataset.set(edge.target, list);
    }
  }

  const datasetById = new Map(data.datasets.map((dataset) => [dataset.id, dataset]));
  const contractByPort = new Map<string, string>();
  for (const product of data.products) {
    for (const contract of product.contracts) {
      for (const port of [...product.outputPorts, ...product.inputPorts]) {
        contractByPort.set(`${product.id}\u0000${port.dataset}`, contract);
      }
    }
  }

  const portOf = (port: DataPort, product: DataProduct): ProductLevelPort => {
    const dataset: DatasetNode | undefined = datasetById.get(port.dataset);
    const fields = (port.schema ?? dataset?.columns ?? []).map((field) => field.name);
    const files = [
      ...(writersByDataset.get(port.dataset) ?? []),
      ...(readersByDataset.get(port.dataset) ?? []),
    ];
    return {
      dataset: port.dataset,
      label: dataset?.label ?? port.dataset,
      fields,
      contract: contractByPort.get(`${product.id}\u0000${port.dataset}`) ?? null,
      files: [...new Set(files)].sort(),
    };
  };

  const products: ProductLevelNode[] = data.products
    .map((product) => {
      const outputPorts = product.outputPorts.map((port) => portOf(port, product));
      const inputPorts = product.inputPorts.map((port) => portOf(port, product));
      const producerFiles = new Set(outputPorts.flatMap((port) => port.files));
      const producerUnits = new Set<string>();
      for (const file of producerFiles) {
        const unit = unitByFile.get(file);
        if (unit) {
          producerUnits.add(unit.id);
        }
      }
      const outputDatasets = new Set(outputPorts.map((port) => port.dataset));
      const consumers = new Set<string>();
      for (const dataset of outputDatasets) {
        for (const reader of readersByDataset.get(dataset) ?? []) {
          if (!producerFiles.has(reader)) {
            consumers.add(reader);
          }
        }
      }
      return {
        id: product.id,
        name: product.name,
        format: product.format,
        owner: product.owner,
        repository: product.repository,
        source: product.source,
        units: [...producerUnits].sort(),
        spansUnits: producerUnits.size > 1,
        outputPorts,
        inputPorts,
        contracts: [...product.contracts],
        consumers: [...consumers].sort(),
        conformance: data.conformance.filter((finding) => finding.contract === product.id),
        classification: product.classification,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  const productByDataset = new Map<string, string>();
  for (const product of products) {
    for (const port of [...product.outputPorts, ...product.inputPorts]) {
      if (!productByDataset.has(port.dataset)) {
        productByDataset.set(port.dataset, product.id);
      }
    }
  }

  const edges: ProductLevelEdge[] = [];
  for (const product of products) {
    for (const unit of product.units) {
      edges.push({
        source: product.id,
        target: unit,
        kind: 'produces',
        detail: `unit ${unit} writes a port of ${product.name}`,
      });
    }
  }
  for (const edge of data.lineage) {
    const source = productByDataset.get(edge.source);
    const target = productByDataset.get(edge.target);
    if (!source || !target || source === target) {
      continue;
    }
    edges.push({
      source,
      target,
      kind: 'derives',
      detail: `${edge.detail} (${edge.evidence.file}${edge.evidence.line ? `:${edge.evidence.line}` : ''})`,
    });
  }

  return {
    products,
    candidates: data.candidates,
    edges: edges.sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
    ),
    summary: {
      products: products.length,
      spanning: products.filter((product) => product.spansUnits).length,
      candidates: data.candidates.length,
      conformance: data.conformance.length,
    },
  };
}
