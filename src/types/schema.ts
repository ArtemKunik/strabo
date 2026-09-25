import type { SqlDialect } from './enums.ts';

/** Where a schema fact was declared, for evidence. */
export interface SchemaLocation {
  /** Repository-relative file. */
  file: string;
  line: number;
}

/** One column of a table, after every migration has been replayed. */
export interface SchemaColumn {
  name: string;
  /** Normalised type: `integer`, `varchar(255)`, `numeric(10,2)`, `timestamptz`. */
  type: string;
  /** False when the column is NOT NULL or part of the primary key. */
  nullable: boolean;
  /** The default expression as written, `serial`/`identity`/`auto-increment` for generated keys. */
  default?: string;
  /** Where the column was last declared or redefined. */
  declared: SchemaLocation;
}

/** A table-level rule: a key, a uniqueness rule, a foreign key, or a check. */
export interface SchemaConstraint {
  kind: 'primary-key' | 'unique' | 'foreign-key' | 'check';
  /** The name given in the migration, when there is one. */
  name?: string;
  /** Constrained columns; empty for a check that names none. */
  columns: string[];
  /** The referenced table and columns of a foreign key. */
  references?: { table: string; columns: string[]; onDelete?: string; onUpdate?: string };
  /** The expression of a check, as written. */
  expression?: string;
  declared: SchemaLocation;
}

export interface SchemaIndex {
  name?: string;
  columns: string[];
  unique: boolean;
  /** The predicate of a partial index, as written. */
  where?: string;
  declared: SchemaLocation;
}

export interface SchemaTable {
  /** Lower-case name; the default schema (`public`, `dbo`) is dropped. */
  name: string;
  columns: SchemaColumn[];
  constraints: SchemaConstraint[];
  indexes: SchemaIndex[];
  declared: SchemaLocation;
}

/** A statement the parser saw but could not apply, so the snapshot may be incomplete there. */
export interface SchemaGap {
  file: string;
  line: number;
  /** The statement's first words, e.g. `ALTER TABLE orders`. */
  statement: string;
  reason: string;
}

/** The schema a repository's SQL files describe once replayed in order. */
export interface SchemaSnapshot {
  repository: string;
  /** `live` is introspected from a running database, the others come from repository files. */
  origin: 'migrations' | 'dump' | 'live';
  /** The engine the SQL reads as, judged from its syntax; absent when there is no clue. */
  dialect?: SqlDialect;
  /** The SQL files applied, in the order they were replayed. */
  files: string[];
  tables: SchemaTable[];
  gaps: SchemaGap[];
  /** ISO time a live introspection was taken; absent for repository files. */
  capturedAt?: string;
}

/** What a piece of code does with a table: reads it, writes it, changes its shape, or is not recorded. */
export type DataAccess = 'read' | 'write' | 'ddl' | 'unknown';

/** One place source code names a data table, with the columns it names there. */
export interface CodeDataUse {
  repository: string;
  file: string;
  line: number;
  /** Lower-case table name, without the default schema. */
  table: string;
  /** Columns the code names for this table; only those the scan could attribute to it. */
  columns: string[];
  /** The rule that read it: string-literal SQL, an ORM annotation, or a macro. */
  evidence: string;
  /** `strong` for a statement shape or a mapping declaration, `weak` for a bare SELECT literal. */
  confidence: 'strong' | 'weak';
  /** What the code does with the table; `unknown` when the scan cannot tell read from write. */
  access: DataAccess;
}

/** Code that names a table or column no SQL file in the workspace declares. */
export interface SchemaUsageFinding {
  kind: 'unknown-table' | 'unknown-column';
  repository: string;
  file: string;
  line: number;
  table: string;
  column?: string;
  evidence: string;
  confidence: CodeDataUse['confidence'];
  /** Repositories whose schema declares the table, for an unknown column. */
  definedIn?: string[];
}

/** A table declared by more than one repository, with the columns that disagree. */
export interface SchemaDrift {
  table: string;
  repositories: string[];
  deviations: Array<{
    column: string;
    declared: Array<{ repository: string; type: string; nullable: boolean }>;
    issue: 'missing' | 'type' | 'nullable';
  }>;
}

export interface SchemaUsageReport {
  /** False when no repository declares a schema, so there was nothing to check against. */
  checked: boolean;
  uses: CodeDataUse[];
  findings: SchemaUsageFinding[];
  drift: SchemaDrift[];
}
