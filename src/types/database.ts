import type { SqlDialect } from './enums.ts';
import type { SchemaSnapshot } from './schema.ts';

/**
 * How a change treats the systems that already depend on the old shape.
 *
 * `breaking` fails an existing reader or writer whatever its role; `conditional` is safe for
 * one direction only and the reason names which; `safe` needs nothing from anyone.
 */
export type Compatibility = 'breaking' | 'conditional' | 'safe';

/** One difference between two revisions of a contract or a database schema. */
export interface CompatChange {
  subject: 'contract' | 'schema';
  /** The contract id, or the table name. */
  id: string;
  target: 'contract' | 'field' | 'table' | 'column' | 'constraint' | 'index';
  /** The field, column, constraint or index the change is about. */
  name?: string;
  change: 'added' | 'removed' | 'type-changed' | 'required-changed' | 'nullability-changed' | 'default-changed' | 'modified';
  compatibility: Compatibility;
  before?: string;
  after?: string;
  /** Why it is classified this way, naming the direction when the answer depends on one. */
  reason: string;
  /** Where the element is declared: at head, or at base for a removal. */
  file?: string;
  line?: number;
  /** Code that still names a removed element, or writes without a newly required one. */
  references?: Array<{ repository: string; file: string; line: number }>;
  /** Other repositories that declare the same contract and would see the change. */
  consumers?: string[];
}

/** The compatibility of one repository between two revisions. */
export interface CompatReport {
  repository: string;
  /** The revision changes are measured from. */
  base: string;
  /** The revision measured to; `working tree` when none was given. */
  head: string;
  changes: CompatChange[];
  summary: { breaking: number; conditional: number; safe: number };
  /** Set when a side could not be read; the report then holds no changes. */
  unavailable?: string;
}

/**
 * A database the operator lets Strabo probe, read-only. The connection string is never in the
 * config: `urlEnv` names the environment variable that holds it.
 */
export interface DatabaseConfig {
  name: string;
  dialect: 'postgres';
  urlEnv: string;
}

/** What running a preflight query against a real database found. */
export interface PreflightResult {
  /** `ok` means zero rows would break it; `violations` that some would; `error` that it did not run. */
  status: 'ok' | 'violations' | 'error';
  violations?: number;
  error?: string;
  /** ISO time the query ran. */
  ranAt: string;
  durationMs?: number;
  /** The declared database it ran against. */
  database: string;
}

/** A read-only query that counts the rows one operation of a migration would trip over. */
export interface PreflightCheck {
  id: string;
  table: string;
  column?: string;
  operation:
    | 'add-not-null-column'
    | 'set-not-null'
    | 'add-unique'
    | 'add-primary-key'
    | 'add-foreign-key'
    | 'add-check'
    | 'convert-type'
    | 'drop-column'
    | 'drop-table';
  description: string;
  /** `blocks`: a count above zero makes the migration fail. `data-loss`: the count is what is lost. */
  severity: 'blocks' | 'data-loss';
  /** What a non-zero `violations` means for this operation, in words. */
  failsWhen: string;
  /** One row, one column named `violations`. Read-only; no user text reaches it unquoted. */
  sql: string;
  /** True when the query stands in for the database's own cast or engine rules. */
  approximate?: boolean;
  /** Where the migration declares the operation. */
  file?: string;
  line?: number;
  /** Code that still names what a drop removes. */
  references?: Array<{ repository: string; file: string; line: number }>;
  result?: PreflightResult;
}

/** An operation the preflight could not turn into a query, and why. */
export interface PreflightSkip {
  table: string;
  column?: string;
  operation: string;
  reason: string;
  file?: string;
  line?: number;
}

/** One place a live database and a repository's migrations disagree. */
export interface LiveDrift {
  /** The repository whose migrations were compared. */
  repository: string;
  table: string;
  column?: string;
  kind:
    | 'table-not-in-live'
    | 'table-not-in-repository'
    | 'column-not-in-live'
    | 'column-not-in-repository'
    | 'type'
    | 'nullability';
  /** The value in the live database, where the kind has one. */
  live?: string;
  /** The value the repository's migrations declare, where the kind has one. */
  declared?: string;
}

/** A live database's schema, and where it disagrees with each repository's migrations. */
export interface LiveSchemaReport {
  database: string;
  capturedAt: string;
  tables: number;
  /** The live schema in the same shape as a repository's; null when the database has no tables. */
  snapshot: SchemaSnapshot | null;
  drift: LiveDrift[];
}

export interface PreflightReport {
  repository: string;
  base: string;
  head: string;
  dialect: SqlDialect;
  checks: PreflightCheck[];
  skipped: PreflightSkip[];
  unavailable?: string;
}
