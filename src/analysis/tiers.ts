import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { toPosix } from '../boundary/repository-root.ts';
import { isSourceExtension } from '../scan/scan.ts';
import { extractCallsFromContent, extractServiceEndpoints } from '../workspace/services.ts';
import { assignUnits, detectUnits, DECLARED_GROUPS_FILE } from './units.ts';

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * The role code plays, cutting across build units.
 *
 * A unit answers "what is deployed"; a tier answers "what this code does". `unclassified`
 * is a real answer: a file with no recorded evidence is never forced into a tier.
 */
export type Tier =
  | 'frontend'
  | 'api'
  | 'domain'
  | 'data'
  | 'integration'
  | 'infra'
  | 'build'
  | 'tests'
  | 'unclassified';

/** How strong the evidence for a tier is, strongest first. */
export type TierStrength = 'declared' | 'framework' | 'annotation' | 'file-kind' | 'path-token';

/** The order a mixed file's primary tier is chosen in: the upper layer wins. */
const TIER_ORDER: Tier[] = [
  'frontend',
  'api',
  'domain',
  'integration',
  'data',
  'infra',
  'build',
  'tests',
  'unclassified',
];

/**
 * Dependency rank for the direction check: a higher rank may depend on a lower one. Tiers
 * outside this map (infra, build, tests, unclassified) are not part of the layer order.
 */
const TIER_RANK: Partial<Record<Tier, number>> = {
  frontend: 5,
  api: 4,
  domain: 3,
  integration: 2,
  data: 1,
};

/** The dependency rank of a tier, or null when it sits outside the layer order. */
export function tierRank(tier: Tier): number | null {
  return TIER_RANK[tier] ?? null;
}

const STRENGTH_RANK: Record<TierStrength, number> = {
  framework: 4,
  annotation: 3,
  'file-kind': 2,
  'path-token': 1,
  declared: 5,
};

export interface TierEvidence {
  tier: Tier;
  strength: TierStrength;
  detail: string;
}

/** One place a data table is named, with the rule that read it. */
export interface TableReference {
  table: string;
  file: string;
  line: number;
  evidence: string;
}

export interface TierClassification {
  file: string;
  tier: Tier;
  /** True when two tiers share the strongest evidence, so no single tier is claimed. */
  mixed: boolean;
  evidence: TierEvidence[];
  /** Source lines counted directly, the one complexity input this pass records. */
  lines: number;
  /** Data tables named in the file, from SQL, ORM annotations, or string-literal SQL. */
  tables: TableReference[];
}

export interface DeclaredTier {
  tier: Tier;
  globs: string[];
}

type Language = 'js' | 'rust' | 'java' | 'kotlin' | 'csharp' | 'python' | 'go' | 'cpp' | 'sql' | 'proto' | 'other';

interface Rule {
  tier: Tier;
  /** Alternation of literal tokens, matched as a whole word. */
  pattern: RegExp;
}

function words(tokens: readonly string[]): RegExp {
  const escaped = tokens
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
    .join('|');
  return new RegExp(`(?:^|[^\\w-])(?:${escaped})(?:$|[^\\w-])`, 'i');
}

