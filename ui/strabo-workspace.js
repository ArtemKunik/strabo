/**
 * Pure helpers for the Workspace panel.
 *
 * The workspace is a declared list of repositories analysed together; these helpers turn the
 * recorded `WorkspaceReport` into captions and rows. Nothing is inferred: an absent flow,
 * contract, or drift list is stated as absent, and a repository that publishes no coordinate
 * says so rather than hiding the field.
 */

/** One-line summary of the recorded workspace counts. */
export function workspaceSummary(report) {
  const summary = report?.summary;
  if (!summary) {
    return 'Workspace not recorded.';
  }
  return (
    `${summary.repositories} repositories · ` +
    `${summary.flows} cross-repo flows · ` +
    `${summary.serviceFlows ?? 0} service flows · ` +
    `${summary.contracts} contracts · ` +
    `${summary.drifting} drifting` +
    (summary.tables > 0 ? ` · ${summary.tables} tables` : '')
  );
}

/** One row per database table a repository's SQL files declare, with what declared it. */
export function schemaRows(report) {
  const rows = [];
  for (const schema of report?.schemas ?? []) {
    for (const table of schema.tables ?? []) {
      const keys = (table.constraints ?? []).filter((entry) => entry.kind === 'primary-key');
      const references = (table.constraints ?? []).filter((entry) => entry.kind === 'foreign-key');
      rows.push({
        id: `${schema.repository}:${table.name}`,
        label: `${table.name} — ${schema.repository}`,
        columns: (table.columns ?? []).length,
        detail:
          `${(table.columns ?? []).length} column${(table.columns ?? []).length === 1 ? '' : 's'}` +
          (keys.length > 0 ? ` · key (${keys[0].columns.join(', ')})` : ' · no primary key') +
          (references.length > 0 ? ` · ${references.length} foreign key${references.length === 1 ? '' : 's'}` : '') +
          ` · ${table.declared?.file ?? 'unknown file'}:${table.declared?.line ?? '?'}`,
      });
    }
  }
  return rows;
}

/** Captions for the schema gaps: statements the parser saw but could not apply. */
export function schemaGapRows(report) {
  return (report?.schemas ?? []).flatMap((schema) =>
    (schema.gaps ?? []).map((gap) => ({
      id: `${schema.repository}:${gap.file}:${gap.line}:${gap.statement}`,
      label: `${gap.statement} — ${gap.file}:${gap.line}`,
      reason: gap.reason,
    })),
  );
}

/** One row per place code names a table or column that no SQL file in the workspace declares. */
export function usageFindingRows(report) {
  return (report?.usage?.findings ?? []).map((finding) => ({
    id: `${finding.repository}:${finding.file}:${finding.line}:${finding.table}:${finding.column ?? ''}`,
    label:
      finding.kind === 'unknown-column'
        ? `${finding.table}.${finding.column} is not a column of a declared table`
        : `${finding.table} is not a declared table`,
    detail:
      `${finding.repository} · ${finding.file}:${finding.line} · ${finding.evidence}` +
      (finding.confidence === 'weak' ? ' · weak evidence' : ''),
    weak: finding.confidence === 'weak',
  }));
}

/** One row per table that more than one repository declares, naming its deviations or saying it is clean. */
export function schemaDriftRows(report) {
  return (report?.usage?.drift ?? []).map((entry) => {
    const deviations = entry.deviations ?? [];
    return {
      id: entry.table,
      label: `${entry.table} — ${(entry.repositories ?? []).join(', ')}`,
      clean: deviations.length === 0,
      deviations: deviations.map((deviation) => `${deviation.column}: ${deviation.issue}`),
    };
  });
}

/** The caption for the code-against-schema check, saying when there was nothing to check against. */
export function usageCaption(report) {
  const usage = report?.usage;
  if (!usage) {
    return 'Code usage not recorded.';
  }
  if (!usage.checked) {
    return 'No SQL schema is declared, so there is nothing to check code against.';
  }
  const findings = (usage.findings ?? []).length;
  const uses = (usage.uses ?? []).length;
  return findings === 0
    ? `${uses} table use${uses === 1 ? '' : 's'} recorded in code; each names a declared table and column.`
    : `${findings} of ${uses} recorded table uses name something no SQL file declares.`;
}

/** Short commit and publish facts for each repository. */
export function repositoryRows(report) {
  return (report?.repositories ?? []).map((repository) => ({
    name: repository.name,
    head: repository.head ? repository.head.slice(0, 7) : null,
    dirty: repository.dirty === true,
    publishes: repository.publishes
      ? `${repository.publishes.ecosystem}:${repository.publishes.name}`
      : null,
  }));
}

