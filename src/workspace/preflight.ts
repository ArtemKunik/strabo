import type {
  CodeDataUse,
  PreflightCheck,
  PreflightReport,
  PreflightSkip,
  SchemaColumn,
  SchemaConstraint,
  SchemaIndex,
  SchemaSnapshot,
  SchemaTable,
  SqlDialect,
} from '../types.ts';
import { readRevisionFacts, readWorkingFacts, schemaTypeWidens } from './compat.ts';
import { RevisionError } from './revision.ts';
import { constraintSignature } from './schema.ts';

export interface PreflightInput {
  repository: string;
  root: string;
  base: string;
  head?: string;
  /** Force an engine; otherwise the one the SQL reads as, else PostgreSQL. */
  dialect?: SqlDialect;
  /** Code across the workspace, for naming what still uses a dropped column or table. */
  uses?: CodeDataUse[];
}

/** Read both revisions and build the preflight between them. */
export async function analyzePreflight(input: PreflightInput): Promise<PreflightReport> {
  const headLabel = input.head ?? 'working tree';
  try {
    const before = await readRevisionFacts(input.root, input.repository, input.base);
    const after = input.head
      ? await readRevisionFacts(input.root, input.repository, input.head)
      : readWorkingFacts(input.root, input.repository);
    return {
      repository: input.repository,
      base: input.base,
      head: headLabel,
      ...buildPreflight(before.schema, after.schema, {
        ...(input.dialect ? { dialect: input.dialect } : {}),
        uses: input.uses ?? [],
      }),
    };
  } catch (error) {
    if (error instanceof RevisionError) {
      return {
        repository: input.repository,
        base: input.base,
        head: headLabel,
        dialect: input.dialect ?? 'postgres',
        checks: [],
        skipped: [],
        unavailable: error.message,
      };
    }
    throw error;
  }
}

/**
 * Turn the difference between two schema snapshots into read-only queries that count the
 * rows each risky operation would trip over.
 *
 * Only operations on a table that already exists can fail on data: a new table is empty. An
 * operation that involves a column the base did not have is skipped for the same reason, and
 * an operation the preflight cannot express as a query is listed with its reason rather than
 * dropped, so silence never means safe.
 */
export function buildPreflight(
  base: SchemaSnapshot | null,
  head: SchemaSnapshot | null,
  options: { dialect?: SqlDialect; uses?: CodeDataUse[] } = {},
): Pick<PreflightReport, 'dialect' | 'checks' | 'skipped'> {
  const dialect = options.dialect ?? head?.dialect ?? base?.dialect ?? 'postgres';
  const uses = options.uses ?? [];
  const checks: PreflightCheck[] = [];
  const skipped: PreflightSkip[] = [];
  const context: Context = { dialect, uses, checks, skipped };

  const before = new Map((base?.tables ?? []).map((table) => [table.name, table]));
  const after = new Map((head?.tables ?? []).map((table) => [table.name, table]));

  for (const [name, table] of before) {
    try {
      const next = after.get(name);
      if (!next) {
        dropTable(context, table);
      } else {
        compareTable(context, table, next, after);
      }
    } catch {
      // A name that cannot be embedded safely is left out and said so, not guessed at.
      skip(context, name, 'all operations', 'the table or a column name is not a plain identifier, so no query is generated', table.declared);
    }
  }

  const order = (check: PreflightCheck): number => (check.severity === 'blocks' ? 0 : 1);
  checks.sort((a, b) => order(a) - order(b) || a.table.localeCompare(b.table) || a.id.localeCompare(b.id));
  return { dialect, checks, skipped };
}

interface Context {
  dialect: SqlDialect;
  uses: CodeDataUse[];
  checks: PreflightCheck[];
  skipped: PreflightSkip[];
}

