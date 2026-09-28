import fs from 'node:fs';
import path from 'node:path';

import { toPosix } from '../boundary/repository-root.ts';
import { excludedDirectory } from '../scan/exclusions.ts';
import type { CatalogDeclaration } from '../types.ts';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 500;

/**
 * Read exported catalog snapshots as declarations (J13).
 *
 * DataHub, OpenMetadata, and Unity Catalog JSON exports are supported. A snapshot is read as a
 * declaration: its owners, domains, product groupings, classifications, and lineage are facts
 * the catalog states, labelled with their source and export date. Strabo never connects to a
 * catalog, and a catalog fact is shown beside the recorded facts, never merged into them.
 */
export function extractCatalogDeclarations(
  root: string,
  repository: string,
  extraFiles: readonly string[] = [],
): CatalogDeclaration[] {
  const declarations: CatalogDeclaration[] = [];
  const candidates = [...findJsonFiles(root).slice(0, MAX_FILES), ...extraFiles];
  for (const file of candidates) {
    const content = readText(root, file);
    if (content === null) {
      continue;
    }
    let document: unknown;
    try {
      document = JSON.parse(content);
    } catch {
      continue;
    }
    declarations.push(...readCatalog(repository, file, document));
  }
  return declarations.sort((a, b) => a.repository.localeCompare(b.repository) || a.dataset.localeCompare(b.dataset));
}

function readCatalog(repository: string, file: string, document: unknown): CatalogDeclaration[] {
  if (!isRecord(document)) {
    return [];
  }
  const exportedAt = stringOf(document.exportedAt) ?? stringOf(document.generatedAt) ?? stringOf(document.asOf);
  if (Array.isArray(document.entities)) {
    return document.entities.filter(isRecord).map((entity) => datahubEntity(repository, file, exportedAt, entity));
  }
  if (Array.isArray(document.tables)) {
    return document.tables.filter(isRecord).map((table) => unityOrOpenMetadata(repository, file, exportedAt, table));
  }
  return [];
}

function datahubEntity(
  repository: string,
  file: string,
  exportedAt: string | null,
  entity: Record<string, unknown>,
): CatalogDeclaration {
  const urn = stringOf(entity.urn) ?? stringOf(entity.name) ?? 'unknown';
  // A DataHub dataset urn is `urn:li:dataset:(platform,datasetName,env)`; the name is the
  // middle part. A non-urn id keeps its last segment.
  const parenthesised = /\(([^)]*)\)/.exec(urn);
  const parts = parenthesised ? parenthesised[1]?.split(',').map((part) => part.trim()) ?? [] : [];
  const dataset = parts.length >= 2 ? (parts[1] as string) : (urn.split(/[.:]/).filter(Boolean).pop() ?? urn);
  const owners = isRecord(entity.ownership) ? entity.ownership.owners : undefined;
  const owner = Array.isArray(owners)
    ? ownerName(owners.map((entry) => (isRecord(entry) ? entry.owner : entry)).find(Boolean))
    : null;
  const domain = isRecord(entity.domain) ? stringOf(entity.domain.urn) : stringOf(entity.domain);
  const classification = readTags(entity.tags ?? entity.glossaryTerms);
  return {
    catalog: 'datahub',
    repository,
    source: file,
    exportedAt,
    dataset,
    owner,
    domain: domain ? domain.split(/[,:]/).filter(Boolean).pop() ?? domain : null,
    classification,
    observed: false,
    detail: `catalog entity ${urn}`,
  };
}

function unityOrOpenMetadata(
  repository: string,
  file: string,
  exportedAt: string | null,
  table: Record<string, unknown>,
): CatalogDeclaration {
  const name = stringOf(table.name) ?? stringOf(table.fullyQualifiedName) ?? stringOf(table.id) ?? 'unknown';
  const parts = [stringOf(table.catalog_name), stringOf(table.schema_name), name].filter((entry): entry is string => entry !== null);
  const dataset = parts.join('.');
  const owner = stringOf(table.owner) ?? (Array.isArray(table.owners) ? ownerName(table.owners[0]) : null);
  const domain = stringOf(table.domain) ?? (isRecord(table.domain) ? stringOf(table.domain.name) : null);
  const classification = readTags(table.tags ?? table.columns);
  const catalog = stringOf(table.catalog_name) ? 'unity' : 'openmetadata';
  return {
    catalog,
    repository,
    source: file,
    exportedAt,
    dataset,
    owner,
    domain,
    classification,
    observed: false,
    detail: `catalog table ${dataset}`,
  };
}

function readTags(value: unknown): Array<{ field: string | null; tag: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  const tags: Array<{ field: string | null; tag: string }> = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      tags.push({ field: null, tag: entry });
    } else if (isRecord(entry)) {
      const tag = stringOf(entry.tag) ?? stringOf(entry.name) ?? stringOf(entry.tagname);
      if (tag) {
        tags.push({ field: stringOf(entry.field) ?? stringOf(entry.column), tag });
      }
    }
  }
  return tags;
}

function ownerName(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (isRecord(value)) {
    return stringOf(value.name) ?? stringOf(value.email) ?? stringOf(value.urn);
  }
  return null;
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findJsonFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > 6) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      const relative = toPosix(path.relative(root, absolute));
      if (entry.isDirectory()) {
        if (!excludedDirectory(relative)) {
          walk(absolute, depth + 1);
        }
        continue;
      }
      if (/catalog|lineage|metadata|datahub|openmetadata|unity/i.test(entry.name) && entry.name.toLowerCase().endsWith('.json')) {
        found.push(relative);
      }
    }
  };
  walk(root, 0);
  return found.sort();
}

function readText(root: string, file: string): string | null {
  try {
    const absolute = path.join(root, file);
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_BYTES) {
      return null;
    }
    const content = fs.readFileSync(absolute);
    return content.includes(0) ? null : content.toString('utf8');
  } catch {
    return null;
  }
}
