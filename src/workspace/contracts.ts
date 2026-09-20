import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { toPosix } from '../boundary/repository-root.ts';
import { excludedDirectory } from '../scan/exclusions.ts';
import type {
  ContractDefinition,
  ContractDeviation,
  ContractDrift,
  ContractField,
} from '../types.ts';

const CONTRACT_EXTENSIONS = ['.proto', '.json', '.yaml', '.yml'];
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Extract the data contracts a repository declares.
 *
 * Supported in this pass: Protobuf messages, OpenAPI `components.schemas`, and JSON Schema
 * objects. A field's type and required-ness are normalised so the same contract can be
 * compared across repositories. A file that does not parse is skipped, never guessed at.
 */
export function extractContracts(root: string, repository: string): ContractDefinition[] {
  const contracts: ContractDefinition[] = [];
  for (const file of findContractFiles(root)) {
    const content = readText(root, file);
    if (content === null) {
      continue;
    }
    try {
      if (file.endsWith('.proto')) {
        contracts.push(...parseProto(repository, file, content));
      } else {
        contracts.push(...parseStructured(repository, file, content));
      }
    } catch {
      // A malformed contract is not a contract; it is reported as absent.
    }
  }
  return contracts;
}

/** Find candidate contract files, pruning generated directories with the scanner's rules. */
export function findContractFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
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
        if (excludedDirectory(relative)) {
          continue;
        }
        walk(absolute);
        continue;
      }
      if (CONTRACT_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
        found.push(relative);
      }
    }
  };
  walk(root);
  return found.sort();
}

function parseStructured(repository: string, file: string, content: string): ContractDefinition[] {
  const extension = path.extname(file).toLowerCase();
  const document: unknown = extension === '.json' ? JSON.parse(content) : parseYaml(content);
  if (!isRecord(document)) {
    return [];
  }
  if ('openapi' in document || 'swagger' in document) {
    return parseOpenApi(repository, file, document);
  }
  if (looksLikeJsonSchema(document)) {
    return parseJsonSchema(repository, file, document);
  }
  return [];
}

function parseOpenApi(
  repository: string,
  file: string,
  document: Record<string, unknown>,
): ContractDefinition[] {
  const info = isRecord(document.info) ? document.info : {};
  const title = typeof info.title === 'string' ? info.title.trim() : '';
  if (title === '') {
    return [];
  }
  const version = typeof info.version === 'string' ? info.version : undefined;
  const components = isRecord(document.components) ? document.components : {};
  const schemas = isRecord(components.schemas) ? components.schemas : {};
  const contracts: ContractDefinition[] = [];
  for (const [name, schema] of Object.entries(schemas)) {
    if (!isRecord(schema)) {
      continue;
    }
    contracts.push({
      id: `${title}#${name}`,
      format: 'openapi',
      repository,
      source: file,
      ...(version ? { version } : {}),
      fields: fieldsFromSchema(schema),
    });
  }
  return contracts;
}

function looksLikeJsonSchema(document: Record<string, unknown>): boolean {
  const schema = typeof document.$schema === 'string' ? document.$schema : '';
  if (schema.includes('json-schema')) {
    return true;
  }
  return document.type === 'object' && isRecord(document.properties);
}

function parseJsonSchema(
  repository: string,
  file: string,
  document: Record<string, unknown>,
): ContractDefinition[] {
  const id =
    (typeof document.$id === 'string' && document.$id.trim()) ||
    (typeof document.title === 'string' && document.title.trim()) ||
    file;
  return [
    {
      id,
      format: 'json-schema',
      repository,
      source: file,
      fields: fieldsFromSchema(document),
    },
  ];
}