function compareTable(context: Context, before: SchemaTable, after: SchemaTable, tables: Map<string, SchemaTable>): void {
  const existing = new Set(before.columns.map((column) => column.name));
  const beforeColumns = new Map(before.columns.map((column) => [column.name, column]));
  const afterColumns = new Map(after.columns.map((column) => [column.name, column]));

  for (const column of before.columns) {
    if (!afterColumns.has(column.name)) {
      dropColumn(context, before.name, column);
    }
  }

  for (const column of after.columns) {
    const previous = beforeColumns.get(column.name);
    if (!previous) {
      if (!column.nullable && column.default === undefined) {
        addNotNullColumn(context, after.name, column);
      }
      continue;
    }
    if (previous.nullable && !column.nullable) {
      setNotNull(context, after.name, column);
    }
    if (previous.type !== column.type && !schemaTypeWidens(previous.type, column.type)) {
      convertType(context, after.name, previous, column);
    }
  }

  const beforeSignatures = new Set(before.constraints.map(constraintSignature));
  for (const constraint of after.constraints) {
    if (beforeSignatures.has(constraintSignature(constraint))) {
      continue;
    }
    const involved = constraint.kind === 'check' && constraint.columns.length === 0 ? [] : constraint.columns;
    if (involved.some((column) => !existing.has(column))) {
      skip(context, after.name, constraint.kind, 'it involves a column the base does not have, so no existing row can violate it', constraint.declared);
      continue;
    }
    addConstraint(context, after.name, constraint, tables);
  }

  const beforeIndexes = new Set(before.indexes.map(indexKey));
  for (const index of after.indexes) {
    if (!index.unique || beforeIndexes.has(indexKey(index))) {
      continue;
    }
    if (index.columns.some((column) => !existing.has(column))) {
      if (index.columns.every((column) => /^[a-z_][a-z0-9_$]*$/.test(column))) {
        skip(context, after.name, 'unique index', 'it involves a column the base does not have', index.declared);
      } else {
        skip(context, after.name, 'unique index', 'an expression index cannot be checked as a column list', index.declared);
      }
      continue;
    }
    addUnique(context, after.name, index.columns, index.where, index.declared, index.name);
  }
}

function indexKey(index: SchemaIndex): string {
  return `${index.unique ? 'unique:' : ''}${index.columns.join(',')}${index.where ? `|${index.where}` : ''}`;
}

// ---------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------

function addNotNullColumn(context: Context, table: string, column: SchemaColumn): void {
  if (context.dialect === 'mysql') {
    skip(context, table, 'add not-null column', 'MySQL fills existing rows with the type default', column.declared, column.name);
    return;
  }
  const t = ident(table, context.dialect);
  push(context, {
    id: `add-not-null-column:${table}.${column.name}`,
    table,
    column: column.name,
    operation: 'add-not-null-column',
    description: `Add ${column.name} (${column.type}) as NOT NULL with no default to ${table}.`,
    severity: 'blocks',
    failsWhen: 'the table has any row: existing rows have no value for the new column.',
    sql: `SELECT COUNT(*) AS violations FROM ${t}`,
    at: column.declared,
  });
}

function setNotNull(context: Context, table: string, column: SchemaColumn): void {
  const t = ident(table, context.dialect);
  const c = ident(column.name, context.dialect);
  push(context, {
    id: `set-not-null:${table}.${column.name}`,
    table,
    column: column.name,
    operation: 'set-not-null',
    description: `Make ${table}.${column.name} NOT NULL.`,
    severity: 'blocks',
    failsWhen: 'rows hold NULL in the column.',
    sql: `SELECT COUNT(*) AS violations FROM ${t} WHERE ${c} IS NULL`,
    at: column.declared,
  });
}

function addConstraint(context: Context, table: string, constraint: SchemaConstraint, tables: Map<string, SchemaTable>): void {
  switch (constraint.kind) {
    case 'unique':
      addUnique(context, table, constraint.columns, undefined, constraint.declared, constraint.name);
      break;
    case 'primary-key':
      addPrimaryKey(context, table, constraint);
      break;
    case 'foreign-key':
      addForeignKey(context, table, constraint, tables);
      break;
    case 'check':
      addCheck(context, table, constraint);
      break;
  }
}

