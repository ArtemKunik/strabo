import type { ResolvedRepository } from '../boundary/repository-root.ts';
import type {
  CodeDataUse,
  CompatChange,
  CompatReport,
  Compatibility,
  ContractDefinition,
  SchemaColumn,
  SchemaConstraint,
  SchemaIndex,
  SchemaSnapshot,
  SchemaTable,
  WorkspaceReport,
} from '../types.ts';
import { extractContracts } from './contracts.ts';
import { extractDataUses } from './data-usage.ts';
import { extractLanguageContracts } from './dto.ts';
import { materializeRevision, RevisionError } from './revision.ts';
import { constraintSignature, extractSchema } from './schema.ts';

/** Everything the compatibility check reads from one revision of a repository. */
export interface RevisionFacts {
  contracts: ContractDefinition[];
  schema: SchemaSnapshot | null;
}

export interface CompatInput {
  repository: string;
  root: string;
  /** Revision to measure from. */
  base: string;
  /** Revision to measure to; the working tree when omitted. */
  head?: string;
  /** Code across the workspace at head, for finding what still names a removed element. */
  uses?: CodeDataUse[];
  /** Contracts every repository in the workspace declares, to name who else sees a change. */
  workspaceContracts?: ContractDefinition[];
}

/** Read the contracts and schema of a repository as it stands in the working tree. */
export function readWorkingFacts(root: string, repository: string): RevisionFacts {
  return {
    contracts: [...extractContracts(root, repository), ...extractLanguageContracts(root, repository)],
    schema: extractSchema(root, repository),
  };
}

/** Read the contracts, schema and data uses of a repository at a git revision. */
export async function readRevisionFacts(
  root: string,
  repository: string,
  ref: string,
): Promise<RevisionFacts & { uses: CodeDataUse[] }> {
  const revision = await materializeRevision(root, ref);
  try {
    return {
      contracts: [...extractContracts(revision.root, repository), ...extractLanguageContracts(revision.root, repository)],
      schema: extractSchema(revision.root, repository),
      uses: extractDataUses(revision.root, repository),
    };
  } finally {
    revision.cleanup();
  }
}

/**
 * Compare a repository between two revisions.
 *
 * Both sides go through the same extractors as the working tree, so the comparison is
 * between two recorded shapes. A revision that cannot be read yields a report that says so,
 * never an empty list of changes that would look like "nothing changed".
 */
export async function analyzeCompat(input: CompatInput): Promise<CompatReport> {
  const headLabel = input.head ?? 'working tree';
  try {
    const before = await readRevisionFacts(input.root, input.repository, input.base);
    const after = input.head
      ? await readRevisionFacts(input.root, input.repository, input.head)
      : readWorkingFacts(input.root, input.repository);
    const changes = [
      ...diffContracts(before.contracts, after.contracts, input.workspaceContracts ?? [], input.repository),
      ...diffSchemas(before.schema, after.schema, input.uses ?? []),
    ];
    return report(input.repository, input.base, headLabel, changes);
  } catch (error) {
    if (error instanceof RevisionError) {
      return { ...report(input.repository, input.base, headLabel, []), unavailable: error.message };
    }
    throw error;
  }
}

/** The compatibility of every repository in a workspace report between two revisions. */
export async function analyzeWorkspaceCompat(
  workspace: WorkspaceReport,
  repositories: ResolvedRepository[],
  options: { base?: string; head?: string; repository?: string } = {},
): Promise<CompatReport[]> {
  const base = options.base ?? 'HEAD';
  const selected = options.repository
    ? repositories.filter((entry) => entry.name === options.repository)
    : repositories;
  const reports: CompatReport[] = [];
  for (const repository of selected) {
    reports.push(
      await analyzeCompat({
        repository: repository.name,
        root: repository.root,
        base,
        ...(options.head ? { head: options.head } : {}),
        uses: workspace.usage.uses,
        workspaceContracts: workspace.contracts,
      }),
    );
  }
  return reports;
}

function report(repository: string, base: string, head: string, changes: CompatChange[]): CompatReport {
  const order: Record<Compatibility, number> = { breaking: 0, conditional: 1, safe: 2 };
  const sorted = [...changes].sort(
    (a, b) =>
      order[a.compatibility] - order[b.compatibility] ||
      a.subject.localeCompare(b.subject) ||
      a.id.localeCompare(b.id) ||
      (a.name ?? '').localeCompare(b.name ?? ''),
  );
  return {
    repository,
    base,
    head,
    changes: sorted,
    summary: {
      breaking: sorted.filter((entry) => entry.compatibility === 'breaking').length,
      conditional: sorted.filter((entry) => entry.compatibility === 'conditional').length,
      safe: sorted.filter((entry) => entry.compatibility === 'safe').length,
    },
  };
}

