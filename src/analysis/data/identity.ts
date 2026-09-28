import { createHash } from 'node:crypto';
import path from 'node:path';

import type { ContractDefinition, ContractIdentity, ContractField } from '../../types.ts';

/** A contract id's last path/segment, used as the weak bare-name fallback. */
export function bareNameOf(id: string): string {
  const tail = id.split(/[#./\\]/).filter(Boolean).pop();
  return tail ?? id;
}

/** The directory part of a source path, posix and `.` when the file sits at the root. */
function sourceDir(source: string): string {
  const dir = path.posix.dirname(source.replaceAll('\\', '/'));
  return dir === '.' || dir === '' ? '.' : dir;
}

/**
 * The qualified id a format allows (J3).
 *
 * Protobuf already carries `package.Message`; OpenAPI becomes
 * `document#/components/schemas/Name`; a JSON Schema keeps its `$id` when one is present;
 * a language DTO is namespaced by its source directory plus its type name. The bare-name id
 * stays available beside it, so A13 matching keeps working and the two schemes are never merged.
 */
export function qualifiedIdOf(contract: ContractDefinition): string {
  if (contract.format === 'protobuf') {
    return contract.id;
  }
  if (contract.format === 'openapi') {
    const [document, name] = contract.id.split('#');
    return name ? `${document}#/components/schemas/${name}` : contract.id;
  }
  if (contract.format === 'json-schema') {
    // A declared `$id` is already a URI or a path; only a bare name gets a namespace.
    return /[./\\]/.test(contract.id) ? contract.id : `${sourceDir(contract.source)}/${contract.id}`;
  }
  return `${sourceDir(contract.source)}/${contract.id}`;
}

/** A stable hash of a contract's normalised fields, so a copied shape is one fingerprint. */
export function shapeFingerprint(fields: readonly ContractField[]): string {
  const normalised = fields
    .map((field) => `${field.name}:${field.type}:${field.required ? '1' : '0'}`)
    .sort()
    .join('|');
  return createHash('sha1').update(normalised).digest('hex').slice(0, 16);
}

/** The identity record for one contract under the chosen scheme. */
export function identifyContract(contract: ContractDefinition, qualified: boolean): ContractIdentity {
  const qualifiedId = qualifiedIdOf(contract);
  const bareId = bareNameOf(contract.id);
  return {
    id: qualified ? qualifiedId : contract.id,
    bareId,
    qualifiedId,
    format: contract.format,
    repository: contract.repository,
    source: contract.source,
    fingerprint: shapeFingerprint(contract.fields),
    fields: contract.fields,
  };
}

/** Contracts that share a shape fingerprint but not an id: a recorded fact, not a defect. */
export function shapeTwins(
  identities: readonly ContractIdentity[],
): Array<{ fingerprint: string; contracts: string[] }> {
  const byFingerprint = new Map<string, Set<string>>();
  for (const identity of identities) {
    const set = byFingerprint.get(identity.fingerprint) ?? new Set<string>();
    set.add(identity.qualifiedId);
    byFingerprint.set(identity.fingerprint, set);
  }
  const twins: Array<{ fingerprint: string; contracts: string[] }> = [];
  for (const [fingerprint, contracts] of byFingerprint) {
    if (contracts.size > 1) {
      twins.push({ fingerprint, contracts: [...contracts].sort() });
    }
  }
  return twins.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

/** Identify every contract in the workspace under the selected scheme. */
export function identifyContracts(
  contracts: readonly ContractDefinition[],
  qualified: boolean,
): ContractIdentity[] {
  return contracts
    .map((contract) => identifyContract(contract, qualified))
    .sort(
      (a, b) =>
        a.id.localeCompare(b.id) || a.repository.localeCompare(b.repository) || a.source.localeCompare(b.source),
    );
}
