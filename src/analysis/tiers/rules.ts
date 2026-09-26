import type { Tier } from './types.ts';

export type Language = 'js' | 'rust' | 'java' | 'kotlin' | 'csharp' | 'python' | 'go' | 'cpp' | 'sql' | 'proto' | 'other';

export interface Rule {
  tier: Tier;
  /** Alternation of literal tokens, matched as a whole word. */
  pattern: RegExp;
}

export function words(tokens: readonly string[]): RegExp {
  const escaped = tokens
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
    .join('|');
  return new RegExp(`(?:^|[^\\w-])(?:${escaped})(?:$|[^\\w-])`, 'i');
}

/** Importers and frameworks per language, strongest evidence. */
export const FRAMEWORK_RULES: Partial<Record<Language, Rule[]>> = {
  js: [
    { tier: 'api', pattern: words(['express', 'fastify', 'koa', 'nestjs', '@nestjs', 'hapi', 'hono']) },
    { tier: 'frontend', pattern: words(['react', 'react-dom', 'next', 'nuxt', 'vue', 'svelte', 'angular', '@angular', 'solid-js', 'preact']) },
    { tier: 'data', pattern: words(['prisma', '@prisma', 'typeorm', 'sequelize', 'mongoose', 'knex', 'drizzle-orm', 'better-sqlite3', 'pg', 'mysql2']) },
    { tier: 'integration', pattern: words(['axios', 'node-fetch', 'got', 'undici', 'fetch', 'kafkajs', 'amqplib', 'ioredis']) },
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
  cpp: [
    { tier: 'frontend', pattern: words(['QtWidgets', 'QtQuick', 'QtQml', 'qml', 'wxWidgets', 'gtkmm', 'QtGui']) },
    { tier: 'api', pattern: words(['crow', 'httplib', 'drogon', 'pistache', 'oatpp', 'restinio', 'cpprestsdk', 'grpc++']) },
    { tier: 'data', pattern: words(['sqlite3', 'libpqxx', 'pqxx', 'mysql++', 'mysqlx', 'bsoncxx', 'mongocxx', 'rocksdb', 'sqlpp11']) },
    { tier: 'integration', pattern: words(['curl', 'cpr', 'boost/asio', 'boost/beast', 'grpc', 'zeromq']) },
  ],
};

/** Annotations and macros per language, next-strongest evidence. */
export const ANNOTATION_RULES: Partial<Record<Language, Rule[]>> = {
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

/**
 * Recorded route declarations: a call that names an HTTP verb and a path literal is an
 * endpoint this file serves. This is lexical like the call extractor, so the path literal
 * keeps an ordinary `map.get('/key')` out; a route whose path is dynamic records nothing.
 */
export const ROUTE_RULES: Partial<Record<Language, Rule[]>> = {
  js: [
    {
      tier: 'api',
      pattern: /(?:^|[^\w.])(?:app|router|server|api|route|routes)\s*\.\s*(?:get|post|put|patch|delete|options|head|all)\s*\(\s*['"`]\//,
    },
  ],
  go: [
    {
      tier: 'api',
      pattern: /(?:HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE)\s*\(\s*["`]\/[^"`]*["`]\s*,/,
    },
  ],
};

/** A test path or suffix, kept out of the file-name conventions below. */
export function isTestFile(file: string): boolean {
  return /(^|\/)(tests?|__tests__|specs?)\//i.test(file) || /\.(test|spec)\.[^/]+$/i.test(file);
}

/** File kinds: path and extension, stronger than a bare token but weaker than a framework. */
export const FILE_KIND_RULES: Array<{ tier: Tier; test: (file: string) => boolean; detail: string }> = [
  { tier: 'data', test: (file) => /\.sql$/i.test(file) || /(^|\/)migrations?\//i.test(file), detail: 'SQL or a migration' },
  { tier: 'data', test: (file) => /\.proto$/i.test(file), detail: 'a protobuf schema' },
  { tier: 'frontend', test: (file) => /\.(html?|css|scss|sass|less|vue|svelte)$/i.test(file), detail: 'a markup or stylesheet file' },
  { tier: 'api', test: (file) => /(^|\/)(openapi|swagger)[\w.-]*\.(json|ya?ml)$/i.test(file), detail: 'an OpenAPI document' },
  { tier: 'infra', test: (file) => /(^|\/)(dockerfile|docker-compose\.ya?ml)$/i.test(file), detail: 'a container definition' },
  { tier: 'infra', test: (file) => /(^|\/)(k8s|kubernetes|helm|charts|terraform)\//i.test(file) || /\.tf$/i.test(file), detail: 'infrastructure as code' },
  { tier: 'infra', test: (file) => /(^|\/)(\.editorconfig|\.gitignore|\.gitattributes|\.npmrc|\.nvmrc|\.dockerignore|\.env(?:\.[\w-]+)?)$/i.test(file), detail: 'a repository config file' },
  { tier: 'build', test: (file) => /(^|\/)\.github\/workflows\//i.test(file), detail: 'a CI workflow' },
  { tier: 'build', test: (file) => /(^|\/)(makefile|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|pom\.xml|cargo\.toml|go\.mod|pyproject\.toml|package\.json)$/i.test(file) || /(^|\/)tsconfig(?:\.[\w-]+)?\.json$/i.test(file) || /\.csproj$/i.test(file), detail: 'a build manifest' },
  { tier: 'tests', test: isTestFile, detail: 'a test path or suffix' },
];

/**
 * File-name conventions: a dotted or camel-case role word the file is named by
 * (`orders.controller.ts`, `UserRepository.java`). Weaker than a path kind, so a test
 * suffix still wins, but it catches the naming a framework's scaffolder produces.
 */
export const FILENAME_RULES: Array<{ tier: Tier; pattern: RegExp; detail: string }> = [
  {
    tier: 'api',
    pattern: /(^|\/)[\w.-]*\.(?:controller|router|routers|route|handler|handlers|resolver|middleware|endpoint)\.|[a-z0-9](?:Controller|Router|Handler|Resolver|Middleware|Endpoint)\.[^/]+$/i,
    detail: 'a controller or handler file name',
  },
  {
    tier: 'frontend',
    pattern: /(^|\/)[\w.-]*\.(?:component|page|screen|view|widget)\.|[a-z0-9](?:Component|Page|Screen|Widget)\.[^/]+$/i,
    detail: 'a component or page file name',
  },
  {
    tier: 'domain',
    pattern: /(^|\/)[\w.-]*\.(?:service|usecase|use-case|interactor|manager|policy)\.|[a-z0-9](?:Service|UseCase|Interactor|Manager|Policy)\.[^/]+$/i,
    detail: 'a service or use-case file name',
  },
  {
    tier: 'data',
    pattern: /(^|\/)[\w.-]*\.(?:repository|repo|dao|entity|model|schema|migration|store)\.|[a-z0-9](?:Repository|Dao|Entity|Model|Schema)\.[^/]+$/i,
    detail: 'a repository or entity file name',
  },
  {
    tier: 'integration',
    pattern: /(^|\/)[\w.-]*\.(?:client|adapter|gateway|provider|connector|transport)\.|[a-z0-9](?:Client|Adapter|Gateway|Provider|Connector)\.[^/]+$/i,
    detail: 'a client or adapter file name',
  },
];

/** Path tokens, the weakest evidence, used only when nothing stronger matched. */
export const PATH_TOKEN_RULES: Array<{ tier: Tier; tokens: string[] }> = [
  { tier: 'frontend', tokens: ['ui', 'screen', 'screens', 'component', 'components', 'pages', 'views', 'widgets', 'hooks', 'compose'] },
  { tier: 'api', tokens: ['handlers', 'handler', 'routes', 'router', 'controllers', 'controller', 'endpoints', 'api', 'server', 'graphql', 'rest'] },
  { tier: 'domain', tokens: ['domain', 'services', 'service', 'usecase', 'usecases', 'interactors', 'logic', 'core', 'engine', 'parser', 'parsers', 'rules'] },
  { tier: 'data', tokens: ['data', 'repository', 'repositories', 'dao', 'db', 'database', 'models', 'entities', 'persistence', 'store', 'stores', 'cache', 'caches', 'schema', 'schemas'] },
  { tier: 'integration', tokens: ['clients', 'client', 'integrations', 'integration', 'gateway', 'adapters', 'adapter', 'external', 'remote', 'sdk'] },
  { tier: 'infra', tokens: ['infra', 'config', 'configs', 'settings', 'deployment', 'deploy', 'ops'] },
  { tier: 'build', tokens: ['scripts', 'script', 'tools', 'tool', 'build', 'ci', 'bin', 'release', 'tasks'] },
];