function addUnique(
  context: Context,
  table: string,
  columns: string[],
  where: string | undefined,
  at: { file: string; line: number },
  name?: string,
): void {
  const list = identList(columns, context.dialect);
  if (!list) {
    skip(context, table, 'unique', 'an expression cannot be checked as a column list', at);
    return;
  }
  if (where !== undefined && !safeExpression(where)) {
    skip(context, table, 'unique', 'the partial-index predicate contains text the preflight will not embed', at);
    return;
  }
  const t = ident(table, context.dialect);
  const present = list.map((column) => `${column} IS NOT NULL`).join(' AND ');
  const predicate = where ? ` AND (${where})` : '';
  push(context, {
    id: `add-unique:${table}(${columns.join(',')})${name ? `:${name}` : ''}`,
    table,
    operation: 'add-unique',
    description: `Add a unique rule on ${table} (${columns.join(', ')})${where ? ` where ${where}` : ''}.`,
    severity: 'blocks',
    failsWhen: 'the same key appears in more than one row. The count is the number of duplicated keys; rows with a NULL part are ignored, as the engine ignores them.',
    sql: `SELECT COUNT(*) AS violations FROM (SELECT 1 FROM ${t} WHERE ${present}${predicate} GROUP BY ${list.join(', ')} HAVING COUNT(*) > 1) AS duplicates`,
    at,
  });
}

function addPrimaryKey(context: Context, table: string, constraint: SchemaConstraint): void {
  const list = identList(constraint.columns, context.dialect);
  if (!list) {
    skip(context, table, 'primary key', 'an expression cannot be checked as a column list', constraint.declared);
    return;
  }
  const t = ident(table, context.dialect);
  const anyNull = list.map((column) => `${column} IS NULL`).join(' OR ');
  push(context, {
    id: `add-primary-key:${table}(${constraint.columns.join(',')})`,
    table,
    operation: 'add-primary-key',
    description: `Make (${constraint.columns.join(', ')}) the primary key of ${table}.`,
    severity: 'blocks',
    failsWhen: 'a key part is NULL, or the same key appears in more than one row. The count is the NULL rows plus the duplicated keys.',
    sql:
      `SELECT (SELECT COUNT(*) FROM ${t} WHERE ${anyNull}) + ` +
      `(SELECT COUNT(*) FROM (SELECT 1 FROM ${t} GROUP BY ${list.join(', ')} HAVING COUNT(*) > 1) AS duplicates) AS violations`,
    at: constraint.declared,
  });
}

function addForeignKey(context: Context, table: string, constraint: SchemaConstraint, tables: Map<string, SchemaTable>): void {
  const references = constraint.references;
  if (!references) {
    return;
  }
  const parent = tables.get(references.table);
  let parentColumns = references.columns;
  if (parentColumns.length === 0) {
    parentColumns = parent?.constraints.find((entry) => entry.kind === 'primary-key')?.columns ?? [];
  }
  const childList = identList(constraint.columns, context.dialect);
  const parentList = identList(parentColumns, context.dialect);
  if (!childList || !parentList || childList.length !== parentList.length) {
    skip(context, table, 'foreign key', `the columns of ${references.table} it points at are not recorded`, constraint.declared);
    return;
  }
  const child = ident(table, context.dialect);
  const target = ident(references.table, context.dialect);
  const present = childList.map((column) => `child.${column} IS NOT NULL`).join(' AND ');
  const match = parentList.map((column, index) => `parent.${column} = child.${childList[index]}`).join(' AND ');
  push(context, {
    id: `add-foreign-key:${table}(${constraint.columns.join(',')})->${references.table}`,
    table,
    operation: 'add-foreign-key',
    description: `Add a foreign key from ${table} (${constraint.columns.join(', ')}) to ${references.table} (${parentColumns.join(', ')}).`,
    severity: 'blocks',
    failsWhen: `rows point at a ${references.table} row that does not exist (orphans).`,
    sql: `SELECT COUNT(*) AS violations FROM ${child} AS child WHERE ${present} AND NOT EXISTS (SELECT 1 FROM ${target} AS parent WHERE ${match})`,
    at: constraint.declared,
  });
}

function addCheck(context: Context, table: string, constraint: SchemaConstraint): void {
  const expression = constraint.expression ?? '';
  if (!safeExpression(expression)) {
    skip(context, table, 'check', 'the expression contains text the preflight will not embed', constraint.declared);
    return;
  }
  const t = ident(table, context.dialect);
  push(context, {
    id: `add-check:${table}:${expression.replace(/\s+/g, '')}`,
    table,
    operation: 'add-check',
    description: `Add the check (${expression}) to ${table}.`,
    severity: 'blocks',
    failsWhen: 'rows do not satisfy the expression. A row where it evaluates to NULL passes, as the engine treats it.',
    sql: `SELECT COUNT(*) AS violations FROM ${t} WHERE NOT (${expression})`,
    at: constraint.declared,
  });
}