/** One row per recorded cross-repository flow. */
export function flowRows(report) {
  return (report?.flows ?? []).map((flow) => ({
    id: `${flow.from}->${flow.to}:${flow.package}`,
    label: `${flow.from} → ${flow.to} (${flow.ecosystem} ${flow.package})`,
    files: Array.isArray(flow.files) ? flow.files.length : 0,
    publishedBy: flow.publishedBy ?? null,
  }));
}

/** One row per HTTP endpoint a repository declares in its OpenAPI document. */
export function serviceEndpointRows(report) {
  return (report?.serviceEndpoints ?? []).map((endpoint) => ({
    id: `${endpoint.repository}:${endpoint.method} ${endpoint.host ?? ''}${endpoint.path}`,
    label: `${endpoint.method} ${endpoint.host ?? ''}${endpoint.path}`,
    repository: endpoint.repository,
    source: endpoint.source,
  }));
}

/** One row per recorded outbound call joined to an endpoint a sibling repository declares. */
export function serviceFlowRows(report) {
  return (report?.serviceFlows ?? []).map((flow) => ({
    id: `${flow.from}->${flow.to}:${flow.method} ${flow.host}${flow.path}`,
    label: `${flow.from} → ${flow.to} (${flow.method} ${flow.host}${flow.path})`,
    calls: Array.isArray(flow.calls) ? flow.calls.length : 0,
    declaredBy: flow.declaredBy ?? null,
  }));
}

/**
 * The current graph's node ids that the report records on one side of a cross-repo
 * interaction: a file that imports a sibling's coordinate or makes a service call, or a file
 * that declares an endpoint. Matching is by the recorded repo-relative path, so the mark only
 * lands on a node the scan actually drew.
 */
export function crossRepoNodeIds(report, nodeIds) {
  const nodes = new Set(nodeIds ?? []);
  const matched = new Set();
  const consider = (file) => {
    if (typeof file === 'string' && nodes.has(file)) {
      matched.add(file);
    }
  };
  for (const flow of report?.flows ?? []) {
    for (const file of flow.files ?? []) consider(file.file);
  }
  for (const flow of report?.serviceFlows ?? []) {
    for (const call of flow.calls ?? []) consider(call.file);
  }
  for (const endpoint of report?.serviceEndpoints ?? []) consider(endpoint.source);
  return [...matched].sort();
}

/** One row per declared contract, with its field count. */
export function contractRows(report) {
  return (report?.contracts ?? []).map((contract) => ({
    id: contract.id,
    label: `${contract.id} (${contract.format}) — ${contract.repository}`,
    fields: Array.isArray(contract.fields) ? contract.fields.length : 0,
  }));
}

/** One row per shared contract id, naming its deviations or stating that it is clean. */
export function driftRows(report) {
  return (report?.drift ?? []).map((entry) => {
    const deviations = entry.deviations ?? [];
    return {
      id: entry.id,
      label: `${entry.id} (${entry.format}) — ${entry.repositories.join(', ')}`,
      clean: deviations.length === 0,
      deviations: deviations.map((deviation) => `${deviation.name}: ${deviation.issue}`),
    };
  });
}

/** Severity order for the compatibility list: what breaks first. */
const COMPAT_LABEL = { breaking: 'breaking', conditional: 'conditional', safe: 'safe' };

/** One group per repository from a `/workspace/compat` response, its changes as display rows. */
export function compatRows(response) {
  return (response?.reports ?? []).map((report) => {
    const summary = report.summary ?? { breaking: 0, conditional: 0, safe: 0 };
    return {
      repository: report.repository,
      base: report.base,
      head: report.head,
      unavailable: report.unavailable ?? null,
      caption: compatCaption(report),
      rows: (report.changes ?? []).map((change) => {
        const detail = [];
        if (change.before !== undefined || change.after !== undefined) {
          detail.push(`${change.before ?? '—'} → ${change.after ?? '—'}`);
        }
        if (change.file) {
          detail.push(`${change.file}${change.line ? `:${change.line}` : ''}`);
        }
        if (change.references?.length) {
          detail.push(`still used at ${change.references.map((ref) => `${ref.file}:${ref.line}`).join(', ')}`);
        }
        if (change.consumers?.length) {
          detail.push(`also declared by ${change.consumers.join(', ')}`);
        }
        return {
          id: `${change.subject}:${change.id}:${change.name ?? ''}:${change.change}`,
          compatibility: change.compatibility,
          badge: COMPAT_LABEL[change.compatibility] ?? change.compatibility,
          label: `${change.id}${change.name ? ` · ${change.name}` : ''} — ${change.change.replace('-', ' ')}`,
          reason: change.reason,
          detail,
        };
      }),
      summary,
    };
  });
}

