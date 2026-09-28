import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { ContractField, DataPort, DataProduct } from '../types.ts';
import { findContractFiles } from './contracts.ts';

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Read the descriptors teams already write, as declarations of data products (J5).
 *
 * Supported: Open Data Contract Standard (ODCS), the Data Contract Specification, the Open
 * Data Product Standard, dbt `schema.yml`, and a `products:` key in `strabo.groups.yml`. A
 * descriptor that is present but cannot be read is listed as a gap on a product-shaped result,
 * never silently dropped. Classification comes only from a declaration, never a column name.
 */
export function extractDeclaredProducts(root: string, repository: string): DataProduct[] {
  const products: DataProduct[] = [];
  const seen = new Set<string>();
  for (const file of findContractFiles(root)) {
    if (!/\.(?:ya?ml|json)$/i.test(file)) {
      continue;
    }
    const content = readText(root, file);
    if (content === null) {
      continue;
    }
    let document: unknown;
    try {
      document = file.endsWith('.json') ? JSON.parse(content) : parseYaml(content);
    } catch {
      continue;
    }
    for (const product of readDescriptor(repository, file, document)) {
      if (seen.has(product.id)) {
        continue;
      }
      seen.add(product.id);
      products.push(product);
    }
  }
  for (const product of readGroupsProducts(root, repository)) {
    if (!seen.has(product.id)) {
      seen.add(product.id);
      products.push(product);
    }
  }
  return products.sort((a, b) => a.id.localeCompare(b.id));
}

/** One descriptor file, by the signature keys it carries. */
function readDescriptor(repository: string, file: string, document: unknown): DataProduct[] {
  if (!isRecord(document)) {
    return [];
  }
  if (isRecord(document.product) || document.kind === 'DataProduct') {
    return [readOdps(repository, file, document)];
  }
  if (typeof document.dataContractSpecification === 'string' || (document.kind === 'DataContract' && document.apiVersion)) {
    return [readDataContract(repository, file, document)];
  }
  if (Array.isArray(document.models) || Array.isArray(document.sources) || Array.isArray(document.exposures)) {
    return readDbtSchema(repository, file, document);
  }
  return [];
}

function readOdps(repository: string, file: string, document: Record<string, unknown>): DataProduct {
  const product = isRecord(document.product) ? document.product : document;
  const name = stringOf(product.name) ?? stringOf(document.name) ?? path.posix.basename(file);
  const owner = ownerOf(product.owner) ?? ownerOf(document.owner);
  const ports = isRecord(product.ports) ? product.ports : isRecord(document.ports) ? document.ports : {};
  const outputPorts = readPorts(ports.outputPorts ?? ports.output);
  const inputPorts = readPorts(ports.inputPorts ?? ports.input);
  return baseProduct(repository, file, 'odps', name, owner, outputPorts, inputPorts);
}

function readDataContract(repository: string, file: string, document: Record<string, unknown>): DataProduct {
  const info = isRecord(document.info) ? document.info : {};
  const name =
    stringOf(document.name) ?? stringOf(info.title) ?? stringOf(document.id) ?? path.posix.basename(file);
  const owner = ownerOf(document.owner) ?? ownerOf(isRecord(document.team) ? document.team.name : undefined);
  const schema = Array.isArray(document.schema) ? document.schema : [];
  const outputPorts: DataPort[] = [];
  const classification: DataProduct['classification'] = [];
  for (const entry of schema) {
    if (!isRecord(entry)) {
      continue;
    }
    const dataset = stringOf(entry.name) ?? stringOf(entry.physicalName);
    const fields = readFields(entry.properties);
    if (!dataset) {
      continue;
    }
    outputPorts.push({ dataset, ...(fields.length > 0 ? { schema: fields } : {}), evidence: { file } });
    classification.push(...classificationsOf(entry.properties, file));
  }
  const format: DataProduct['format'] = typeof document.dataContractSpecification === 'string' ? 'datacontract' : 'odcs';
  return { ...baseProduct(repository, file, format, name, owner, outputPorts, []), classification };
}