/** Importers and frameworks per language, strongest evidence. */
const FRAMEWORK_RULES: Partial<Record<Language, Rule[]>> = {
  js: [
    { tier: 'api', pattern: words(['express', 'fastify', 'koa', 'nestjs', '@nestjs', 'hapi', 'hono']) },
    { tier: 'frontend', pattern: words(['react', 'react-dom', 'next', 'nuxt', 'vue', 'svelte', 'angular', '@angular', 'solid-js', 'preact']) },
    { tier: 'data', pattern: words(['prisma', '@prisma', 'typeorm', 'sequelize', 'mongoose', 'knex', 'drizzle-orm', 'better-sqlite3', 'pg', 'mysql2']) },
    { tier: 'integration', pattern: words(['axios', 'node-fetch', 'got', 'undici', 'kafkajs', 'amqplib', 'ioredis']) },
  ],
  rust: [
    { tier: 'api', pattern: words(['axum', 'actix-web', 'actix_web', 'rocket', 'warp', 'poem', 'tide']) },
    { tier: 'data', pattern: words(['sqlx', 'diesel', 'sea-orm', 'sea_orm', 'rusqlite', 'mongodb', 'redis']) },
    { tier: 'integration', pattern: words(['reqwest', 'hyper', 'tonic', 'lapin', 'rdkafka', 'nats']) },
  ],
  java: [
    { tier: 'api', pattern: words(['org.springframework.web', 'springframework.web', 'jakarta.ws.rs', 'javax.ws.rs', 'spring-web', 'jaxrs']) },
    { tier: 'data', pattern: words(['jakarta.persistence', 'javax.persistence', 'org.hibernate', 'hibernate', 'org.springframework.data', 'spring-data-jpa', 'jdbc', 'mybatis']) },
    { tier: 'integration', pattern: words(['okhttp', 'retrofit', 'java.net.http', 'apache.http', 'spring-kafka', 'amqp']) },
  ],
  kotlin: [
    { tier: 'frontend', pattern: words(['androidx.compose', 'androidx.activity', 'androidx.fragment', 'swiftui']) },
    { tier: 'api', pattern: words(['org.springframework.web', 'springframework.web', 'io.ktor.server', 'ktor.server', 'javax.ws.rs']) },
    { tier: 'data', pattern: words(['androidx.room', 'room', 'jakarta.persistence', 'org.springframework.data', 'exposed', 'sqldelight']) },
    { tier: 'integration', pattern: words(['okhttp', 'retrofit', 'ktor.client', 'io.ktor.client']) },
  ],
  csharp: [
    { tier: 'api', pattern: words(['Microsoft.AspNetCore', 'aspnetcore', 'System.Web']) },
    { tier: 'data', pattern: words(['EntityFrameworkCore', 'Microsoft.EntityFrameworkCore', 'Dapper', 'System.Data.SqlClient', 'Npgsql']) },
    { tier: 'integration', pattern: words(['HttpClient', 'Refit', 'Confluent.Kafka', 'RabbitMQ.Client']) },
  ],
  python: [
    { tier: 'api', pattern: words(['flask', 'fastapi', 'django', 'django.urls', 'starlette', 'tornado', 'aiohttp.web']) },
    { tier: 'data', pattern: words(['sqlalchemy', 'django.db', 'peewee', 'psycopg2', 'pymysql', 'asyncpg']) },
    { tier: 'integration', pattern: words(['requests', 'httpx', 'aiohttp', 'kafka', 'pika', 'boto3', 'redis']) },
  ],
  go: [
    { tier: 'api', pattern: words(['gin-gonic', 'labstack/echo', 'go-chi', 'gorilla/mux', 'net/http']) },
    { tier: 'data', pattern: words(['gorm.io', 'database/sql', 'sqlx', 'ent', 'mongo-driver']) },
    { tier: 'integration', pattern: words(['go-redis', 'segmentio/kafka-go', 'streadway/amqp', 'nats.go']) },
  ],
};