// ---------------------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------------------

/**
 * Diff contracts by id. A field's removal and a type change fail existing readers; making a
 * field required or optional is safe for one side only, and the reason says which. A new
 * optional field needs nothing from anyone.
 */
export function diffContracts(
  base: ContractDefinition[],
  head: ContractDefinition[],
  workspaceContracts: ContractDefinition[] = [],
  repository = '',
): CompatChange[] {
  const before = firstById(base);
  const after = firstById(head);
  const changes: CompatChange[] = [];

  const consumersOf = (id: string): string[] | undefined => {
    const others = [
      ...new Set(
        workspaceContracts.filter((entry) => entry.id === id && entry.repository !== repository).map((entry) => entry.repository),
      ),
    ].sort();
    return others.length > 0 ? others : undefined;
  };

  for (const [id, definition] of before) {
    const next = after.get(id);
    const consumers = consumersOf(id);
    if (!next) {
      changes.push({
        subject: 'contract',
        id,
        target: 'contract',
        change: 'removed',
        compatibility: 'breaking',
        reason: 'Everything that reads or sends this contract loses it.',
        file: definition.source,
        ...(consumers ? { consumers } : {}),
      });
      continue;
    }
    const fields = new Map(definition.fields.map((field) => [field.name, field]));
    const nextFields = new Map(next.fields.map((field) => [field.name, field]));
    for (const [name, field] of fields) {
      const changed = nextFields.get(name);
      const common = { subject: 'contract' as const, id, target: 'field' as const, name, file: next.source, ...(consumers ? { consumers } : {}) };
      if (!changed) {
        changes.push({
          ...common,
          change: 'removed',
          compatibility: 'breaking',
          before: describeField(field.type, field.required),
          reason: 'Readers that use this field break, and senders that still provide it may be rejected.',
          file: definition.source,
        });
        continue;
      }
      if (field.type !== changed.type) {
        const compatibility = contractTypeChange(field.type, changed.type);
        changes.push({
          ...common,
          change: 'type-changed',
          compatibility,
          before: field.type,
          after: changed.type,
          reason:
            compatibility === 'conditional'
              ? 'A widening: readers holding the narrower type can overflow or truncate, senders are unaffected.'
              : 'Readers and senders built against the old type disagree with the new one.',
        });
      }
      if (field.required !== changed.required) {
        changes.push({
          ...common,
          change: 'required-changed',
          compatibility: 'conditional',
          before: field.required ? 'required' : 'optional',
          after: changed.required ? 'required' : 'optional',
          reason: changed.required
            ? 'Senders that omit it now fail; readers are unaffected.'
            : 'Readers that assume it is present now fail; senders are unaffected.',
        });
      }
    }
    for (const [name, field] of nextFields) {
      if (fields.has(name)) {
        continue;
      }
      changes.push({
        subject: 'contract',
        id,
        target: 'field',
        name,
        change: 'added',
        compatibility: field.required ? 'conditional' : 'safe',
        after: describeField(field.type, field.required),
        reason: field.required
          ? 'Senders that do not provide it now fail; readers are unaffected.'
          : 'An optional field: existing readers and senders ignore it.',
        file: next.source,
        ...(consumers ? { consumers } : {}),
      });
    }
  }

  for (const [id, definition] of after) {
    if (!before.has(id)) {
      changes.push({
        subject: 'contract',
        id,
        target: 'contract',
        change: 'added',
        compatibility: 'safe',
        reason: 'A new contract; nothing depends on it yet.',
        file: definition.source,
      });
    }
  }
  return changes;
}

function firstById(contracts: ContractDefinition[]): Map<string, ContractDefinition> {
  const byId = new Map<string, ContractDefinition>();
  for (const contract of contracts) {
    if (!byId.has(contract.id)) {
      byId.set(contract.id, contract);
    }
  }
  return byId;
}

function describeField(type: string, required: boolean): string {
  return `${type}${required ? '' : '?'}`;
}

interface Numeric {
  family: 'int' | 'float';
  bits: number;
}