function dropColumn(context: Context, table: string, column: SchemaColumn): void {
  const t = ident(table, context.dialect);
  const c = ident(column.name, context.dialect);
  push(context, {
    id: `drop-column:${table}.${column.name}`,
    table,
    column: column.name,
    operation: 'drop-column',
    description: `Drop ${table}.${column.name}.`,
    severity: 'data-loss',
    failsWhen: 'rows hold a value in the column; that data is deleted.',
    sql: `SELECT COUNT(${c}) AS violations FROM ${t}`,
    at: column.declared,
    references: referencesFor(context.uses, table, column.name),
  });
}

function dropTable(context: Context, table: SchemaTable): void {
  const t = ident(table.name, context.dialect);
  push(context, {
    id: `drop-table:${table.name}`,
    table: table.name,
    operation: 'drop-table',
    description: `Drop the table ${table.name}.`,
    severity: 'data-loss',
    failsWhen: 'the table has rows; they are deleted.',
    sql: `SELECT COUNT(*) AS violations FROM ${t}`,
    at: table.declared,
    references: referencesFor(context.uses, table.name, null),
  });
}

function referencesFor(uses: CodeDataUse[], table: string, column: string | null): PreflightCheck['references'] {
  return uses
    .filter((use) => use.table === table && (column === null || use.columns.includes(column)))
    .map((use) => ({ repository: use.repository, file: use.file, line: use.line }));
}

// ---------------------------------------------------------------------------------------
// Type conversion
// ---------------------------------------------------------------------------------------

const INTEGER_RANGE: Record<string, { min: string; max: string }> = {
  smallint: { min: '-32768', max: '32767' },
  integer: { min: '-2147483648', max: '2147483647' },
  bigint: { min: '-9223372036854775808', max: '9223372036854775807' },
};
const TEXTUAL = /^(?:text|varchar(?:\(\d+\))?|char(?:\(\d+\))?)$/;

