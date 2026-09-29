import type {
  ContractField,
  ContractIdentity,
  DataConformanceFinding,
  DataReport,
  Graph,
} from '../../types.ts';
import { assignUnits, detectUnits } from '../units.ts';

/** How a contract was established: formally declared, or a language-DTO heuristic. */
export type ContractOrigin = 'declared' | 'dto';

/** Formats that count as formally declared (Phase 36 K7: declared beats derived). */
export const DECLARED_CONTRACT_FORMATS = new Set([
  'protobuf',
  'openapi',
  'json-schema',
  'asyncapi',
  'avro',
  'schema-registry',
  'odcs',
  'datacontract',
  'odps',
  'dbt',
]);

/** A contract definition as the boundary lens draws it. */
export interface ContractBoundaryDefinition {
  id: string;
  bareId: string;
  qualifiedId: string;
  format: string;
  origin: ContractOrigin;
  repository: string;
  source: string;
  fields: ContractField[];
  fingerprint: string;
}

export type GovernedEdgeKind = 'data' | 'import' | 'call' | 'service' | 'event';
export type ConformanceStatus = 'conforming' | 'drifting' | 'unverified';

/** A cross-unit / cross-service dependency bound to a declared contract. */
export interface GovernedEdge {
  source: string;
  target: string;
  contract: string;
  contractFormat: string;
  kind: GovernedEdgeKind;
  /** Repository of the source file, when known. */
  repository: string | null;
  /** The shared dataset (data kind) or `topic:<name>` (event kind); null for imports/calls. */
  dataset: string | null;
  /** The recorded units of the endpoints, so consumers read as files *and* units. */
  sourceUnit: string;
  targetUnit: string;
  conformance: ConformanceStatus;
  /** Canvas badge: `📜 Name (format)` for governed, `⚡ Topic (event)` for messages. */
  badge: string;
  evidence: { repository: string; file: string; line?: number; detail: string } | null;
}

/** A cross-unit / cross-service data or call dependency with no governing contract. */
export interface UncontractedBoundary {
  source: string;
  target: string;
  kind: GovernedEdgeKind;
  /** The shared dataset or topic, when the crossing shares one; null otherwise. */
  dataset: string | null;
  sourceUnit: string;
  targetUnit: string;
  reason: string;
  /** Canvas badge: always `⚠️ uncontracted`. */
  badge: string;
  evidence: { repository: string; file: string; line?: number; detail: string } | null;
}

export interface ContractBoundaryInput {
  repositories: ReadonlyArray<{ name: string; root: string; graph: Graph }>;
  data: DataReport;
  /** Override the unit a file belongs to (tests and callers with their own units). */
  unitOf?: (repository: string | null, file: string) => string;
}

export interface ContractBoundaryReport {
  definitions: ContractBoundaryDefinition[];
  governedEdges: GovernedEdge[];
  uncontractedBoundaries: UncontractedBoundary[];
  conformanceDeviations: DataConformanceFinding[];
  /** Declared contracts nothing references: no governs edge, no shared dataset, no event. */
  orphanedContracts: ContractBoundaryDefinition[];
  /** Cross-unit edges that name a contract but carry no recorded data binding. */
  unverifiedEdges: Array<{ source: string; target: string; contract: string; reason: string }>;
  summary: {
    contracts: number;
    declared: number;
    dto: number;
    governed: number;
    uncontracted: number;
    drifting: number;
    orphaned: number;
    unverified: number;
  };
  /** Sections the caller could not compute, named rather than shown empty. */
  unavailable: string[];
}

function originOf(format: string): ContractOrigin {
  return DECLARED_CONTRACT_FORMATS.has(format) ? 'declared' : 'dto';
}

function contractNodeId(id: string): string {
  return `contract:${id}`;
}

function bareOf(identity: ContractIdentity): string {
  return identity.bareId ?? identity.id;
}

/**
 * Build the contract boundary aggregate (Phase 36 K1).
 *
 * A governed edge exists only because a recorded import, call, or data use resolves to a
 * declared contract or schema: a writer and a reader of the same governed dataset in
 * different units, a producer and consumer of a contracted topic, or a cross-unit import
 * whose target is the contract's own definition file. Anything else across units that
 * shares data is an uncontracted boundary; a name match with no recorded binding is
 * `unverified`, never governed.
 */