/** The numeric family and width a contract or column type names, when it names one. */
function numeric(type: string): Numeric | null {
  const lower = type.toLowerCase();
  const explicit = /\b(?:u?int)(8|16|32|64)\b/.exec(lower);
  if (explicit) {
    return { family: 'int', bits: Number(explicit[1]) };
  }
  if (/\b(?:tinyint|byte)\b/.test(lower)) {
    return { family: 'int', bits: 8 };
  }
  if (/\b(?:smallint|short)\b/.test(lower)) {
    return { family: 'int', bits: 16 };
  }
  if (/\b(?:bigint|long)\b/.test(lower)) {
    return { family: 'int', bits: 64 };
  }
  if (/\b(?:int|integer)\b/.test(lower)) {
    return { family: 'int', bits: 32 };
  }
  if (/\b(?:double|float64|number\(double\))\b/.test(lower)) {
    return { family: 'float', bits: 64 };
  }
  if (/\b(?:float|float32|real|number\(float\))\b/.test(lower)) {
    return { family: 'float', bits: 32 };
  }
  return null;
}

function contractTypeChange(before: string, after: string): Compatibility {
  const from = numeric(before);
  const to = numeric(after);
  if (from && to && from.family === to.family && to.bits > from.bits) {
    return 'conditional';
  }
  return 'breaking';
}

// ---------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------

/**
 * Diff two schema snapshots, judging each change by what the application that is still
 * running against the database would do: does it keep working while the new schema is live?
 * That is the expand/contract rule, so an added column that old inserts leave out, or a
 * constraint old writes can violate, is breaking even though the migration itself succeeds.
 *
 * Whether the migration succeeds on the data that is actually there is a separate question,
 * answered by the preflight.
 */
export function diffSchemas(
  base: SchemaSnapshot | null,
  head: SchemaSnapshot | null,
  uses: CodeDataUse[] = [],
): CompatChange[] {
  const before = new Map((base?.tables ?? []).map((table) => [table.name, table]));
  const after = new Map((head?.tables ?? []).map((table) => [table.name, table]));
  const changes: CompatChange[] = [];

  const referencesTo = (table: string, column: string | null, filter: (use: CodeDataUse) => boolean = () => true) => {
    const found = uses
      .filter((use) => use.table === table && (column === null || use.columns.includes(column)) && filter(use))
      .map((use) => ({ repository: use.repository, file: use.file, line: use.line }));
    return found.length > 0 ? { references: found } : {};
  };

  for (const [name, table] of before) {
    const next = after.get(name);
    if (!next) {
      changes.push({
        subject: 'schema',
        id: name,
        target: 'table',
        change: 'removed',
        compatibility: 'breaking',
        reason: 'Code and queries that use this table fail, and its data is gone.',
        file: table.declared.file,
        line: table.declared.line,
        ...referencesTo(name, null),
      });
      continue;
    }
    changes.push(...diffTable(table, next, uses));
  }

  for (const [name, table] of after) {
    if (!before.has(name)) {
      changes.push({
        subject: 'schema',
        id: name,
        target: 'table',
        change: 'added',
        compatibility: 'safe',
        reason: 'A new table; nothing depends on it yet.',
        file: table.declared.file,
        line: table.declared.line,
      });
    }
  }
  return changes;
}

function diffTable(before: SchemaTable, after: SchemaTable, uses: CodeDataUse[]): CompatChange[] {
  const changes: CompatChange[] = [];
  const id = before.name;
  const namedIn = (column: string, filter: (use: CodeDataUse) => boolean = () => true) => {
    const found = uses
      .filter((use) => use.table === id && use.columns.includes(column) && filter(use))
      .map((use) => ({ repository: use.repository, file: use.file, line: use.line }));
    return found.length > 0 ? { references: found } : {};
  };
  const writes = (use: CodeDataUse): boolean => /\((?:INSERT|UPDATE)\)|ORM/.test(use.evidence) && !/SELECT/.test(use.evidence);

  const columns = new Map(before.columns.map((column) => [column.name, column]));
  const nextColumns = new Map(after.columns.map((column) => [column.name, column]));

  for (const [name, column] of columns) {
    const next = nextColumns.get(name);
    if (!next) {
      changes.push({
        subject: 'schema',
        id,
        target: 'column',
        name,
        change: 'removed',
        compatibility: 'breaking',
        before: column.type,
        reason: 'Queries that read or write this column fail, and its data is gone.',
        file: column.declared.file,
        line: column.declared.line,
        ...namedIn(name),
      });
      continue;
    }
    changes.push(...diffColumn(id, column, next, namedIn, writes));
  }

  for (const [name, column] of nextColumns) {
    if (columns.has(name)) {
      continue;
    }
    const required = !column.nullable && column.default === undefined;
    const omitting = uses
      .filter((use) => use.table === id && use.columns.length > 0 && !use.columns.includes(name) && /\(INSERT\)/.test(use.evidence))
      .map((use) => ({ repository: use.repository, file: use.file, line: use.line }));
    changes.push({
      subject: 'schema',
      id,
      target: 'column',
      name,
      change: 'added',
      compatibility: required ? 'breaking' : 'safe',
      after: `${column.type}${column.nullable ? '' : ' not null'}`,
      reason: required
        ? 'NOT NULL with no default: inserts written before the column existed do not supply it and fail.'
        : 'Nullable or defaulted: existing inserts keep working.',
      file: column.declared.file,
      line: column.declared.line,
      ...(required && omitting.length > 0 ? { references: omitting } : {}),
    });
  }

  changes.push(...diffConstraints(id, before.constraints, after.constraints));
  changes.push(...diffIndexes(id, before.indexes, after.indexes));
  return changes;
}