function convertType(context: Context, table: string, before: SchemaColumn, after: SchemaColumn): void {
  const t = ident(table, context.dialect);
  const c = ident(after.name, context.dialect);
  const base = {
    id: `convert-type:${table}.${after.name}:${before.type}->${after.type}`,
    table,
    column: after.name,
    operation: 'convert-type' as const,
    description: `Change ${table}.${after.name} from ${before.type} to ${after.type}.`,
    severity: 'blocks' as const,
    at: after.declared,
  };

  const length = /^(?:varchar|char)\((\d+)\)$/.exec(after.type)?.[1];
  if (length && TEXTUAL.test(before.type)) {
    const fn = context.dialect === 'mysql' ? 'CHAR_LENGTH' : 'LENGTH';
    push(context, {
      ...base,
      failsWhen: `values are longer than ${length} characters and would be truncated or rejected.`,
      sql: `SELECT COUNT(*) AS violations FROM ${t} WHERE ${fn}(${c}) > ${length}`,
    });
    return;
  }

  const target = INTEGER_RANGE[after.type];
  if (target && INTEGER_RANGE[before.type]) {
    push(context, {
      ...base,
      failsWhen: `values fall outside ${after.type} (${target.min} to ${target.max}).`,
      sql: `SELECT COUNT(*) AS violations FROM ${t} WHERE ${c} < ${target.min} OR ${c} > ${target.max}`,
    });
    return;
  }
  if (target && TEXTUAL.test(before.type)) {
    const notInteger =
      context.dialect === 'mysql'
        ? `${c} NOT REGEXP '^[[:space:]]*[+-]?[0-9]+[[:space:]]*$'`
        : context.dialect === 'sqlite'
          ? `CAST(CAST(${c} AS INTEGER) AS TEXT) <> ${c}`
          : `${c} !~ '^\\s*[+-]?[0-9]+\\s*$'`;
    push(context, {
      ...base,
      failsWhen: `text values are not whole numbers. Their range is not checked, and the count is only as exact as the engine's own cast.`,
      sql: `SELECT COUNT(*) AS violations FROM ${t} WHERE ${c} IS NOT NULL AND ${notInteger}`,
      approximate: true,
    });
    return;
  }

  const decimal = /^numeric\((\d+),(\d+)\)$/.exec(after.type);
  if (decimal && (before.type.startsWith('numeric') || INTEGER_RANGE[before.type] || before.type === 'double' || before.type === 'real')) {
    const whole = Number(decimal[1]) - Number(decimal[2]);
    if (whole >= 0 && whole <= 38) {
      push(context, {
        ...base,
        failsWhen: `values need more than ${whole} digits before the decimal point and overflow ${after.type}. Digits lost after the point are rounded, not rejected.`,
        sql: `SELECT COUNT(*) AS violations FROM ${t} WHERE ABS(${c}) >= 1${'0'.repeat(whole)}`,
      });
      return;
    }
  }

  skip(
    context,
    table,
    'convert type',
    `converting ${before.type} to ${after.type} needs a trial cast on a copy of the table; no query stands in for it`,
    after.declared,
    after.name,
  );
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

type PushInput = Omit<PreflightCheck, 'file' | 'line'> & { at: { file: string; line: number } };

function push(context: Context, input: PushInput): void {
  const { at, references, ...rest } = input;
  context.checks.push({
    ...rest,
    file: at.file,
    line: at.line,
    ...(references && references.length > 0 ? { references } : {}),
  });
}

function skip(
  context: Context,
  table: string,
  operation: string,
  reason: string,
  at: { file: string; line: number },
  column?: string,
): void {
  context.skipped.push({ table, ...(column ? { column } : {}), operation, reason, file: at.file, line: at.line });
}

const RESERVED = new Set([
  'user', 'order', 'group', 'table', 'select', 'where', 'from', 'index', 'key', 'primary', 'references',
  'check', 'default', 'column', 'constraint', 'unique', 'limit', 'offset', 'desc', 'asc', 'to', 'all',
  'analyse', 'analyze', 'both', 'case', 'cast', 'current_user', 'do', 'end', 'grant', 'having', 'in',
  'into', 'leading', 'natural', 'not', 'null', 'on', 'only', 'or', 'placing', 'returning', 'session_user',
  'some', 'symmetric', 'then', 'trailing', 'union', 'using', 'when', 'window', 'with', 'range', 'rank',
  'row', 'rows', 'schema', 'database', 'condition', 'interval', 'match', 'option', 'partition', 'read', 'rename', 'replace', 'usage',
]);

/** A bare name where that is safe, a quoted one where it is not, and null for anything else. */
function ident(name: string, dialect: SqlDialect): string {
  const parts = name.split('.');
  const quote = dialect === 'mysql' ? '`' : '"';
  return parts
    .map((part) => {
      if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(part)) {
        throw new Error(`Refusing to embed the identifier "${part}".`);
      }
      return RESERVED.has(part.toLowerCase()) ? `${quote}${part}${quote}` : part;
    })
    .join('.');
}

/** Identifiers for a column list, or null when any entry is an expression. */
function identList(columns: string[], dialect: SqlDialect): string[] | null {
  if (columns.length === 0) {
    return null;
  }
  try {
    return columns.map((column) => {
      if (column.includes('.')) {
        throw new Error('qualified');
      }
      return ident(column, dialect);
    });
  } catch {
    return null;
  }
}

/** An expression copied from a migration is embedded only if it cannot end or comment out a statement. */
function safeExpression(expression: string): boolean {
  return expression.trim() !== '' && !/;|--|\/\*|\*\//.test(expression);
}

/** The queries as one script an operator can run against any environment. */
export function renderPreflightScript(reports: PreflightReport[]): string {
  const lines: string[] = [
    '-- Strabo migration preflight. Every statement is a read-only aggregate.',
    '-- Each returns one row: `violations`. Zero means nothing would trip that operation.',
    '',
  ];
  for (const report of reports) {
    lines.push(`-- ==== ${report.repository}: ${report.base} -> ${report.head} (${report.dialect}) ====`);
    if (report.unavailable) {
      lines.push(`-- unavailable: ${report.unavailable}`, '');
      continue;
    }
    for (const check of report.checks) {
      lines.push(
        `-- [${check.severity}] ${check.description}`,
        `-- Non-zero means: ${check.failsWhen}`,
        ...(check.approximate ? ['-- Approximate: the engine has the final say.'] : []),
        `${check.sql};`,
        '',
      );
    }
    for (const entry of report.skipped) {
      lines.push(`-- not checked: ${entry.table}${entry.column ? `.${entry.column}` : ''} ${entry.operation}: ${entry.reason}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