export function buildContractBoundary(input: ContractBoundaryInput): ContractBoundaryReport {
  const definitions: ContractBoundaryDefinition[] = input.data.contracts.map((identity) => ({
    id: identity.id,
    bareId: bareOf(identity),
    qualifiedId: identity.qualifiedId,
    format: identity.format,
    origin: originOf(identity.format),
    repository: identity.repository,
    source: identity.source,
    fields: identity.fields,
    fingerprint: identity.fingerprint,
  }));

  const unavailable: string[] = [];
  if (definitions.length === 0 && input.data.datasets.length === 0) {
    unavailable.push('no contracts, datasets, or events were recorded, so no boundary was assembled');
  }

  // Dataset -> contracts that govern it (from recorded `governs` edges).
  const governsByDataset = new Map<string, Array<{ contract: ContractIdentity; strength: string }>>();
  const contractById = new Map(input.data.contracts.map((entry) => [entry.id, entry]));
  const contractByNode = new Map(input.data.contracts.map((entry) => [contractNodeId(entry.id), entry]));
  for (const edge of input.data.edges) {
    if (edge.kind !== 'governs') {
      continue;
    }
    const contract = contractByNode.get(edge.source) ?? contractById.get(edge.source);
    if (!contract) {
      continue;
    }
    const list = governsByDataset.get(edge.target) ?? [];
    list.push({ contract, strength: edge.strength });
    governsByDataset.set(edge.target, list);
  }
  // Event payload contracts govern their topic dataset.
  const eventContractByTopic = new Map<string, string>();
  for (const flow of input.data.events) {
    if (flow.contract) {
      eventContractByTopic.set(flow.topic, flow.contract);
    }
  }

  // File -> datasets it writes / reads.
  const writesByFile = new Map<string, Set<string>>();
  const readsByFile = new Map<string, Set<string>>();
  const repoByFile = new Map<string, string>();
  for (const edge of input.data.edges) {
    if ((edge.kind !== 'writes' && edge.kind !== 'reads') || !edge.evidence) {
      continue;
    }
    const target = edge.kind === 'writes' ? writesByFile : readsByFile;
    const list = target.get(edge.source) ?? new Set<string>();
    list.add(edge.target);
    target.set(edge.source, list);
    if (!repoByFile.has(edge.source)) {
      repoByFile.set(edge.source, edge.evidence.repository);
    }
  }

  // Contract -> conformance deviations (missing / type / required).
  const deviationsByContract = new Map<string, DataConformanceFinding[]>();
  for (const finding of input.data.conformance) {
    const list = deviationsByContract.get(finding.contract) ?? [];
    list.push(finding);
    deviationsByContract.set(finding.contract, list);
  }
  const matchesContract = (finding: DataConformanceFinding, identity: ContractIdentity): boolean =>
    finding.contract === identity.id ||
    finding.contract === identity.bareId ||
    finding.contract === identity.qualifiedId;

  const unitOf = input.unitOf ?? buildUnitResolver(input.repositories);
  const contractSourceFiles = new Map<string, ContractIdentity[]>();
  for (const identity of input.data.contracts) {
    const key = `${identity.repository}\u0000${identity.source}`;
    const list = contractSourceFiles.get(key) ?? [];
    list.push(identity);
    contractSourceFiles.set(key, list);
  }

  const governedEdges: GovernedEdge[] = [];
  const uncontracted: UncontractedBoundary[] = [];
  const unverified: ContractBoundaryReport['unverifiedEdges'] = [];
  const seenGoverned = new Set<string>();
  const seenUncontracted = new Set<string>();

  const pushGoverned = (edge: GovernedEdge): void => {
    const key = `${edge.kind}\u0000${edge.source}\u0000${edge.target}\u0000${edge.contract}`;
    if (seenGoverned.has(key)) {
      return;
    }
    seenGoverned.add(key);
    governedEdges.push(edge);
  };
  const pushUncontracted = (edge: UncontractedBoundary): void => {
    const key = `${edge.kind}\u0000${edge.source}\u0000${edge.target}`;
    if (seenUncontracted.has(key)) {
      return;
    }
    seenUncontracted.add(key);
    uncontracted.push(edge);
  };

  const statusOf = (identity: ContractIdentity): ConformanceStatus => {
    const direct = deviationsByContract.get(identity.id) ?? [];
    if (direct.length > 0) {
      return 'drifting';
    }
    for (const finding of input.data.conformance) {
      if (matchesContract(finding, identity)) {
        return 'drifting';
      }
    }
    return 'conforming';
  };

  // (a) Data-shared pairs: a writer and a reader of the same dataset in different
  // units or repositories. Governed when the dataset has a recorded `governs` edge.
  const writersByDataset = invert(writesByFile);
  const readersByDataset = invert(readsByFile);
  const datasets = new Set([...writersByDataset.keys(), ...readersByDataset.keys()]);
  for (const dataset of datasets) {
    const writers = writersByDataset.get(dataset) ?? [];
    const readers = readersByDataset.get(dataset) ?? [];
    const governors = governsByDataset.get(dataset) ?? [];
    for (const writer of writers) {
      for (const reader of readers) {
        if (writer === reader) {
          continue;
        }
        const writerRepo = repoByFile.get(writer) ?? null;
        const readerRepo = repoByFile.get(reader) ?? null;
        if (!crossesBoundary(writer, reader, writerRepo, readerRepo, unitOf)) {
          continue;
        }
        const sourceUnit = unitOf(writerRepo, writer);
        const targetUnit = unitOf(readerRepo, reader);
        if (governors.length > 0) {
          for (const governor of governors) {
            const status: ConformanceStatus =
              governor.strength === 'weak' ? 'unverified' : statusOf(governor.contract);
            pushGoverned({
              source: writer,
              target: reader,
              contract: governor.contract.id,
              contractFormat: governor.contract.format,
              kind: 'data',
              repository: writerRepo,
              dataset,
              sourceUnit,
              targetUnit,
              conformance: status,
              badge: `📜 ${bareOf(governor.contract)} (${governor.contract.format})`,
              evidence: {
                repository: writerRepo ?? readerRepo ?? governor.contract.repository,
                file: writer,
                detail: `shares governed dataset ${dataset} via ${governor.contract.id}`,
              },
            });
          }
        } else {
          pushUncontracted({
            source: writer,
            target: reader,
            kind: 'data',
            dataset,
            sourceUnit,
            targetUnit,
            reason: `shares dataset ${dataset} across units with no governing contract`,
            badge: '⚠️ uncontracted',
            evidence: {
              repository: writerRepo ?? readerRepo ?? '',
              file: writer,
              detail: `writer ${writer} and reader ${reader} share ${dataset}`,
            },
          });
        }
      }
    }
  }

  // (b) Event flows: producers and consumers of one topic across repositories.
  for (const flow of input.data.events) {
    for (const producer of flow.producers) {
      for (const consumer of flow.consumers) {
        if (producer.repository === consumer.repository && producer.file === consumer.file) {
          continue;
        }
        const dataset = `topic:${flow.topic}`;
        const sourceUnit = unitOf(producer.repository, producer.file);
        const targetUnit = unitOf(consumer.repository, consumer.file);
        if (flow.contract) {
          const identity = contractById.get(flow.contract);
          const format = identity?.format ?? 'event';
          const drifting = (deviationsByContract.get(flow.contract) ?? []).length > 0;
          pushGoverned({
            source: producer.file,
            target: consumer.file,
            contract: flow.contract,
            contractFormat: format,
            kind: 'event',
            repository: producer.repository,
            dataset,
            sourceUnit,
            targetUnit,
            conformance: drifting ? 'drifting' : 'conforming',
            badge: `⚡ ${flow.topic} (event)`,
            evidence: {
              repository: producer.repository,
              file: producer.file,
              line: producer.line,
              detail: `publishes ${flow.topic} under ${flow.contract}, consumed at ${consumer.file}:${consumer.line}`,
            },
          });
        } else {
          pushUncontracted({
            source: producer.file,
            target: consumer.file,
            kind: 'event',
            dataset,
            sourceUnit,
            targetUnit,
            reason: `topic ${flow.topic} flows across repositories with no payload contract`,
            badge: '⚠️ uncontracted',
            evidence: {
              repository: producer.repository,
              file: producer.file,
              line: producer.line,
              detail: `publishes ${flow.topic}, consumed at ${consumer.file}:${consumer.line}`,
            },
          });
        }
      }
    }
  }

  // (c) Graph cross-unit imports/calls whose target is a contract definition file.
  for (const repository of input.repositories) {
    for (const edge of repository.graph.edges) {
      if (edge.role === 'declare') {
        continue;
      }
      if (edge.source === edge.target) {
        continue;
      }
      const sourceRepo = repository.name;
      if (!crossesBoundary(edge.source, edge.target, sourceRepo, sourceRepo, unitOf)) {
        continue;
      }
      const contracts = contractSourceFiles.get(`${repository.name}\u0000${edge.target}`);
      if (contracts && contracts.length > 0) {
        for (const contract of contracts) {
          pushGoverned({
            source: edge.source,
            target: edge.target,
            contract: contract.id,
            contractFormat: contract.format,
            kind: edge.kind === 'call' ? 'call' : 'import',
            repository: sourceRepo,
            dataset: null,
            sourceUnit: unitOf(sourceRepo, edge.source),
            targetUnit: unitOf(sourceRepo, edge.target),
            conformance: statusOf(contract),
            badge: `📜 ${bareOf(contract)} (${contract.format})`,
            evidence: {
              repository: sourceRepo,
              file: edge.source,
              line: edge.evidence.line,
              detail: `imports contract definition ${contract.id} via ${edge.evidence.specifier}`,
            },
          });
        }
        continue;
      }
      // A specifier that names a contract without a recorded data binding is
      // `unverified`, never governed: the name alone proves nothing.
      const specifierBase = edge.evidence.specifier.split('/').pop() ?? edge.evidence.specifier;
      const named = definitions.find(
        (definition) =>
          definition.bareId === specifierBase || definition.qualifiedId === edge.evidence.specifier,
      );
      if (named) {
        const key = `${edge.source}\u0000${edge.target}\u0000${named.id}`;
        if (!unverified.some((entry) => `${entry.source}\u0000${entry.target}\u0000${entry.contract}` === key)) {
          unverified.push({
            source: edge.source,
            target: edge.target,
            contract: named.id,
            reason: `names ${named.id} in ${edge.evidence.specifier} with no recorded data binding`,
          });
        }
      }
    }
  }

  // Orphaned contracts: nothing governs through them and no file touches their dataset.
  const governedIds = new Set(governedEdges.map((edge) => edge.contract));
  const touchedLabels = new Set<string>();
  for (const dataset of datasets) {
    touchedLabels.add(dataset.toLowerCase());
  }
  const orphanedContracts = definitions.filter((definition) => {
    if (governedIds.has(definition.id)) {
      return false;
    }
    if (eventContractByTopicHas(definition, input.data)) {
      return false;
    }
    const label = definition.bareId.toLowerCase();
    for (const dataset of datasets) {
      if (dataset.toLowerCase().includes(label) || label.includes(datasetLabel(dataset))) {
        return false;
      }
    }
    void touchedLabels;
    return true;
  });

  const sortedGoverned = governedEdges.sort(
    (a, b) =>
      a.contract.localeCompare(b.contract) || a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
  );
  const sortedUncontracted = uncontracted.sort(
    (a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
  );
  const drifting = new Set<string>();
  for (const edge of sortedGoverned) {
    if (edge.conformance === 'drifting') {
      drifting.add(edge.contract);
    }
  }

  return {
    definitions: [...definitions].sort((a, b) => a.id.localeCompare(b.id) || a.repository.localeCompare(b.repository)),
    governedEdges: sortedGoverned,
    uncontractedBoundaries: sortedUncontracted,
    conformanceDeviations: [...input.data.conformance].sort(
      (a, b) =>
        a.contract.localeCompare(b.contract) || a.field.localeCompare(b.field) || a.kind.localeCompare(b.kind),
    ),
    orphanedContracts: orphanedContracts.sort((a, b) => a.id.localeCompare(b.id)),
    unverifiedEdges: unverified.sort((a, b) => a.contract.localeCompare(b.contract) || a.source.localeCompare(b.source)),
    summary: {
      contracts: definitions.length,
      declared: definitions.filter((definition) => definition.origin === 'declared').length,
      dto: definitions.filter((definition) => definition.origin === 'dto').length,
      governed: sortedGoverned.length,
      uncontracted: sortedUncontracted.length,
      drifting: drifting.size,
      orphaned: orphanedContracts.length,
      unverified: unverified.length,
    },
    unavailable,
  };
}

function eventContractByTopicHas(definition: ContractBoundaryDefinition, data: DataReport): boolean {
  return data.events.some((flow) => flow.contract === definition.id);
}

function datasetLabel(dataset: string): string {
  const tail = dataset.split('/').pop() ?? dataset;
  return tail.toLowerCase();
}

function invert(index: Map<string, Set<string>>): Map<string, string[]> {
  const byDataset = new Map<string, string[]>();
  for (const [file, datasets] of index) {
    for (const dataset of datasets) {
      const list = byDataset.get(dataset) ?? [];
      list.push(file);
      byDataset.set(dataset, list);
    }
  }
  for (const list of byDataset.values()) {
    list.sort();
  }
  return byDataset;
}

function buildUnitResolver(
  repositories: readonly { name: string; root: string; graph: Graph }[],
): (repository: string | null, file: string) => string {
  const assignments = new Map<string, Map<string, string>>();
  for (const repository of repositories) {
    const files = repository.graph.nodes.map((node) => node.id);
    const units = detectUnits(repository.root, files, repository.name);
    assignments.set(repository.name, assignUnits(files, units));
  }
  return (repository, file) => {
    if (repository && assignments.has(repository)) {
      return assignments.get(repository)?.get(file) ?? '.';
    }
    for (const assignment of assignments.values()) {
      const unit = assignment.get(file);
      if (unit) {
        return unit;
      }
    }
    return '.';
  };
}

function crossesBoundary(
  source: string,
  target: string,
  sourceRepo: string | null,
  targetRepo: string | null,
  unitOf: (repository: string | null, file: string) => string,
): boolean {
  if (sourceRepo && targetRepo && sourceRepo !== targetRepo) {
    return true;
  }
  return unitOf(sourceRepo, source) !== unitOf(targetRepo, target);
}

// -------------------------------------------------------------------------------------------
// K4 - Contract change blast radius
// -------------------------------------------------------------------------------------------

export type ContractChangeSeverity = 'breaking' | 'additive' | 'none';

export interface ContractFieldChange {
  kind: 'removed' | 'type-changed' | 'required-changed' | 'added-required' | 'added-optional';
  field: string;
  detail: string;
}

/** Exact field-level changes between two recorded shapes of one contract. */
export function diffContractFields(before: readonly ContractField[], after: readonly ContractField[]): ContractFieldChange[] {
  const beforeByName = new Map(before.map((field) => [field.name, field]));
  const afterByName = new Map(after.map((field) => [field.name, field]));
  const changes: ContractFieldChange[] = [];
  for (const field of before) {
    const next = afterByName.get(field.name);
    if (!next) {
      changes.push({ kind: 'removed', field: field.name, detail: `field ${field.name} was removed` });
      continue;
    }
    if (normaliseType(field.type) !== normaliseType(next.type)) {
      changes.push({
        kind: 'type-changed',
        field: field.name,
        detail: `${field.name} changed type from ${field.type} to ${next.type}`,
      });
    } else if (field.required !== next.required) {
      changes.push({
        kind: 'required-changed',
        field: field.name,
        detail: `${field.name} changed from ${field.required ? 'required' : 'optional'} to ${next.required ? 'required' : 'optional'}`,
      });
    }
  }
  for (const field of after) {
    if (!beforeByName.has(field.name)) {
      changes.push({
        kind: field.required ? 'added-required' : 'added-optional',
        field: field.name,
        detail: `field ${field.name} was added as ${field.required ? 'required' : 'optional'}`,
      });
    }
  }
  return changes.sort((a, b) => a.field.localeCompare(b.field) || a.kind.localeCompare(b.kind));
}

/** Whether a field-level diff breaks downstream consumers. */
export function contractChangeSeverity(changes: readonly ContractFieldChange[]): ContractChangeSeverity {
  if (changes.some((change) => change.kind === 'removed' || change.kind === 'type-changed' || change.kind === 'added-required')) {
    return 'breaking';
  }
  if (changes.length > 0) {
    return 'additive';
  }
  return 'none';
}

export interface ContractImpactInput {
  contract: string;
  before: readonly ContractField[];
  after: readonly ContractField[];
  boundary: ContractBoundaryReport;
  /** Transitive downstream datasets over recorded `derives` edges. */
  downstreamOf?: (dataset: string) => string[];
}

export interface ContractImpact {
  contract: string;
  severity: ContractChangeSeverity;
  changes: ContractFieldChange[];
  /** Direct consumer files bound to the contract through a governed edge. */
  consumers: string[];
  /** Units and repositories those consumers belong to. */
  units: string[];
  repositories: string[];
  /** Downstream datasets reached transitively from the contracted datasets. */
  downstream: string[];
}

/**
 * Trace a contract edit to its blast radius (Phase 36 K4): exact field-level breaking
 * changes plus every direct and transitive downstream consumer file, unit, and repository.
 * Only recorded governed edges are followed; nothing is invented.
 */
export function computeContractImpact(input: ContractImpactInput): ContractImpact {
  const changes = diffContractFields(input.before, input.after);
  const severity = contractChangeSeverity(changes);
  const consumers = new Set<string>();
  const units = new Set<string>();
  const repositories = new Set<string>();
  const contractedDatasets = new Set<string>();
  for (const edge of input.boundary.governedEdges) {
    if (edge.contract !== input.contract) {
      continue;
    }
    consumers.add(edge.source);
    consumers.add(edge.target);
    units.add(edge.sourceUnit);
    units.add(edge.targetUnit);
    if (edge.repository) {
      repositories.add(edge.repository);
    }
    if (edge.dataset) {
      contractedDatasets.add(edge.dataset);
    }
  }
  const downstream = new Set<string>();
  if (input.downstreamOf) {
    for (const dataset of contractedDatasets) {
      for (const next of input.downstreamOf(dataset)) {
        downstream.add(next);
      }
    }
  }
  return {
    contract: input.contract,
    severity,
    changes,
    consumers: [...consumers].sort(),
    units: [...units].sort(),
    repositories: [...repositories].sort(),
    downstream: [...downstream].sort(),
  };
}

// -------------------------------------------------------------------------------------------
// K2 - Data contracts canvas overlay (within the Phase 13 status budget)
// -------------------------------------------------------------------------------------------

export interface ContractOverlayFile {
  file: string;
  /** Node classes to apply; a file takes at most one status ring plus the definition ring. */
  classes: string[];
  reason: string;
}

export interface ContractOverlay {
  files: ContractOverlayFile[];
  summary: {
    definitions: number;
    drifting: number;
    ungoverned: number;
  };
}

/**
 * Node marks for the Data contracts overlay: contract definitions take the neutral accent
 * ring (`ov-contract-def`); drifting implementations ride the serious status double ring
 * (`ov-cycle`/`ov-declared-rule`); ungoverned boundary endpoints take the dashed warning
 * ring (`ov-unreached`/`ov-affected`). Conforming implementations keep the neutral fill.
 */
export function buildContractOverlay(boundary: ContractBoundaryReport): ContractOverlay {
  const marks = new Map<string, ContractOverlayFile>();
  const set = (file: string, classes: string[], reason: string): void => {
    const existing = marks.get(file);
    if (!existing) {
      marks.set(file, { file, classes, reason });
      return;
    }
    // A serious status ring outranks the definition ring; never stack two status rings.
    const serious = ['ov-cycle', 'ov-declared-rule', 'ov-unreached', 'ov-affected'];
    const hasSerious = (classes: string[]): boolean => classes.some((entry) => serious.includes(entry));
    if (hasSerious(classes) && !hasSerious(existing.classes)) {
      marks.set(file, { file, classes: [...existing.classes, ...classes.filter((entry) => !existing.classes.includes(entry))], reason: `${existing.reason}; ${reason}` });
    } else if (!hasSerious(existing.classes)) {
      marks.set(file, { file, classes: [...existing.classes, ...classes.filter((entry) => !existing.classes.includes(entry))], reason: existing.reason });
    }
  };

  for (const definition of boundary.definitions) {
    set(definition.source, ['ov-contract-def'], `defines contract ${definition.id} (${definition.format})`);
  }
  const driftingContracts = new Set(
    boundary.governedEdges.filter((edge) => edge.conformance === 'drifting').map((edge) => edge.contract),
  );
  for (const edge of boundary.governedEdges) {
    if (edge.conformance !== 'drifting') {
      continue;
    }
    const rule = boundary.conformanceDeviations.find((finding) => finding.contract === edge.contract);
    const ruleName = rule ? `naming ${rule.kind} on ${rule.field}` : 'naming the deviation rule';
    set(edge.source, ['ov-cycle'], `drifts from ${edge.contract} ${ruleName}`);
    set(edge.target, ['ov-cycle'], `drifts from ${edge.contract} ${ruleName}`);
  }
  void driftingContracts;
  for (const edge of boundary.uncontractedBoundaries) {
    set(edge.source, ['ov-unreached'], `ungoverned boundary endpoint (${edge.reason})`);
    set(edge.target, ['ov-affected'], `ungoverned boundary endpoint (${edge.reason})`);
  }

  const files = [...marks.values()].sort((a, b) => a.file.localeCompare(b.file));
  return {
    files,
    summary: {
      definitions: boundary.definitions.length,
      drifting: boundary.governedEdges.filter((edge) => edge.conformance === 'drifting').length,
      ungoverned: boundary.uncontractedBoundaries.length,
    },
  };
}

// -------------------------------------------------------------------------------------------
// K5 - Governed boundary plate & view
// -------------------------------------------------------------------------------------------

export interface ContractBoundaryPlate {
  contract: string;
  format: string;
  origin: ContractOrigin;
  producers: string[];
  consumers: string[];
  /** Cross-unit calls that bypass the contract boundary. */
  bypass: UncontractedBoundary[];
}

export interface ContractBoundaryView {
  plates: ContractBoundaryPlate[];
  summary: {
    contracts: number;
    bypassed: number;
  };
}

/**
 * Draw contract interfaces as explicit boundary plates between producer units and consumer
 * units: Producer -> [Contract Interface] -> Consumers. A plate lists the governed
 * producers and consumers plus the uncontracted edges between the same endpoints that
 * bypass the contract.
 */
export function buildBoundaryView(boundary: ContractBoundaryReport): ContractBoundaryView {
  const plates: ContractBoundaryPlate[] = boundary.definitions.map((definition) => {
    const edges = boundary.governedEdges.filter((edge) => edge.contract === definition.id);
    const producers = [...new Set(edges.map((edge) => edge.source))].sort();
    const consumers = [...new Set(edges.map((edge) => edge.target))].sort();
    const endpoints = new Set([...producers, ...consumers]);
    const bypass = boundary.uncontractedBoundaries.filter(
      (edge) => endpoints.has(edge.source) && endpoints.has(edge.target),
    );
    return {
      contract: definition.id,
      format: definition.format,
      origin: definition.origin,
      producers,
      consumers,
      bypass,
    };
  });
  return {
    plates: plates.sort((a, b) => a.contract.localeCompare(b.contract)),
    summary: {
      contracts: plates.length,
      bypassed: plates.filter((plate) => plate.bypass.length > 0).length,
    },
  };
}

function normaliseType(type: string): string {
  return type.toLowerCase().replace(/\s+/g, ' ').trim();
}
