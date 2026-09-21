import type {
  CodeDataUse,
  SchemaDrift,
  SchemaSnapshot,
  SchemaTable,
  SchemaUsageFinding,
  SchemaUsageReport,
} from '../types.ts';

/**
 * Check the tables and columns code names against every schema in the workspace.
 *
 * The database is shared, so a repository's code is judged against the union of all the
 * declared schemas, not only its own: a service that reads a table another repository's
 * migrations create is fine. Nothing is reported when no schema is declared at all, because
 * then there is nothing to check against, and `checked` says so.
 *
 * A finding is a statement about evidence, not a defect: an unknown table may be created by
 * an ORM's auto-migration, by a database this workspace does not include, or by a tool that
 * generates SQL at deploy time. It names what was and was not recorded.
 */
export function computeSchemaUsage(schemas: SchemaSnapshot[], uses: CodeDataUse[]): SchemaUsageReport {
  const drift = computeSchemaDrift(schemas);
  if (schemas.length === 0) {
    return { checked: false, uses, findings: [], drift };
  }

  const declared = new Map<string, Array<{ repository: string; table: SchemaTable }>>();
  for (const schema of schemas) {
    for (const table of schema.tables) {
      const list = declared.get(table.name) ?? [];
      list.push({ repository: schema.repository, table });
      declared.set(table.name, list);
    }
  }

  const findings = new Map<string, SchemaUsageFinding>();
  for (const use of uses) {
    const definitions = declared.get(use.table);
    if (!definitions) {
      const key = `table\u0000${use.repository}\u0000${use.file}\u0000${use.line}\u0000${use.table}`;
      findings.set(key, {
        kind: 'unknown-table',
        repository: use.repository,
        file: use.file,
        line: use.line,
        table: use.table,
        evidence: use.evidence,
        confidence: use.confidence,
      });
      continue;
    }
    const known = new Set(definitions.flatMap((entry) => entry.table.columns.map((column) => column.name)));
    for (const column of use.columns) {
      if (known.has(column)) {
        continue;
      }
      const key = `column\u0000${use.repository}\u0000${use.file}\u0000${use.line}\u0000${use.table}\u0000${column}`;
      findings.set(key, {
        kind: 'unknown-column',
        repository: use.repository,
        file: use.file,
        line: use.line,
        table: use.table,
        column,
        evidence: use.evidence,
        confidence: use.confidence,
        definedIn: [...new Set(definitions.map((entry) => entry.repository))].sort(),
      });
    }
  }

  return {
    checked: true,
    uses,
    findings: [...findings.values()].sort(
      (a, b) =>
        a.repository.localeCompare(b.repository) ||
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.table.localeCompare(b.table) ||
        (a.column ?? '').localeCompare(b.column ?? ''),
    ),
    drift,
  };
}

/**
 * Compare a table that more than one repository declares, the way contract drift compares a
 * shared contract: a column one side lacks, a type that differs, or nullability that disagrees.
 * An identical shared table is kept with no deviations so a match is visible too.
 */
export function computeSchemaDrift(schemas: SchemaSnapshot[]): SchemaDrift[] {
  const byTable = new Map<string, Array<{ repository: string; table: SchemaTable }>>();
  for (const schema of schemas) {
    for (const table of schema.tables) {
      const list = byTable.get(table.name) ?? [];
      list.push({ repository: schema.repository, table });
      byTable.set(table.name, list);
    }
  }

  const drifts: SchemaDrift[] = [];
  for (const [name, definitions] of byTable) {
    const repositories = [...new Set(definitions.map((entry) => entry.repository))].sort();
    if (repositories.length < 2) {
      continue;
    }
    const byColumn = new Map<string, SchemaDrift['deviations'][number]['declared']>();
    for (const { repository, table } of definitions) {
      for (const column of table.columns) {
        const declared = byColumn.get(column.name) ?? [];
        if (!declared.some((entry) => entry.repository === repository)) {
          declared.push({ repository, type: column.type, nullable: column.nullable });
        }
        byColumn.set(column.name, declared);
      }
    }

    const deviations: SchemaDrift['deviations'] = [];
    for (const [column, declared] of [...byColumn.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      declared.sort((a, b) => a.repository.localeCompare(b.repository));
      const issue = declared.length < repositories.length
        ? 'missing'
        : new Set(declared.map((entry) => entry.type)).size > 1
          ? 'type'
          : new Set(declared.map((entry) => entry.nullable)).size > 1
            ? 'nullable'
            : null;
      if (issue) {
        deviations.push({ column, declared, issue });
      }
    }
    drifts.push({ table: name, repositories, deviations });
  }
  return drifts.sort((a, b) => a.table.localeCompare(b.table));
}