/** The one-line verdict for a compared repository, or why it could not be compared. */
export function compatCaption(report) {
  if (report?.unavailable) {
    return `Not compared: ${report.unavailable}`;
  }
  const { breaking = 0, conditional = 0, safe = 0 } = report?.summary ?? {};
  if (breaking + conditional + safe === 0) {
    return `No contract or schema differences recorded between ${report?.base} and ${report?.head}.`;
  }
  return `${breaking} breaking · ${conditional} conditional · ${safe} safe (${report.base} → ${report.head})`;
}

/** What a preflight result means for this check, in words; never a pass for a check that did not run. */
export function resultCaption(check) {
  const result = check?.result;
  if (!result) {
    return 'not run';
  }
  if (result.status === 'error') {
    return `could not check: ${result.error ?? 'unknown error'}`;
  }
  const rows = result.violations ?? 0;
  const noun = `${rows} row${rows === 1 ? '' : 's'}`;
  if (check.severity === 'data-loss') {
    return rows === 0 ? 'nothing stored there would be lost' : `${noun} would lose data`;
  }
  return rows === 0 ? 'ok — no row would make it fail' : `${noun} would make it fail`;
}

/** One group per repository from a preflight response: its queries and what was not checked. */
export function preflightRows(response) {
  return (response?.reports ?? []).map((report) => ({
    repository: report.repository,
    dialect: report.dialect,
    unavailable: report.unavailable ?? null,
    caption: report.unavailable
      ? `Not compared: ${report.unavailable}`
      : (report.checks ?? []).length === 0 && (report.skipped ?? []).length === 0
        ? `No migration operation between ${report.base} and ${report.head} needs a data check.`
        : `${(report.checks ?? []).length} data check${(report.checks ?? []).length === 1 ? '' : 's'} · ${report.dialect}`,
    checks: (report.checks ?? []).map((check) => ({
      id: check.id,
      label: check.description,
      severity: check.severity,
      failsWhen: check.failsWhen,
      sql: check.sql,
      approximate: check.approximate === true,
      status: check.result?.status ?? 'not-run',
      result: resultCaption(check),
      references: (check.references ?? []).map((ref) => `${ref.file}:${ref.line}`),
    })),
    skipped: (report.skipped ?? []).map((entry) => ({
      id: `${entry.table}:${entry.column ?? ''}:${entry.operation}`,
      label: `${entry.table}${entry.column ? `.${entry.column}` : ''} — ${entry.operation}`,
      reason: entry.reason,
    })),
  }));
}

/** One row per database the workspace config declares, saying whether its variable is set. */
export function databaseRows(response) {
  return (response?.databases ?? []).map((database) => ({
    name: database.name,
    label: `${database.name} (${database.dialect})`,
    configured: database.configured === true,
    note: database.configured
      ? `connection string from ${database.urlEnv}`
      : `set ${database.urlEnv} to enable`,
  }));
}

/** Sentences for where a live database and a repository's migrations disagree. */
export function liveDriftRows(live) {
  const at = (entry) => (entry.column ? `${entry.table}.${entry.column}` : entry.table);
  return (live?.drift ?? []).map((entry) => {
    let text;
    switch (entry.kind) {
      case 'table-not-in-live':
        text = `declared by ${entry.repository}, missing in the database`;
        break;
      case 'table-not-in-repository':
        text = 'in the database, declared by no repository';
        break;
      case 'column-not-in-live':
        text = `declared as ${entry.declared}, missing in the database`;
        break;
      case 'column-not-in-repository':
        text = `in the database (${entry.live}), not declared`;
        break;
      default:
        text = `database ${entry.live}, migrations ${entry.declared} (${entry.kind})`;
    }
    return { id: `${entry.repository}:${at(entry)}:${entry.kind}`, label: at(entry), text };
  });
}

/** What an operator is agreeing to when they run checks against a database. */
export function probeConsent(database, checkCount) {
  return (
    `This connects to ${database} with the connection string from its environment variable and runs ` +
    `${checkCount} read-only count quer${checkCount === 1 ? 'y' : 'ies'}, each in its own read-only transaction ` +
    'with a timeout. No table row is read, and the connection string is not stored.'
  );
}
