import type {
  ContractField,
  ContractIdentity,
  DataConformanceFinding,
  DataPort,
  DataProduct,
  DatasetNode,
} from '../../types.ts';

export interface ConformanceInput {
  products: readonly DataProduct[];
  contracts: readonly ContractIdentity[];
  /** Resolve a declared port/dataset name to the dataset the scan recorded, or null. */
  resolveDataset: (name: string) => DatasetNode | null;
  /**
   * The columns the implementation records for a dataset, from a source other than the
   * contract being checked. Null when the shape was not recorded, so nothing is claimed.
   */
  implementationColumns: (datasetId: string) => ContractField[] | null;
}

/**
 * Check a declared contract against what the code and schema actually do (J7).
 *
 * A declared field is compared with its recorded column for a field that is missing, a type
 * that differs, and required-versus-nullable. The finding keeps the deviation shape of Phase 11
 * (`missing` / `type` / `required`) with evidence on both sides. A dataset whose shape was not
 * recorded produces no finding: an unrecorded shape is not a mismatch.
 */
export function buildConformance(input: ConformanceInput): DataConformanceFinding[] {
  const findings: DataConformanceFinding[] = [];

  for (const product of input.products) {
    for (const port of [...product.outputPorts, ...product.inputPorts]) {
      if (!port.schema || port.schema.length === 0) {
        continue;
      }
      const dataset = input.resolveDataset(port.dataset);
      if (!dataset) {
        continue;
      }
      const implemented = input.implementationColumns(dataset.id);
      if (!implemented) {
        continue;
      }
      findings.push(
        ...diffFields(
          product.id,
          dataset.id,
          product.repository,
          port.schema,
          implemented,
          { file: product.source },
        ),
      );
    }
  }

  for (const contract of input.contracts) {
    if (contract.fields.length === 0) {
      continue;
    }
    const dataset = input.resolveDataset(contract.bareId) ?? input.resolveDataset(contract.qualifiedId);
    if (!dataset) {
      continue;
    }
    const implemented = input.implementationColumns(dataset.id);
    if (!implemented) {
      continue;
    }
    findings.push(
      ...diffFields(
        contract.id,
        dataset.id,
        contract.repository,
        contract.fields,
        implemented,
        { file: contract.source },
      ),
    );
  }

  return dedupe(findings);
}

function diffFields(
  contract: string,
  dataset: string,
  repository: string,
  declared: readonly ContractField[],
  implemented: readonly ContractField[],
  contractEvidence: { file: string; line?: number },
): DataConformanceFinding[] {
  const byName = new Map(implemented.map((field) => [field.name, field]));
  const findings: DataConformanceFinding[] = [];
  for (const field of declared) {
    const actual = byName.get(field.name);
    if (!actual) {
      findings.push({
        contract,
        dataset,
        repository,
        kind: 'missing',
        field: field.name,
        detail: `declared field ${field.name} is not recorded on the implementation`,
        contractEvidence,
      });
      continue;
    }
    // An implementation whose type was not read proves presence only; type and required-ness
    // are not compared against an unknown, so a mismatch is never invented.
    if (actual.type !== 'unknown' && normalise(field.type) !== normalise(actual.type)) {
      findings.push({
        contract,
        dataset,
        repository,
        kind: 'type',
        field: field.name,
        detail: `${field.name} is declared ${field.type} but recorded ${actual.type}`,
        contractEvidence,
      });
    } else if (actual.type !== 'unknown' && field.required !== actual.required) {
      findings.push({
        contract,
        dataset,
        repository,
        kind: 'required',
        field: field.name,
        detail: `${field.name} is declared ${field.required ? 'required' : 'optional'} but recorded ${actual.required ? 'required' : 'nullable'}`,
        contractEvidence,
      });
    }
  }
  return findings;
}

/** Types compare case- and space-insensitively, the way the schema reader normalises them. */
function normalise(type: string): string {
  return type.toLowerCase().replace(/\s+/g, ' ').trim();
}

function dedupe(findings: DataConformanceFinding[]): DataConformanceFinding[] {
  const seen = new Set<string>();
  const result: DataConformanceFinding[] = [];
  for (const finding of findings.sort(
    (a, b) =>
      a.repository.localeCompare(b.repository) ||
      a.contract.localeCompare(b.contract) ||
      (a.dataset ?? '').localeCompare(b.dataset ?? '') ||
      a.field.localeCompare(b.field) ||
      a.kind.localeCompare(b.kind),
  )) {
    const key = `${finding.repository}\u0000${finding.contract}\u0000${finding.dataset ?? ''}\u0000${finding.field}\u0000${finding.kind}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(finding);
  }
  return result;
}

/** The declared schema of a product port, for a surface that wants it without re-reading. */
export function portSchema(port: DataPort): ContractField[] {
  return port.schema ?? [];
}