/** Annotations and macros per language, next-strongest evidence. */
const ANNOTATION_RULES: Partial<Record<Language, Rule[]>> = {
  java: [
    { tier: 'api', pattern: /@(RestController|Controller|GetMapping|PostMapping|PutMapping|DeleteMapping|RequestMapping|Path)\b/ },
    { tier: 'data', pattern: /@(Entity|Table|Dao|Repository|Document)\b/ },
  ],
  kotlin: [
    { tier: 'api', pattern: /@(RestController|Controller|GetMapping|PostMapping|RequestMapping)\b/ },
    { tier: 'data', pattern: /@(Entity|Table|Dao|Repository|Database)\b/ },
    { tier: 'frontend', pattern: /@(Composable|Preview)\b/ },
  ],
  csharp: [
    { tier: 'api', pattern: /\[(ApiController|HttpGet|HttpPost|HttpPut|HttpDelete|Route)\b/ },
    { tier: 'data', pattern: /\[(Table|Key|Column|DatabaseGenerated)\b/ },
  ],
  rust: [
    { tier: 'api', pattern: /#\[(get|post|put|delete|patch)\s*\(/ },
    { tier: 'data', pattern: /#\[(derive\s*\([^)]*(FromRow|sqlx)|table|entity)\b/i },
  ],
  python: [
    { tier: 'api', pattern: /@(app|router|bp)\.(get|post|put|delete|patch|route)\b/ },
    { tier: 'data', pattern: /@(Entity|Table)\b/ },
  ],
};

/** File kinds: path and extension, stronger than a bare token but weaker than a framework. */
const FILE_KIND_RULES: Array<{ tier: Tier; test: (file: string) => boolean; detail: string }> = [
  { tier: 'data', test: (file) => /\.sql$/i.test(file) || /(^|\/)migrations?\//i.test(file), detail: 'SQL or a migration' },
  { tier: 'data', test: (file) => /\.proto$/i.test(file), detail: 'a protobuf schema' },
  { tier: 'infra', test: (file) => /(^|\/)(dockerfile|docker-compose\.ya?ml)$/i.test(file), detail: 'a container definition' },
  { tier: 'infra', test: (file) => /(^|\/)(k8s|kubernetes|helm|charts|terraform)\//i.test(file) || /\.tf$/i.test(file), detail: 'infrastructure as code' },
  { tier: 'build', test: (file) => /(^|\/)\.github\/workflows\//i.test(file), detail: 'a CI workflow' },
  { tier: 'build', test: (file) => /(^|\/)(makefile|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|pom\.xml|cargo\.toml|go\.mod|pyproject\.toml)$/i.test(file) || /\.csproj$/i.test(file), detail: 'a build manifest' },
  { tier: 'tests', test: (file) => /(^|\/)(tests?|__tests__|specs?)\//i.test(file) || /\.(test|spec)\.[^/]+$/i.test(file), detail: 'a test path or suffix' },
];

/** Path tokens, the weakest evidence, used only when nothing stronger matched. */
const PATH_TOKEN_RULES: Array<{ tier: Tier; tokens: string[] }> = [
  { tier: 'frontend', tokens: ['ui', 'screen', 'screens', 'components', 'pages', 'views', 'widgets', 'compose'] },
  { tier: 'api', tokens: ['handlers', 'handler', 'routes', 'router', 'controllers', 'controller', 'endpoints', 'api'] },
  { tier: 'domain', tokens: ['domain', 'services', 'service', 'usecase', 'usecases', 'interactors', 'logic'] },
  { tier: 'data', tokens: ['data', 'repository', 'repositories', 'dao', 'db', 'database', 'models', 'entities', 'persistence'] },
  { tier: 'integration', tokens: ['clients', 'client', 'integrations', 'integration', 'gateway', 'adapters', 'adapter'] },
  { tier: 'infra', tokens: ['infra', 'config', 'deployment', 'deploy'] },
  { tier: 'build', tokens: ['scripts', 'script', 'tools', 'tool', 'build', 'ci'] },
];

/** Classify one file from its recorded content and path, with the evidence behind it. */
export function classifyTierContent(
  file: string,
  content: string,
  declared: readonly DeclaredTier[] = [],
): TierClassification {
  const language = languageOf(file);
  const evidence: TierEvidence[] = [];
  const lines = countLines(content);
  const tables = extractTables(file, content);

  const declaredMatch = declared.find((entry) =>
    entry.globs.some((glob) => globToRegExp(glob).test(file)),
  );
  if (declaredMatch) {
    // An operator-stated tier wins outright and is labelled as announced, not observed.
    return {
      file,
      tier: declaredMatch.tier,
      mixed: false,
      evidence: [
        { tier: declaredMatch.tier, strength: 'declared', detail: `declared in ${DECLARED_GROUPS_FILE}` },
      ],
      lines,
      tables,
    };
  }

  const imports = importText(content);
  for (const rule of FRAMEWORK_RULES[language] ?? []) {
    const hit = rule.pattern.exec(imports);
    if (hit) {
      evidence.push({ tier: rule.tier, strength: 'framework', detail: `imports ${hit[0].trim()}` });
    }
  }
  for (const rule of ANNOTATION_RULES[language] ?? []) {
    const hit = rule.pattern.exec(content);
    if (hit) {
      evidence.push({ tier: rule.tier, strength: 'annotation', detail: `annotation ${hit[0].trim()}` });
    }
  }
  for (const rule of FILE_KIND_RULES) {
    if (rule.test(file)) {
      evidence.push({ tier: rule.tier, strength: 'file-kind', detail: rule.detail });
    }
  }
  if (evidence.length === 0) {
    const segments = file.split('/').slice(0, -1).map((segment) => segment.toLowerCase());
    for (const rule of PATH_TOKEN_RULES) {
      const token = rule.tokens.find((candidate) => segments.includes(candidate));
      if (token) {
        evidence.push({ tier: rule.tier, strength: 'path-token', detail: `path token \`${token}\`` });
        break;
      }
    }
  }

  if (evidence.length === 0) {
    return { file, tier: 'unclassified', mixed: false, evidence: [], lines, tables };
  }

  const byTier = new Map<Tier, number>();
  for (const entry of evidence) {
    byTier.set(entry.tier, Math.max(byTier.get(entry.tier) ?? 0, STRENGTH_RANK[entry.strength]));
  }
  const strongest = Math.max(...byTier.values());
  const top = TIER_ORDER.filter((tier) => byTier.get(tier) === strongest);
  return {
    file,
    tier: top[0] ?? 'unclassified',
    // Two tiers at the same strongest evidence is a mixed file, not a forced choice.
    mixed: top.length > 1,
    evidence,
    lines,
    tables,
  };
}

const RESERVED_TABLES = new Set([
  'select', 'where', 'set', 'values', 'table', 'from', 'into', 'update', 'join', 'delete',
  'insert', 'create', 'alter', 'on', 'using', 'as', 'with', 'and', 'or', 'not', 'null',
  'default', 'primary', 'foreign', 'index', 'if', 'exists', 'inner', 'left', 'right',
]);

/**
 * Extract the data tables a file names, each with the rule that read it.
 *
 * Lexical and labelled: SQL keywords, ORM annotations/macros, and string-literal SQL. A
 * query builder that hides the table name, or a dynamic string, records nothing rather than
 * a guessed table.
 */
export function extractTables(file: string, content: string): TableReference[] {
  const found = new Map<string, TableReference>();
  const add = (raw: string, index: number, evidence: string): void => {
    const table = raw.replace(/["'`[\]]/g, '');
    if (table === '' || RESERVED_TABLES.has(table.toLowerCase())) {
      return;
    }
    const line = lineAt(content, index);
    found.set(`${table}\u0000${line}\u0000${evidence}`, { table, file, line, evidence });
  };

  for (const match of content.matchAll(
    /\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|INSERT\s+INTO|DELETE\s+FROM|UPDATE|JOIN)\s+["'`[]?([A-Za-z_][\w.]*)/gi,
  )) {
    add(match[1] ?? '', match.index ?? 0, 'SQL keyword');
  }
  for (const match of content.matchAll(
    /@(?:Table|Entity)\s*\(\s*(?:name|tableName)\s*=\s*["']([^"']+)["']/gi,
  )) {
    add(match[1] ?? '', match.index ?? 0, 'ORM annotation');
  }
  for (const match of content.matchAll(/#\[table\s*\(\s*name\s*=\s*"([^"]+)"/gi)) {
    add(match[1] ?? '', match.index ?? 0, 'ORM macro');
  }
  for (const match of content.matchAll(
    /["'`][^"'`]*?\b(?:from|join|into|update)\s+["'`]?([A-Za-z_][\w.]*)[^"'`]*?["'`]/gi,
  )) {
    add(match[1] ?? '', match.index ?? 0, 'string-literal SQL');
  }

  return [...found.values()].sort(
    (a, b) => a.table.localeCompare(b.table) || a.line - b.line || a.evidence.localeCompare(b.evidence),
  );
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let offset = 0; offset < index && offset < content.length; offset += 1) {
    if (content[offset] === '\n') {
      line += 1;
    }
  }
  return line;
}

function countLines(content: string): number {
  if (content === '') {
    return 0;
  }
  return content.split(/\r?\n/).length;
}

/** Classify every file, reading bounded source. Files that cannot be read are unclassified. */
export function classifyTiers(
  root: string,
  files: readonly string[],
  declared: readonly DeclaredTier[] = [],
): { files: TierClassification[]; skipped: string[] } {
  const classified: TierClassification[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const content = readText(root, file);
    if (content === null) {
      skipped.push(file);
      continue;
    }
    classified.push(classifyTierContent(file, content, declared));
  }
  return { files: classified, skipped };
}

/** Read tier overrides from the `tiers` list in `strabo.groups.yml`. */
export function readDeclaredTiers(root: string): DeclaredTier[] {
  let content: string;
  try {
    content = fs.readFileSync(path.join(root, DECLARED_GROUPS_FILE), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return [];
  }
  const entries = (parsed as { tiers?: unknown } | null)?.tiers;
  if (!Array.isArray(entries)) {
    return [];
  }
  const tiers: DeclaredTier[] = [];
  for (const entry of entries) {
    const record = entry as { tier?: unknown; globs?: unknown };
    const tier = typeof record.tier === 'string' && TIER_ORDER.includes(record.tier as Tier)
      ? (record.tier as Tier)
      : null;
    const globs = Array.isArray(record.globs)
      ? record.globs.filter((glob): glob is string => typeof glob === 'string' && glob.trim() !== '')
      : [];
    if (tier && globs.length > 0) {
      tiers.push({ tier, globs });
    }
  }
  return tiers;
}

export type UnitRole = 'app' | 'service' | 'library' | 'tool';

/** A build unit's role, from the tiers of its files and its recorded entry points. */
export function unitRole(
  unit: { id: string; name: string },
  files: readonly string[],
  tierOf: (file: string) => Tier,
): { role: UnitRole; evidence: string } {
  const within = files.filter((file) => unit.id === '.' || file === unit.id || file.startsWith(`${unit.id}/`));
  const frontend = within.filter((file) => tierOf(file) === 'frontend');
  const api = within.filter((file) => tierOf(file) === 'api');
  const underTools = within.some((file) => /(^|\/)(tools?|scripts?)\//.test(file));

  if (frontend.length > 0) {
    return { role: 'app', evidence: `frontend tier (${frontend.length} file(s))` };
  }
  if (api.length > 0) {
    return { role: 'service', evidence: `API tier (${api.length} file(s))` };
  }
  if (underTools) {
    return { role: 'tool', evidence: 'files under tools/ or scripts/' };
  }
  return { role: 'library', evidence: 'no frontend, API, or tool evidence' };
}

/** A build unit seen through the tier lens, with its role from the same evidence. */
export interface TierUnitReport {
  id: string;
  name: string;
  role: UnitRole;
  roleEvidence: string;
  files: number;
  tiers: Record<Tier, number>;
}

/** One cell of the tier × unit matrix: file count and directly counted lines. */
export interface TierMatrixCell {
  unit: string;
  tier: Tier;
  files: number;
  lines: number;
}

export interface TierMatrix {
  /** Row order: dependency order, frontend on top, unclassified last. */
  tiers: Tier[];
  units: string[];
  cells: TierMatrixCell[];
  perTier: Array<{ tier: Tier; files: number; lines: number; fileShare: number }>;
}

/** A recorded dependency that runs the wrong way through the tier order. */
export interface TierDirection {
  unit: string;
  source: string;
  target: string;
  sourceTier: Tier;
  targetTier: Tier;
  kind: 'upward' | 'skip-layer';
  line: number;
  specifier: string;
}

/** One recorded reference to a table, joined to the file's tier and unit. */
export interface TableTraceEntry {
  table: string;
  file: string;
  tier: Tier;
  unit: string;
  line: number;
  evidence: string;
}

/** A recorded outbound HTTP call in a classified file, joined to its tier and unit. */
export interface TierCallSite {
  file: string;
  tier: Tier;
  unit: string;
  line: number;
  method: string | null;
  target: string;
  host: string | null;
  path: string | null;
}

/** A declared HTTP endpoint, joined to the tier and unit of the document that declares it. */
export interface TierEndpointSite {
  file: string;
  tier: Tier;
  unit: string;
  method: string;
  path: string;
}

/** The top half of the end-to-end trace: a call site and the endpoint it reaches here. */
export interface TierTrace {
  call: TierCallSite;
  endpoint: TierEndpointSite | null;
}

export interface TierReport {
  files: TierClassification[];
  units: TierUnitReport[];
  matrix: TierMatrix;
  directions: TierDirection[];
  tables: TableReference[];
  /** The bottom half of the end-to-end trace: a table joined to the files that name it. */
  tableTrace: TableTraceEntry[];
  /** The top half: outbound calls and the endpoints a document in this repository declares. */
  calls: TierCallSite[];
  endpoints: TierEndpointSite[];
  /** A call site joined to the endpoint it reaches here by method and path, when one matches. */
  traces: TierTrace[];
  summary: Record<Tier, number> & { total: number; mixed: number; unclassified: number };
  skipped: string[];
  /** Files beyond the scan ceiling; not read, so they are not claimed as unclassified. */
  truncated: number;
}

/** Bound on files read for classification, so a huge repository cannot stall the request. */
export const MAX_TIER_FILES = 2000;

function emptyTierCounts(): Record<Tier, number> {
  return {
    frontend: 0,
    api: 0,
    domain: 0,
    data: 0,
    integration: 0,
    infra: 0,
    build: 0,
    tests: 0,
    unclassified: 0,
  };
}

/** Classify a repository's files and roll the result up per build unit. */
export function buildTierReport(
  root: string,
  repositoryName: string,
  graph: {
    nodes: Array<{ id: string }>;
    edges?: Array<{ source: string; target: string; evidence?: { line: number; specifier: string } }>;
  },
): TierReport {
  const all = graph.nodes.map((node) => node.id).sort();
  const selected = all.slice(0, MAX_TIER_FILES);
  const declared = readDeclaredTiers(root);
  const { files, skipped } = classifyTiers(root, selected, declared);
  const tierOf = new Map(files.map((entry) => [entry.file, entry.tier]));

  const units = detectUnits(root, selected, repositoryName);
  // Endpoint documents (OpenAPI) are not graph nodes, but they still sit in a unit; assign
  // them alongside the nodes so a trace's endpoint carries a real unit.
  const endpointDocs = extractServiceEndpoints(root, repositoryName);
  const assignment = assignUnits(
    [...new Set([...selected, ...endpointDocs.map((endpoint) => endpoint.source)])],
    units,
  );
  const byUnit = new Map<string, string[]>();
  for (const file of selected) {
    const unit = assignment.get(file) ?? '.';
    byUnit.set(unit, [...(byUnit.get(unit) ?? []), file]);
  }

  const summary = emptyTierCounts();
  let mixed = 0;
  for (const entry of files) {
    summary[entry.tier] += 1;
    if (entry.mixed) {
      mixed += 1;
    }
  }

  const unitReports: TierUnitReport[] = units
    .map((unit) => {
      const members = byUnit.get(unit.id) ?? [];
      const tiers = emptyTierCounts();
      for (const file of members) {
        tiers[tierOf.get(file) ?? 'unclassified'] += 1;
      }
      const role = unitRole(unit, members, (file) => tierOf.get(file) ?? 'unclassified');
      return {
        id: unit.id,
        name: unit.name,
        role: role.role,
        roleEvidence: role.evidence,
        files: members.length,
        tiers,
      };
    })
    .filter((unit) => unit.files > 0);

  const unitIds = [...new Set(selected.map((file) => assignment.get(file) ?? '.'))].sort();
  const cellMap = new Map<string, { files: number; lines: number }>();
  const unitTiers = new Map<string, Set<Tier>>();
  for (const entry of files) {
    const unit = assignment.get(entry.file) ?? '.';
    const key = `${unit}\u0000${entry.tier}`;
    const cell = cellMap.get(key) ?? { files: 0, lines: 0 };
    cell.files += 1;
    cell.lines += entry.lines;
    cellMap.set(key, cell);
    const tiers = unitTiers.get(unit) ?? new Set<Tier>();
    tiers.add(entry.tier);
    unitTiers.set(unit, tiers);
  }

  const cells: TierMatrixCell[] = [];
  for (const tier of TIER_ORDER) {
    for (const unit of unitIds) {
      const cell = cellMap.get(`${unit}\u0000${tier}`);
      if (cell) {
        cells.push({ unit, tier, files: cell.files, lines: cell.lines });
      }
    }
  }
  const perTier = TIER_ORDER.map((tier) => {
    const matching = files.filter((entry) => entry.tier === tier);
    return {
      tier,
      files: matching.length,
      lines: matching.reduce((total, entry) => total + entry.lines, 0),
      fileShare: files.length > 0 ? Number((matching.length / files.length).toFixed(3)) : 0,
    };
  }).filter((entry) => entry.files > 0);

  const tierOfFile = new Map(files.map((entry) => [entry.file, entry.tier]));
  const directions: TierDirection[] = [];
  for (const edge of graph.edges ?? []) {
    const sourceTier = tierOfFile.get(edge.source);
    const targetTier = tierOfFile.get(edge.target);
    if (!sourceTier || !targetTier) {
      continue;
    }
    const unit = assignment.get(edge.source) ?? '.';
    if ((assignment.get(edge.target) ?? '.') !== unit) {
      continue;
    }
    const sourceRank = TIER_RANK[sourceTier];
    const targetRank = TIER_RANK[targetTier];
    if (sourceRank === undefined || targetRank === undefined) {
      continue;
    }
    const base = {
      unit,
      source: edge.source,
      target: edge.target,
      sourceTier,
      targetTier,
      line: edge.evidence?.line ?? 0,
      specifier: edge.evidence?.specifier ?? '',
    };
    if (sourceRank < targetRank) {
      // A lower tier depends on an upper one: the arrow runs the wrong way.
      directions.push({ ...base, kind: 'upward' });
    } else if (sourceRank - targetRank > 1) {
      const intermediate = [...(unitTiers.get(unit) ?? [])].some((tier) => {
        const rank = TIER_RANK[tier];
        return rank !== undefined && rank < sourceRank && rank > targetRank;
      });
      // A skip is only a violation when the unit actually has a tier in between to use.
      if (intermediate) {
        directions.push({ ...base, kind: 'skip-layer' });
      }
    }
  }
  directions.sort(
    (a, b) => a.unit.localeCompare(b.unit) || a.line - b.line || a.source.localeCompare(b.source),
  );

  const tables = files
    .flatMap((entry) => entry.tables)
    .sort(
      (a, b) => a.table.localeCompare(b.table) || a.file.localeCompare(b.file) || a.line - b.line,
    );

  const tableTrace: TableTraceEntry[] = files
    .flatMap((entry) =>
      entry.tables.map((reference) => ({
        table: reference.table,
        file: entry.file,
        tier: entry.tier,
        unit: assignment.get(entry.file) ?? '.',
        line: reference.line,
        evidence: reference.evidence,
      })),
    )
    .sort(
      (a, b) => a.table.localeCompare(b.table) || a.file.localeCompare(b.file) || a.line - b.line,
    );

  // The top half of the trace. Calls are read from the files just classified (a second read,
  // bounded by the ceiling); endpoints come from the repository's OpenAPI documents, which are
  // not graph nodes, so their tier is classified from disk.
  const selectedSet = new Set(selected);
  const calls: TierCallSite[] = [];
  for (const file of selected) {
    if (!isSourceExtension(file)) {
      continue;
    }
    const content = readText(root, file);
    if (content === null) {
      continue;
    }
    for (const call of extractCallsFromContent(file, content)) {
      calls.push({
        file,
        tier: tierOfFile.get(file) ?? 'unclassified',
        unit: assignment.get(file) ?? '.',
        line: call.line,
        method: call.method,
        target: call.target,
        host: call.host,
        path: call.path,
      });
    }
  }
  calls.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.target.localeCompare(b.target),
  );

  const endpoints: TierEndpointSite[] = endpointDocs
    .map((endpoint) => {
      let tier = tierOfFile.get(endpoint.source) ?? 'unclassified';
      if (!selectedSet.has(endpoint.source)) {
        const content = readText(root, endpoint.source);
        if (content !== null) {
          tier = classifyTierContent(endpoint.source, content, declared).tier;
        }
      }
      return {
        file: endpoint.source,
        tier,
        unit: assignment.get(endpoint.source) ?? '.',
        method: endpoint.method,
        path: endpoint.path,
      };
    })
    .sort(
      (a, b) =>
        a.file.localeCompare(b.file) || a.method.localeCompare(b.method) || a.path.localeCompare(b.path),
    );

  const endpointByKey = new Map<string, TierEndpointSite>();
  for (const endpoint of endpoints) {
    const key = `${endpoint.method}\u0000${endpoint.path}`;
    if (!endpointByKey.has(key)) {
      endpointByKey.set(key, endpoint);
    }
  }
  const traces: TierTrace[] = calls.map((call) => ({
    call,
    endpoint:
      call.method && call.path ? endpointByKey.get(`${call.method}\u0000${call.path}`) ?? null : null,
  }));

  return {
    files,
    units: unitReports,
    matrix: { tiers: TIER_ORDER, units: unitIds, cells, perTier },
    directions,
    tables,
    tableTrace,
    calls,
    endpoints,
    traces,
    summary: { ...summary, total: files.length, mixed },
    skipped,
    truncated: all.length - selected.length,
  };
}

function languageOf(file: string): Language {
  const extension = path.extname(file).toLowerCase();
  if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) return 'js';
  if (extension === '.rs') return 'rust';
  if (extension === '.java') return 'java';
  if (extension === '.kt' || extension === '.kts') return 'kotlin';
  if (extension === '.cs') return 'csharp';
  if (extension === '.py') return 'python';
  if (extension === '.go') return 'go';
  if (['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h'].includes(extension)) return 'cpp';
  if (extension === '.sql') return 'sql';
  if (extension === '.proto') return 'proto';
  return 'other';
}

/** The import-ish lines of a file, joined, so a framework token is matched in an import. */
function importText(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) =>
      /^\s*(?:import|export|use|using|from|require|package|#include)\b/.test(line),
    )
    .join('\n');
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

function globToRegExp(glob: string): RegExp {
  const pattern = toPosix(glob.replace(/\\/g, '/'));
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(character)) {
      source += `\\${character}`;
    } else {
      source += character;
    }
  }
  return new RegExp(`^${source}$`);
}