function readDbtSchema(repository: string, file: string, document: Record<string, unknown>): DataProduct[] {
  const models = Array.isArray(document.models) ? document.models : [];
  const products: DataProduct[] = [];
  for (const model of models) {
    if (!isRecord(model) || typeof model.name !== 'string') {
      continue;
    }
    const meta = isRecord(model.meta) ? model.meta : isRecord(model.config) && isRecord(model.config.meta) ? model.config.meta : {};
    const contract = isRecord(model.contract) ? model.contract : isRecord(model.config) && isRecord(model.config.contract) ? model.config.contract : {};
    const owner = ownerOf(meta.owner) ?? ownerOf(model.owner);
    const fields = readFields(model.columns);
    const enforced = contract.enforced === true;
    products.push({
      id: `dbt:${repository}:${model.name}`,
      name: model.name,
      format: 'dbt',
      repository,
      source: file,
      owner,
      outputPorts: [{ dataset: model.name, ...(fields.length > 0 ? { schema: fields } : {}), evidence: { file } }],
      inputPorts: [],
      contracts: enforced ? [`dbt:${model.name}`] : [],
      classification: classificationsOf(model.columns, file),
      ...(enforced ? { serviceLevel: 'contract enforced' } : {}),
    });
  }
  if (products.length === 0) {
    products.push({
      id: `dbt:${repository}:${path.posix.basename(file)}`,
      name: path.posix.basename(file),
      format: 'dbt',
      repository,
      source: file,
      owner: null,
      outputPorts: [],
      inputPorts: [],
      contracts: [],
      classification: [],
      gaps: [{ file, reason: 'a dbt schema with no readable models' }],
    });
  }
  return products;
}

/** `products:` in strabo.groups.yml: `{ name, owner, outputs: [dataset], inputs: [dataset] }`. */
function readGroupsProducts(root: string, repository: string): DataProduct[] {
  const file = 'strabo.groups.yml';
  const content = readText(root, file);
  if (content === null) {
    return [];
  }
  let document: unknown;
  try {
    document = parseYaml(content);
  } catch {
    return [];
  }
  if (!isRecord(document) || !Array.isArray(document.products)) {
    return [];
  }
  const products: DataProduct[] = [];
  for (const entry of document.products) {
    if (!isRecord(entry)) {
      continue;
    }
    const name = stringOf(entry.name);
    if (!name) {
      continue;
    }
    products.push({
      id: `strabo:${repository}:${name}`,
      name,
      format: 'strabo-groups',
      repository,
      source: file,
      owner: ownerOf(entry.owner),
      outputPorts: readPorts(entry.outputs),
      inputPorts: readPorts(entry.inputs),
      contracts: Array.isArray(entry.contracts) ? entry.contracts.filter((value): value is string => typeof value === 'string') : [],
      classification: Array.isArray(entry.classification)
        ? entry.classification
            .filter(isRecord)
            .map((tag) => ({ field: stringOf(tag.field) ?? '', tag: stringOf(tag.tag) ?? '', source: file }))
            .filter((tag) => tag.tag !== '')
        : [],
    });
  }
  return products;
}

function baseProduct(
  repository: string,
  file: string,
  format: DataProduct['format'],
  name: string,
  owner: string | null,
  outputPorts: DataPort[],
  inputPorts: DataPort[],
): DataProduct {
  return {
    id: `${format}:${repository}:${name}`,
    name,
    format,
    repository,
    source: file,
    owner,
    outputPorts,
    inputPorts,
    contracts: [],
    classification: [],
  };
}

function readPorts(value: unknown): DataPort[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ports: DataPort[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim() !== '') {
      ports.push({ dataset: entry.trim() });
      continue;
    }
    if (!isRecord(entry)) {
      continue;
    }
    const dataset = stringOf(entry.name) ?? stringOf(entry.dataset) ?? stringOf(entry.dataProduct);
    if (!dataset) {
      continue;
    }
    const fields = readFields(entry.fields ?? entry.columns ?? entry.schema);
    ports.push({ dataset, ...(fields.length > 0 ? { schema: fields } : {}) });
  }
  return ports;
}

function readFields(value: unknown): ContractField[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const fields: ContractField[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== 'string') {
      continue;
    }
    const type = stringOf(entry.data_type) ?? stringOf(entry.type) ?? 'unknown';
    const required = entry.required === true || entry.nullable === false;
    fields.push({ name: entry.name, type, required });
  }
  return fields.sort((a, b) => a.name.localeCompare(b.name));
}

/** Declared classifications only: a tag on a field, never a guess from the field's name. */
function classificationsOf(value: unknown, source: string): DataProduct['classification'] {
  if (!Array.isArray(value)) {
    return [];
  }
  const tags: DataProduct['classification'] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== 'string') {
      continue;
    }
    const classification = entry.classification ?? entry.classifications;
    const values = Array.isArray(classification)
      ? classification
      : typeof classification === 'string'
        ? [classification]
        : typeof entry.pii === 'boolean' && entry.pii
          ? ['pii']
          : [];
    for (const tag of values) {
      if (typeof tag === 'string' && tag.trim() !== '') {
        tags.push({ field: entry.name, tag: tag.trim(), source });
      }
    }
  }
  return tags;
}

function ownerOf(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }
  if (isRecord(value)) {
    return stringOf(value.name) ?? stringOf(value.email);
  }
  return null;
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