function diffColumn(
  table: string,
  before: SchemaColumn,
  after: SchemaColumn,
  namedIn: (column: string, filter?: (use: CodeDataUse) => boolean) => object,
  writes: (use: CodeDataUse) => boolean,
): CompatChange[] {
  const changes: CompatChange[] = [];
  const common = {
    subject: 'schema' as const,
    id: table,
    target: 'column' as const,
    name: before.name,
    file: after.declared.file,
    line: after.declared.line,
  };

  if (before.type !== after.type) {
    const widening = schemaTypeWidens(before.type, after.type);
    changes.push({
      ...common,
      change: 'type-changed',
      compatibility: widening ? 'conditional' : 'breaking',
      before: before.type,
      after: after.type,
      reason: widening
        ? 'A widening: existing values still fit, but code holding the old type can overflow or truncate what it reads.'
        : 'Existing values may not convert, and code that reads or writes the old type can fail.',
      ...namedIn(before.name),
    });
  }
  if (before.nullable !== after.nullable) {
    changes.push({
      ...common,
      change: 'nullability-changed',
      compatibility: after.nullable ? 'conditional' : 'breaking',
      before: before.nullable ? 'nullable' : 'not null',
      after: after.nullable ? 'nullable' : 'not null',
      reason: after.nullable
        ? 'Writers are unaffected, but readers that assume the value is present can now receive NULL.'
        : 'Writers that leave the column NULL now fail, and the migration fails if any row is already NULL.',
      ...(after.nullable ? {} : namedIn(before.name, writes)),
    });
  }
  if ((before.default ?? '') !== (after.default ?? '')) {
    const removed = before.default !== undefined && after.default === undefined;
    const added = before.default === undefined && after.default !== undefined;
    changes.push({
      ...common,
      change: 'default-changed',
      compatibility: added ? 'safe' : 'conditional',
      ...(before.default !== undefined ? { before: before.default } : {}),
      ...(after.default !== undefined ? { after: after.default } : {}),
      reason: removed
        ? 'Inserts that relied on the default now fail if the column is NOT NULL, or store NULL.'
        : added
          ? 'A new default only fills values that were previously omitted.'
          : 'Inserts that omit the column now store a different value.',
    });
  }
  return changes;
}

/** Whether every value of `before` still fits `after`, for the column types the snapshot records. */
export function schemaTypeWidens(before: string, after: string): boolean {
  const from = numeric(before);
  const to = numeric(after);
  if (from && to && !before.startsWith('numeric') && !after.startsWith('numeric')) {
    return from.family === to.family && to.bits > from.bits;
  }
  const varchar = /^(?:varchar|char)\((\d+)\)$/;
  const fromLength = varchar.exec(before)?.[1];
  const toLength = varchar.exec(after)?.[1];
  if (fromLength && toLength) {
    return before.startsWith('char') === after.startsWith('char') && Number(toLength) > Number(fromLength);
  }
  if (fromLength && after === 'text') {
    return true;
  }
  const decimal = /^numeric\((\d+),(\d+)\)$/;
  const fromDecimal = decimal.exec(before);
  const toDecimal = decimal.exec(after);
  if (fromDecimal && toDecimal) {
    const [fromPrecision, fromScale] = [Number(fromDecimal[1]), Number(fromDecimal[2])];
    const [toPrecision, toScale] = [Number(toDecimal[1]), Number(toDecimal[2])];
    return toScale >= fromScale && toPrecision - toScale >= fromPrecision - fromScale && (toPrecision > fromPrecision || toScale > fromScale);
  }
  return false;
}

