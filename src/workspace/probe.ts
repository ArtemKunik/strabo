import type {
  DatabaseConfig,
  LiveDrift,
  PreflightCheck,
  PreflightReport,
  PreflightResult,
  SchemaSnapshot,
} from '../types.ts';
import { buildSchema } from './schema.ts';

/**
 * Read-only access to a live database, for the preflight and for schema drift.
 *
 * The probe is opt-in and narrow by construction:
 *
 * - The connection string comes from the environment variable a declared database names, is
 *   read when a run starts, and is never stored, logged, or returned. Errors are scrubbed of it.
 * - Every statement runs in its own `READ ONLY` transaction with a statement timeout, and the
 *   session itself is read-only, so a bug here cannot write.
 * - Only statements Strabo generated are ever sent: the API takes a revision and a database
 *   name, never SQL. A last guard still refuses anything that is not a single plain SELECT.
 * - Only counts and catalog metadata come back. No table row is read.
 */

export class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeError';
  }
}

/** One connection. `query` returns rows as plain objects. */
export interface DatabaseSession {
  query(sql: string): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}

export interface DatabaseDriver {
  connect(url: string, options: { statementTimeoutMs: number }): Promise<DatabaseSession>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_CHECKS = 200;

/**
 * The PostgreSQL driver, loaded from `pg` on first use.
 *
 * `pg` is an optional peer dependency: Strabo installs and runs without it, and a workspace
 * that never probes a database never loads it. Without it, the error says what to install.
 */
export function createPostgresDriver(load: () => Promise<unknown> = defaultLoad): DatabaseDriver {
  return {
    async connect(url, options): Promise<DatabaseSession> {
      let module: { Client?: unknown; default?: { Client?: unknown } };
      try {
        module = (await load()) as typeof module;
      } catch {
        throw new ProbeError('The PostgreSQL driver is not installed. Add it with `npm install pg` next to Strabo.');
      }
      const Client = (module.Client ?? module.default?.Client) as
        | (new (config: Record<string, unknown>) => PgClient)
        | undefined;
      if (!Client) {
        throw new ProbeError('The installed "pg" package does not expose a Client.');
      }
      const client = new Client({
        connectionString: url,
        connectionTimeoutMillis: 10_000,
        application_name: 'strabo-probe',
        options: '-c default_transaction_read_only=on',
      });
      await client.connect();
      return {
        async query(sql): Promise<Array<Record<string, unknown>>> {
          assertReadOnlyQuery(sql);
          await client.query('BEGIN READ ONLY');
          try {
            await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(options.statementTimeoutMs))}`);
            const result = await client.query(sql);
            return result.rows;
          } finally {
            await client.query('ROLLBACK').catch(() => undefined);
          }
        },
        async close(): Promise<void> {
          await client.end().catch(() => undefined);
        },
      };
    },
  };
}

interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

function defaultLoad(): Promise<unknown> {
  // A variable specifier keeps the compiler and bundlers from resolving the optional package.
  const specifier = 'pg';
  return import(specifier);
}

/** Words a read-only count never needs. A match refuses the statement; a miss proves nothing. */
const FORBIDDEN =
  /\b(?:insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|reindex|lock|listen|notify|set|reset|nextval|setval|set_config|pg_sleep|pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export|dblink|pg_terminate_backend|pg_cancel_backend)\b/i;

/** Refuse anything but one plain SELECT. The transaction is read-only either way. */
export function assertReadOnlyQuery(sql: string): void {
  const trimmed = sql.trim();
  if (!/^SELECT\b/i.test(trimmed) || /;|--|\/\*/.test(trimmed) || FORBIDDEN.test(trimmed)) {
    throw new ProbeError('Refusing to send a statement that is not a single read-only SELECT.');
  }
}

/** A run that reports what happened to every check. */
export interface RunOptions {
  database: DatabaseConfig;
  driver: DatabaseDriver;
  env?: NodeJS.ProcessEnv;
  statementTimeoutMs?: number;
  now?: () => Date;
}

/** Whether the environment variable a database names is set, without revealing its value. */
export function databaseConfigured(database: DatabaseConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env[database.urlEnv] === 'string' && (env[database.urlEnv] ?? '').trim() !== '';
}

/**
 * Run a preflight's checks against a database and record each result.
 *
 * A check that cannot run (the engine refused it, it timed out) is an `error` result with a
 * scrubbed message, not a pass: the report never turns "could not check" into "safe".
 */
export async function runPreflight(report: PreflightReport, options: RunOptions): Promise<PreflightReport> {
  const env = options.env ?? process.env;
  const url = (env[options.database.urlEnv] ?? '').trim();
  if (url === '') {
    throw new ProbeError(`The environment variable ${options.database.urlEnv} is not set.`);
  }
  const now = options.now ?? ((): Date => new Date());
  const timeout = options.statementTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const session = await connect(options.driver, url, timeout);
  try {
    const checks: PreflightCheck[] = [];
    for (const check of report.checks.slice(0, MAX_CHECKS)) {
      const result = await runOne(session, check, options.database.name, url, now);
      checks.push({ ...check, result });
    }
    return { ...report, checks };
  } finally {
    await session.close();
  }
}

async function runOne(
  session: DatabaseSession,
  check: PreflightCheck,
  database: string,
  url: string,
  now: () => Date,
): Promise<PreflightResult> {
  const started = Date.now();
  const ranAt = now().toISOString();
  try {
    const rows = await session.query(check.sql);
    const violations = Number(rows[0]?.violations);
    if (!Number.isFinite(violations)) {
      return { status: 'error', error: 'The query did not return a count.', ranAt, database };
    }
    return {
      status: violations > 0 ? 'violations' : 'ok',
      violations,
      ranAt,
      durationMs: Date.now() - started,
      database,
    };
  } catch (error) {
    return { status: 'error', error: scrub(error, url), ranAt, durationMs: Date.now() - started, database };
  }
}

async function connect(driver: DatabaseDriver, url: string, timeout: number): Promise<DatabaseSession> {
  try {
    return await driver.connect(url, { statementTimeoutMs: timeout });
  } catch (error) {
    if (error instanceof ProbeError) {
      throw error;
    }
    throw new ProbeError(`Could not connect: ${scrub(error, url)}`);
  }
}

/** An error message with the connection string, its credentials, and any userinfo removed. */
export function scrub(error: unknown, url: string): string {
  let message = error instanceof Error ? error.message : String(error);
  const secrets = new Set<string>([url]);
  try {
    const parsed = new URL(url);
    for (const part of [parsed.password, decodeURIComponent(parsed.password), parsed.username]) {
      if (part.length >= 3) {
        secrets.add(part);
      }
    }
  } catch {
    // A URL that does not parse is scrubbed as a whole string only.
  }
  for (const secret of secrets) {
    message = message.split(secret).join('***');
  }
  return message.replace(/:\/\/[^@\s/]*@/g, '://***@').slice(0, 300);
}

// ---------------------------------------------------------------------------------------
// Live schema
// ---------------------------------------------------------------------------------------

const SYSTEM_SCHEMAS = `('pg_catalog', 'information_schema')`;

const COLUMNS_SQL = `SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name,
  format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
  pg_get_expr(d.adbin, d.adrelid) AS default_expr, a.attidentity AS identity, a.attgenerated AS generated
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ${SYSTEM_SCHEMAS} AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY n.nspname, c.relname, a.attnum
LIMIT 50000`;

const CONSTRAINTS_SQL = `SELECT n.nspname AS schema_name, c.relname AS table_name, con.conname AS name,
  pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE con.contype IN ('p', 'u', 'f', 'c') AND c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ${SYSTEM_SCHEMAS} AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY n.nspname, c.relname, con.conname
LIMIT 50000`;

const INDEXES_SQL = `SELECT schemaname AS schema_name, tablename AS table_name, indexname AS name, indexdef AS definition
FROM pg_indexes
WHERE schemaname NOT IN ${SYSTEM_SCHEMAS} AND schemaname NOT LIKE 'pg_toast%'
ORDER BY schemaname, tablename, indexname
LIMIT 50000`;

/**
 * Read a live PostgreSQL schema and return it in the same shape the migration files produce.
 *
 * The catalog is turned into DDL and replayed through the same parser as the repository's
 * SQL, so a type, a default, and a constraint are normalised identically on both sides and a
 * comparison is between like and like. Only catalog metadata is read; no table row is.
 */
export async function introspectPostgres(
  session: DatabaseSession,
  database: string,
  now: () => Date = () => new Date(),
): Promise<SchemaSnapshot | null> {
  const columns = await session.query(COLUMNS_SQL);
  const constraints = await session.query(CONSTRAINTS_SQL);
  const indexes = await session.query(INDEXES_SQL);

  const tables = new Map<string, string[]>();
  for (const row of columns) {
    const key = qualified(row.schema_name, row.table_name);
    const parts = tables.get(key) ?? [];
    parts.push(columnDefinition(row));
    tables.set(key, parts);
  }
  const statements: string[] = [];
  for (const [table, parts] of tables) {
    statements.push(`CREATE TABLE ${table} (\n  ${parts.join(',\n  ')}\n);`);
  }
  const constraintNames = new Set<string>();
  for (const row of constraints) {
    constraintNames.add(`${qualified(row.schema_name, row.table_name)}.${String(row.name)}`);
    statements.push(
      `ALTER TABLE ${qualified(row.schema_name, row.table_name)} ADD CONSTRAINT ${quoteIdent(row.name)} ${definition(row.definition)};`,
    );
  }
  for (const row of indexes) {
    // The index behind a primary key or unique constraint is already that constraint.
    if (constraintNames.has(`${qualified(row.schema_name, row.table_name)}.${String(row.name)}`)) {
      continue;
    }
    statements.push(`${definition(row.definition)};`);
  }

  const snapshot = buildSchema(database, [{ path: `live:${database}`, content: statements.join('\n') }]);
  if (!snapshot) {
    return null;
  }
  return { ...snapshot, origin: 'live', dialect: 'postgres', capturedAt: now().toISOString() };
}

function columnDefinition(row: Record<string, unknown>): string {
  const name = quoteIdent(row.column_name);
  const type = String(row.type ?? 'unknown');
  const notNull = row.not_null === true ? ' NOT NULL' : '';
  if (row.identity === 'a' || row.identity === 'd') {
    return `${name} ${type}${notNull} GENERATED ALWAYS AS IDENTITY`;
  }
  if (row.generated === 's') {
    return `${name} ${type}${notNull} GENERATED ALWAYS AS (0) STORED`;
  }
  const expression = typeof row.default_expr === 'string' ? row.default_expr : '';
  // A sequence-backed default is what a migration's SERIAL means, so it reads as one.
  const fallback = /^nextval\(/i.test(expression) ? ' DEFAULT serial' : expression ? ` DEFAULT ${expression}` : '';
  return `${name} ${type}${notNull}${fallback}`;
}

function qualified(schema: unknown, table: unknown): string {
  return schema === 'public' ? quoteIdent(table) : `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

function quoteIdent(value: unknown): string {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

/** A catalog definition with anything that could end the synthetic statement removed. */
function definition(value: unknown): string {
  return String(value ?? '').replaceAll(';', ' ');
}

/** Tables a migration tool keeps for itself; the repository never declares them. */
const TOOL_TABLE =
  /^(?:flyway_schema_history|schema_migrations|__diesel_schema_migrations|_sqlx_migrations|alembic_version|django_migrations|knex_migrations(?:_lock)?|schema_version|databasechangelog(?:lock)?)$/;

/**
 * Compare a live schema with what a repository's migrations declare.
 *
 * Neither side is "right": the report says where they differ, in both directions, so a
 * migration that was never applied and a change made by hand in the database both show up.
 */
export function compareLiveSchema(live: SchemaSnapshot, repository: SchemaSnapshot): LiveDrift[] {
  const drift: LiveDrift[] = [];
  const liveTables = new Map(live.tables.map((table) => [table.name, table]));
  const repoTables = new Map(repository.tables.map((table) => [table.name, table]));
  const at = repository.repository;

  for (const [name, table] of repoTables) {
    const found = liveTables.get(name);
    if (!found) {
      drift.push({ repository: at, table: name, kind: 'table-not-in-live' });
      continue;
    }
    const liveColumns = new Map(found.columns.map((column) => [column.name, column]));
    const repoColumns = new Map(table.columns.map((column) => [column.name, column]));
    for (const [column, declared] of repoColumns) {
      const actual = liveColumns.get(column);
      if (!actual) {
        drift.push({ repository: at, table: name, column, kind: 'column-not-in-live', declared: declared.type });
        continue;
      }
      if (actual.type !== declared.type) {
        drift.push({ repository: at, table: name, column, kind: 'type', live: actual.type, declared: declared.type });
      }
      if (actual.nullable !== declared.nullable) {
        drift.push({
          repository: at,
          table: name,
          column,
          kind: 'nullability',
          live: actual.nullable ? 'nullable' : 'not null',
          declared: declared.nullable ? 'nullable' : 'not null',
        });
      }
    }
    for (const [column, actual] of liveColumns) {
      if (!repoColumns.has(column)) {
        drift.push({ repository: at, table: name, column, kind: 'column-not-in-repository', live: actual.type });
      }
    }
  }
  for (const name of liveTables.keys()) {
    if (!repoTables.has(name) && !TOOL_TABLE.test(name)) {
      drift.push({ repository: at, table: name, kind: 'table-not-in-repository' });
    }
  }
  return drift.sort(
    (a, b) => a.table.localeCompare(b.table) || (a.column ?? '').localeCompare(b.column ?? '') || a.kind.localeCompare(b.kind),
  );
}
