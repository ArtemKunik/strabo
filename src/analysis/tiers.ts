import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { toPosix } from '../boundary/repository-root.ts';
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

export interface TierClassification {
  file: string;
  tier: Tier;
  /** True when two tiers share the strongest evidence, so no single tier is claimed. */
  mixed: boolean;
  evidence: TierEvidence[];
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
    return { file, tier: 'unclassified', mixed: false, evidence: [] };
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
  };
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

export interface TierReport {
  files: TierClassification[];
  units: TierUnitReport[];
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
  graph: { nodes: Array<{ id: string }> },
): TierReport {
  const all = graph.nodes.map((node) => node.id).sort();
  const selected = all.slice(0, MAX_TIER_FILES);
  const declared = readDeclaredTiers(root);
  const { files, skipped } = classifyTiers(root, selected, declared);
  const tierOf = new Map(files.map((entry) => [entry.file, entry.tier]));

  const units = detectUnits(root, selected, repositoryName);
  const assignment = assignUnits(selected, units);
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

  return {
    files,
    units: unitReports,
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