function fieldsFromSchema(schema: Record<string, unknown>): ContractField[] {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((entry) => typeof entry === 'string') : [],
  );
  return Object.entries(properties)
    .map(([name, definition]): ContractField => ({
      name,
      type: describeType(definition),
      required: required.has(name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function describeType(schema: unknown): string {
  if (!isRecord(schema)) {
    return 'unknown';
  }
  if (typeof schema.$ref === 'string') {
    return refName(schema.$ref);
  }
  if (schema.type === 'array') {
    return `array<${describeType(schema.items)}>`;
  }
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf) || Array.isArray(schema.allOf)) {
    return 'union';
  }
  if (isRecord(schema.properties)) {
    return 'object';
  }
  if (typeof schema.type === 'string') {
    return typeof schema.format === 'string' ? `${schema.type}(${schema.format})` : schema.type;
  }
  return 'unknown';
}

/** The last path segment of a `$ref`, e.g. `#/components/schemas/User` -> `User`. */
function refName(ref: string): string {
  const trimmed = ref.split('/').filter(Boolean).pop();
  return trimmed ?? ref;
}

function parseProto(repository: string, file: string, content: string): ContractDefinition[] {
  const packageName = /^\s*package\s+([\w.]+)\s*;/m.exec(content)?.[1] ?? '';
  const contracts: ContractDefinition[] = [];
  const messagePattern = /\bmessage\s+([A-Za-z_]\w*)\s*\{/g;
  for (const match of content.matchAll(messagePattern)) {
    const name = match[1] ?? '';
    const open = (match.index ?? 0) + match[0].length - 1;
    const body = matchingBraces(content, open);
    if (name === '' || body === null) {
      continue;
    }
    contracts.push({
      id: packageName ? `${packageName}.${name}` : name,
      format: 'protobuf',
      repository,
      source: file,
      fields: protoFields(body),
    });
  }
  return contracts;
}

/** Fields of a message body, ignoring nested message/enum contents but keeping `oneof`. */
function protoFields(body: string): ContractField[] {
  const fields: ContractField[] = [];
  let skipDepth = 0;
  let oneofDepth = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (line === '') {
      continue;
    }
    if (line.startsWith('}')) {
      if (oneofDepth > 0) {
        oneofDepth -= 1;
      } else if (skipDepth > 0) {
        skipDepth -= 1;
      }
      continue;
    }
    const opens = line.includes('{');
    if (/^oneof\b/.test(line) && opens) {
      oneofDepth += 1;
      continue;
    }
    if (opens) {
      skipDepth += 1;
      continue;
    }
    if (skipDepth > 0) {
      continue;
    }
    const hit = /^(repeated\s+|optional\s+|required\s+)?([A-Za-z_][\w.]*)\s+([A-Za-z_]\w*)\s*=\s*\d+/.exec(
      line,
    );
    if (!hit) {
      continue;
    }
    const qualifier = (hit[1] ?? '').trim();
    fields.push({
      name: hit[3] ?? '',
      type: hit[2] ?? 'unknown',
      required: qualifier !== 'repeated' && qualifier !== 'optional',
    });
  }
  return fields
    .filter((field) => field.name !== '')
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The substring inside the braces that open at `openIndex`, or null when unbalanced. */
function matchingBraces(content: string, openIndex: number): string | null {
  if (content[openIndex] !== '{') {
    return null;
  }
  let depth = 0;
  for (let index = openIndex; index < content.length; index += 1) {
    const character = content[index];
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return content.slice(openIndex + 1, index);
      }
    }
  }
  return null;
}

/**
 * Compare contract definitions that share an id across repositories.
 *
 * The same id in two repositories is the evidence of a shared contract; the deviation is
 * the concrete difference in its fields — a field one side lacks, a type that changed, or
 * required-ness that disagrees. Identical definitions are kept with an empty deviation
 * list rather than dropped, so a shared contract that matches is visible too.
 */
export function computeContractDrift(contracts: ContractDefinition[]): ContractDrift[] {
  const byId = new Map<string, ContractDefinition[]>();
  for (const contract of contracts) {
    const list = byId.get(contract.id) ?? [];
    list.push(contract);
    byId.set(contract.id, list);
  }

  const drifts: ContractDrift[] = [];
  for (const [id, definitions] of byId) {
    const repositories = [...new Set(definitions.map((entry) => entry.repository))].sort();
    if (repositories.length < 2) {
      continue;
    }
    const byField = new Map<string, ContractDeviation['declared']>();
    for (const definition of definitions) {
      for (const field of definition.fields) {
        const declared = byField.get(field.name) ?? [];
        if (!declared.some((entry) => entry.repository === definition.repository)) {
          declared.push({
            repository: definition.repository,
            type: field.type,
            required: field.required,
          });
        }
        byField.set(field.name, declared);
      }
    }

    const deviations: ContractDeviation[] = [];
    for (const [name, declared] of [...byField.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      declared.sort((a, b) => a.repository.localeCompare(b.repository));
      const issue = deviationIssue(declared, repositories.length);
      if (issue) {
        deviations.push({ name, declared, issue });
      }
    }

    drifts.push({
      id,
      format: definitions[0]?.format ?? 'json-schema',
      repositories,
      deviations,
    });
  }

  return drifts.sort((a, b) => a.id.localeCompare(b.id));
}

function deviationIssue(
  declared: ContractDeviation['declared'],
  repositoryCount: number,
): ContractDeviation['issue'] | null {
  if (declared.length < repositoryCount) {
    return 'missing';
  }
  if (new Set(declared.map((entry) => entry.type)).size > 1) {
    return 'type';
  }
  if (new Set(declared.map((entry) => entry.required)).size > 1) {
    return 'required';
  }
  return null;
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
