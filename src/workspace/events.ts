import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { toPosix } from '../boundary/repository-root.ts';
import { excludedDirectory } from '../scan/exclusions.ts';
import type { ContractField, EventContract, EventEndpoint } from '../types.ts';
import { findContractFiles } from './contracts.ts';
import { findSourceFiles } from './dto.ts';

const MAX_BYTES = 2 * 1024 * 1024;

/** A per-ecosystem producer/consumer rule. The first capture group is the literal topic. */
interface EventRule {
  direction: 'produce' | 'consume';
  kind: 'topic' | 'queue';
  evidence: string;
  pattern: RegExp;
  /** A guard the file content must satisfy before the rule is consulted. */
  requires?: RegExp;
}

/**
 * The literal-topic producer and consumer rules.
 *
 * Lexical, like the service-call extractor: only a recognizable client and a string literal are
 * taken. A topic assembled from variables or interpolation records nothing rather than a guess.
 */
const EVENT_RULES: readonly EventRule[] = [
  { direction: 'produce', kind: 'topic', evidence: 'Kafka producer.send', pattern: /\b(?:producer|kafkaProducer|kafkaTemplate|kafka_template)\s*\.\s*send\s*\(\s*[`'"]([\w.:/-]+)[`'"]/g },
  { direction: 'produce', kind: 'queue', evidence: 'SQS sendMessage', pattern: /\b(?:sqs|sns|queue|publisher|producer)\s*\.\s*send(?:Message|Event)?\s*\(\s*(?:\{[^}]*?)?[`'"]([\w.:/-]+)[`'"]/g },
  { direction: 'produce', kind: 'topic', evidence: 'SNS publish', pattern: /\b(?:sns|publisher|producer)\s*\.\s*publish\s*\(\s*(?:\{[^}]*?)?[`'"]([\w.:/-]+)[`'"]/g },
  { direction: 'produce', kind: 'topic', evidence: 'Pub/Sub topic().publish', pattern: /\b(?:pubsub|pubSub)\s*\.\s*topic\s*\(\s*[`'"]([\w.:/-]+)[`'"]\s*\)\s*\.\s*publish\b/g },
  { direction: 'produce', kind: 'topic', evidence: 'RabbitMQ publish', pattern: /\b(?:rabbit|amqp|channel|producer|template)\s*\.\s*(?:send|publish|convertAndSend|basicPublish|sendToExchange)\s*\([^;]*?[`'"]([\w.:/-]+)[`'"]/g },
  { direction: 'consume', kind: 'topic', evidence: 'Kafka @KafkaListener', pattern: /@KafkaListener\s*\([^)]*?topics\s*=\s*(?:\{[^}]*?)?[`'"]([\w.:/-]+)[`'"]/g },
  { direction: 'consume', kind: 'topic', evidence: 'Kafka consumer.subscribe', pattern: /\b(?:consumer|kafkaConsumer|kafka_consumer)\s*\.\s*subscribe\s*\(\s*(?:\[\s*)?[`'"]([\w.:/-]+)[`'"]/g },
  { direction: 'consume', kind: 'queue', evidence: 'SQS receiveMessage', pattern: /\b(?:sqs|queue|consumer)\s*\.\s*receive(?:Message)?\s*\(\s*(?:\{[^}]*?)?[`'"]([\w.:/-]+)[`'"]/g },
  { direction: 'consume', kind: 'queue', evidence: 'RabbitMQ @RabbitListener', pattern: /@RabbitListener\s*\([^)]*?queues\s*=\s*(?:\{[^}]*?)?[`'"]([\w.:/-]+)[`'"]/g },
  { direction: 'consume', kind: 'queue', evidence: 'RabbitMQ basicConsume', pattern: /\b(?:rabbit|amqp|channel|consumer)\s*\.\s*(?:basicConsume|consume)\s*\(\s*[`'"]([\w.:/-]+)[`'"]/g },
  { direction: 'produce', kind: 'topic', evidence: 'CloudEvents type', pattern: /["']type["']\s*[:=]\s*[`'"]([\w.:/-]+)[`'"]/g, requires: /specversion|cloudevents/i },
];

/** Extract the literal topics and queues a repository's source produces to and consumes from. */
export function extractEventEndpoints(root: string, repository: string): EventEndpoint[] {
  const endpoints: EventEndpoint[] = [];
  for (const file of findSourceFiles(root)) {
    const content = readText(root, file);
    if (content === null) {
      continue;
    }
    for (const rule of EVENT_RULES) {
      if (rule.requires && !rule.requires.test(content)) {
        continue;
      }
      for (const match of content.matchAll(rule.pattern)) {
        const topic = match[1];
        if (!topic) {
          continue;
        }
        endpoints.push({
          topic,
          kind: rule.kind,
          repository,
          file,
          line: lineAt(content, match.index ?? 0),
          direction: rule.direction,
          evidence: rule.evidence,
        });
      }
    }
  }
  return dedupe(endpoints);
}

/** A schema-registry subject mapping declared in the workspace config. */
export interface RegistrySubject {
  subject: string;
  /** Path to the schema file, relative to the repository root. */
  file: string;
}

/**
 * Extract payload contracts: AsyncAPI `channels`, Avro `.avsc` records, and schema-registry
 * subjects declared in config. A document that does not parse is skipped, never guessed at.
 */
export function extractEventContracts(
  root: string,
  repository: string,
  subjects: readonly RegistrySubject[] = [],
): EventContract[] {
  const contracts: EventContract[] = [];
  for (const file of findContractFiles(root)) {
    if (!/\.(?:ya?ml|json)$/i.test(file)) {
      continue;
    }
    const content = readText(root, file);
    if (content === null) {
      continue;
    }
    try {
      const document: unknown = file.endsWith('.json') ? JSON.parse(content) : parseYaml(content);
      contracts.push(...asyncApiContracts(repository, file, document));
    } catch {
      // A malformed document contributes nothing.
    }
  }
  for (const file of findFiles(root, /\.avsc$/i)) {
    const content = readText(root, file);
    if (content === null) {
      continue;
    }
    try {
      const contract = avroContract(repository, file, JSON.parse(content));
      if (contract) {
        contracts.push(contract);
      }
    } catch {
      // A malformed Avro schema contributes nothing.
    }
  }
  for (const subject of subjects) {
    const content = readText(root, subject.file);
    if (content === null) {
      continue;
    }
    try {
      contracts.push({
        topic: subject.subject,
        format: 'schema-registry',
        repository,
        source: subject.file,
        fields: schemaFields(JSON.parse(content)),
      });
    } catch {
      // A malformed registry schema contributes nothing.
    }
  }
  return contracts;
}

function asyncApiContracts(repository: string, file: string, document: unknown): EventContract[] {
  if (!isRecord(document) || typeof document.asyncapi !== 'string') {
    return [];
  }
  const channels = isRecord(document.channels) ? document.channels : {};
  const contracts: EventContract[] = [];
  for (const [topic, channel] of Object.entries(channels)) {
    if (!isRecord(channel)) {
      continue;
    }
    for (const operation of ['publish', 'subscribe'] as const) {
      const op = channel[operation];
      if (!isRecord(op)) {
        continue;
      }
      const message = isRecord(op.message) ? op.message : {};
      const payload = isRecord(message.payload) ? message.payload : {};
      const fields = isRecord(payload.properties) ? fieldsFromProperties(payload) : [];
      if (fields.length === 0) {
        continue;
      }
      contracts.push({ topic, format: 'asyncapi', repository, source: file, fields });
    }
  }
  return contracts;
}

function avroContract(repository: string, file: string, document: unknown): EventContract | null {
  if (!isRecord(document) || document.type !== 'record' || typeof document.name !== 'string') {
    return null;
  }
  const fields = Array.isArray(document.fields)
    ? document.fields
        .filter((field): field is Record<string, unknown> => isRecord(field) && typeof field.name === 'string')
        .map((field): ContractField => ({
          name: field.name as string,
          type: describeAvroType(field.type),
          required: !('default' in field),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  return { topic: document.name, format: 'avro', repository, source: file, fields };
}

function schemaFields(document: unknown): ContractField[] {
  if (!isRecord(document)) {
    return [];
  }
  if (document.type === 'record' && Array.isArray(document.fields)) {
    return avroContract('', '', document)?.fields ?? [];
  }
  return fieldsFromProperties(document);
}

function fieldsFromProperties(schema: Record<string, unknown>): ContractField[] {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : [],
  );
  return Object.entries(properties)
    .map(([name, definition]): ContractField => ({
      name,
      type: describeJsonType(definition),
      required: required.has(name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function describeJsonType(schema: unknown): string {
  if (!isRecord(schema)) {
    return 'unknown';
  }
  if (schema.type === 'array') {
    return `array<${describeJsonType(schema.items)}>`;
  }
  if (typeof schema.type === 'string') {
    return schema.type;
  }
  return 'unknown';
}

function describeAvroType(type: unknown): string {
  if (typeof type === 'string') {
    return type;
  }
  if (Array.isArray(type)) {
    return 'union';
  }
  if (isRecord(type) && typeof type.type === 'string') {
    return type.type;
  }
  return 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findFiles(root: string, pattern: RegExp): string[] {
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
        if (!excludedDirectory(relative)) {
          walk(absolute);
        }
        continue;
      }
      if (pattern.test(entry.name)) {
        found.push(relative);
      }
    }
  };
  walk(root);
  return found.sort();
}

function dedupe(endpoints: EventEndpoint[]): EventEndpoint[] {
  const seen = new Set<string>();
  const result: EventEndpoint[] = [];
  for (const endpoint of endpoints.sort(
    (a, b) => a.topic.localeCompare(b.topic) || a.file.localeCompare(b.file) || a.line - b.line || a.direction.localeCompare(b.direction),
  )) {
    const key = `${endpoint.repository}\u0000${endpoint.file}\u0000${endpoint.line}\u0000${endpoint.topic}\u0000${endpoint.direction}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(endpoint);
  }
  return result;
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let offset = content.indexOf('\n'); offset !== -1 && offset < index; offset = content.indexOf('\n', offset + 1)) {
    line += 1;
  }
  return line;
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
