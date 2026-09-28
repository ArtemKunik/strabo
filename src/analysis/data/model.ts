import type {
  CodeDataUse,
  ContractField,
  DataEdge,
  DataEntityMapping,
  DataModelFinding,
  DataModelReport,
  DatasetNode,
  SchemaSnapshot,
  SchemaTable,
} from '../../types.ts';

/** The id a table or view dataset carries: `db:<repository>/<table>`. */
export function tableDatasetId(repository: string, table: string): string {
  return `db:${repository}/${table}`;
}

/** The normalised column shape of a snapshot table, nullability read as required-ness. */
export function tableColumns(table: SchemaTable): ContractField[] {
  return table.columns
    .map((column) => ({ name: column.name, type: column.type, required: !column.nullable }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every table and view in the workspace as a dataset, keyed by its qualified id. */
export function buildTableDatasets(schemas: readonly SchemaSnapshot[]): DatasetNode[] {
  const datasets: DatasetNode[] = [];
  for (const schema of schemas) {
    for (const table of schema.tables) {
      datasets.push({
        id: tableDatasetId(schema.repository, table.name),
        kind: table.kind ?? 'table',
        label: table.name,
        repository: schema.repository,
        declared: {
          repository: schema.repository,
          file: table.declared.file,
          line: table.declared.line,
        },
        columns: tableColumns(table),
        strength: 'strong',
      });
    }
  }
  return datasets.sort((a, b) => a.id.localeCompare(b.id));
}

/** The id a file carries in the recorded graph; the same path the scan reports. */
function fileId(use: CodeDataUse): string {
  return use.file;
}

/** Which datasets a use may denote: every schema table with that name, across repositories. */
function matchingDatasets(index: Map<string, DatasetNode[]>, use: CodeDataUse): DatasetNode[] {
  return index.get(use.table) ?? [];
}

/**
 * Build the entity-relationship view and the read/write edges from recorded evidence.
 *
 * A table or view is a dataset from the snapshot; code that names it is a reader or a writer
 * only when its direction was recorded (J1). An unknown direction records no edge, because the
 * graph never guesses a direction from a variable name.
 */
export function buildModel(
  schemas: readonly SchemaSnapshot[],
  uses: readonly CodeDataUse[],
): { model: DataModelReport; edges: DataEdge[]; datasets: DatasetNode[] } {
  const datasets = buildTableDatasets(schemas);
  const index = new Map<string, DatasetNode[]>();
  for (const dataset of datasets) {
    const list = index.get(dataset.label) ?? [];
    list.push(dataset);
    index.set(dataset.label, list);
  }

  const entities = buildEntities(uses);
  const edges = buildModelEdges(index, uses);
  const findings = buildModelFindings(datasets, schemas, index, uses);
  return { model: { entities, findings }, edges, datasets };
}

/** ORM entities and models whose mapping declared a table, never matched by name similarity. */
export function buildEntities(uses: readonly CodeDataUse[]): DataEntityMapping[] {
  const mappings: DataEntityMapping[] = [];
  const seen = new Set<string>();
  for (const use of uses) {
    if (!use.entity) {
      continue;
    }
    const key = `${use.repository}\u0000${use.file}\u0000${use.entity}\u0000${use.table}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    mappings.push({
      repository: use.repository,
      file: use.file,
      line: use.line,
      entity: use.entity,
      table: use.table,
      evidence: use.evidence,
    });
  }
  return mappings.sort(
    (a, b) => a.repository.localeCompare(b.repository) || a.file.localeCompare(b.file) || a.line - b.line,
  );
}

function buildModelEdges(index: Map<string, DatasetNode[]>, uses: readonly CodeDataUse[]): DataEdge[] {
  const edges: DataEdge[] = [];
  for (const use of uses) {
    if (use.access !== 'read' && use.access !== 'write' && use.access !== 'ddl') {
      continue;
    }
    const targets = matchingDatasets(index, use);
    if (targets.length === 0) {
      continue;
    }
    const kind = use.access === 'read' ? 'reads' : 'writes';
    const detail = use.access === 'ddl' ? 'schema change' : undefined;
    for (const target of targets) {
      edges.push({
        kind,
        source: fileId(use),
        target: target.id,
        strength: use.confidence,
        evidence: { repository: use.repository, file: use.file, line: use.line },
        ...(detail ? { detail } : {}),
      });
    }
  }
  return edges.sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.target.localeCompare(b.target) ||
      (a.evidence?.line ?? 0) - (b.evidence?.line ?? 0),
  );
}

function buildModelFindings(
  datasets: readonly DatasetNode[],
  schemas: readonly SchemaSnapshot[],
  index: Map<string, DatasetNode[]>,
  uses: readonly CodeDataUse[],
): DataModelFinding[] {
  const findings: DataModelFinding[] = [];
  const declaredTables = new Set(datasets.filter((entry) => entry.kind !== 'view' && entry.kind !== 'materialized-view').map((entry) => entry.label));
  const referenced = new Set(uses.map((use) => use.table));

  for (const schema of schemas) {
    for (const table of schema.tables) {
      const dataset = tableDatasetId(schema.repository, table.name);
      const isView = table.kind === 'view' || table.kind === 'materialized-view';
      if (!isView && !table.constraints.some((constraint) => constraint.kind === 'primary-key')) {
        findings.push({
          kind: 'no-primary-key',
          repository: schema.repository,
          dataset,
          detail: `table ${table.name} declares no primary key`,
          evidence: table.declared,
          inputs: { columns: table.columns.length },
        });
      }
      for (const constraint of isView ? [] : table.constraints) {
        if (constraint.kind !== 'foreign-key' || !constraint.references) {
          continue;
        }
        if (declaredTables.has(constraint.references.table)) {
          continue;
        }
        findings.push({
          kind: 'foreign-key-undeclared',
          repository: schema.repository,
          dataset,
          detail: `${table.name}.${constraint.columns.join(',')} references ${constraint.references.table}, which no migration declares`,
          evidence: constraint.declared,
          inputs: { references: constraint.references.table },
        });
      }
      if (!referenced.has(table.name)) {
        findings.push({
          kind: 'orphan-table',
          repository: schema.repository,
          dataset,
          detail: `no code in the workspace reads or writes ${table.name}`,
          evidence: table.declared,
          inputs: {},
        });
      }
    }
  }
  return findings.sort((a, b) => a.repository.localeCompare(b.repository) || a.dataset.localeCompare(b.dataset) || a.kind.localeCompare(b.kind));
}