function diffConstraints(table: string, before: SchemaConstraint[], after: SchemaConstraint[]): CompatChange[] {
  const changes: CompatChange[] = [];
  const bySignature = (list: SchemaConstraint[]) => new Map(list.map((entry) => [constraintSignature(entry), entry]));
  const from = bySignature(before);
  const to = bySignature(after);

  for (const [signature, constraint] of from) {
    const next = to.get(signature);
    if (!next) {
      changes.push({
        subject: 'schema',
        id: table,
        target: 'constraint',
        name: describeConstraint(constraint),
        change: 'removed',
        compatibility: 'conditional',
        before: describeConstraint(constraint),
        reason: 'Writers are unaffected, but code that relied on the rule (uniqueness, a key, a cascade) is no longer protected.',
        file: constraint.declared.file,
        line: constraint.declared.line,
      });
    } else if (constraint.kind === 'foreign-key' && (constraint.references?.onDelete ?? '') !== (next.references?.onDelete ?? '')) {
      changes.push({
        subject: 'schema',
        id: table,
        target: 'constraint',
        name: describeConstraint(constraint),
        change: 'modified',
        compatibility: 'conditional',
        before: `on delete ${constraint.references?.onDelete ?? 'no action'}`,
        after: `on delete ${next.references?.onDelete ?? 'no action'}`,
        reason: 'Deleting a parent row now behaves differently for the rows that reference it.',
        file: next.declared.file,
        line: next.declared.line,
      });
    }
  }
  for (const [signature, constraint] of to) {
    if (from.has(signature)) {
      continue;
    }
    changes.push({
      subject: 'schema',
      id: table,
      target: 'constraint',
      name: describeConstraint(constraint),
      change: 'added',
      compatibility: 'breaking',
      after: describeConstraint(constraint),
      reason: 'Writes that were valid before can now be rejected, and the migration fails if existing rows already violate it.',
      file: constraint.declared.file,
      line: constraint.declared.line,
    });
  }
  return changes;
}

function describeConstraint(constraint: SchemaConstraint): string {
  const columns = constraint.columns.join(', ');
  switch (constraint.kind) {
    case 'primary-key':
      return `primary key (${columns})`;
    case 'unique':
      return `unique (${columns})`;
    case 'foreign-key':
      return `foreign key (${columns}) -> ${constraint.references?.table ?? '?'}(${constraint.references?.columns.join(', ') ?? ''})`;
    case 'check':
      return `check (${constraint.expression ?? ''})`;
  }
}

function diffIndexes(table: string, before: SchemaIndex[], after: SchemaIndex[]): CompatChange[] {
  const changes: CompatChange[] = [];
  const key = (index: SchemaIndex): string => `${index.unique ? 'unique:' : ''}${index.columns.join(',')}${index.where ? `|${index.where}` : ''}`;
  const from = new Map(before.map((index) => [key(index), index]));
  const to = new Map(after.map((index) => [key(index), index]));
  const label = (index: SchemaIndex): string => `${index.unique ? 'unique ' : ''}index${index.name ? ` ${index.name}` : ''} (${index.columns.join(', ')})`;

  for (const [signature, index] of from) {
    if (!to.has(signature)) {
      changes.push({
        subject: 'schema',
        id: table,
        target: 'index',
        name: label(index),
        change: 'removed',
        compatibility: 'conditional',
        before: label(index),
        reason: index.unique
          ? 'Uniqueness is no longer enforced, and queries that used the index may slow down.'
          : 'Queries that used the index may slow down.',
        file: index.declared.file,
        line: index.declared.line,
      });
    }
  }
  for (const [signature, index] of to) {
    if (from.has(signature)) {
      continue;
    }
    changes.push({
      subject: 'schema',
      id: table,
      target: 'index',
      name: label(index),
      change: 'added',
      compatibility: index.unique ? 'breaking' : 'safe',
      after: label(index),
      reason: index.unique
        ? 'Duplicate writes that were valid before are now rejected, and building it fails if duplicates exist.'
        : 'Only speeds queries up; building it may lock the table on some engines.',
      file: index.declared.file,
      line: index.declared.line,
    });
  }
  return changes;
}
