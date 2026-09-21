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
    `${summary.drifting} drifting`
  );
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
