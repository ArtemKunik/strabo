/**
 * Data products panel logic (J10/J11): how the `/analysis/data/products` report becomes the
 * product cards, the candidates list, the ER view, and the conformance and classification
 * rows the panel shows.
 *
 * Pure functions only: no DOM, no Cytoscape, no fetch. Every string is built from a recorded
 * fact, so the panel and the JSON cannot disagree.
 */

/** The one-line summary of the data products report. */
export function dataProductsSummary(report) {
  const products = report?.products ?? [];
  const candidates = report?.candidates ?? [];
  const conformance = report?.conformance ?? [];
  const catalogs = report?.catalogs ?? [];
  const dbt = report?.dbt ?? [];
  return (
    `${products.length} product(s) · ${candidates.length} candidate(s) · ` +
    `${conformance.length} conformance finding(s) · ${catalogs.length} catalog declaration(s) · ${dbt.length} dbt project(s)`
  );
}

/** The ports of a product, as rows: dataset, field count, and the governing contract. */
export function productPortRows(product) {
  const rows = [];
  for (const port of product?.outputPorts ?? []) {
    rows.push({ direction: 'output', dataset: port.dataset, fields: (port.schema ?? []).length, contract: port.contract ?? null });
  }
  for (const port of product?.inputPorts ?? []) {
    rows.push({ direction: 'input', dataset: port.dataset, fields: (port.schema ?? []).length, contract: port.contract ?? null });
  }
  return rows;
}

/** One line per product for the panel header: name, format, owner, and port counts. */
export function productCardLabel(product) {
  const owner = product.owner ? ` · owned by ${product.owner}` : ' · no declared owner';
  return `${product.name} · ${product.format}${owner} · ${product.outputPorts.length} output port(s), ${product.inputPorts.length} input port(s)`;
}

/** The candidate rows: dataset, kind, and the recorded writer/reader counts. */
export function candidateRows(report) {
  return (report?.candidates ?? []).map((candidate) => ({
    dataset: candidate.dataset,
    kind: candidate.kind,
    writers: candidate.writers?.length ?? 0,
    readers: candidate.readers?.length ?? 0,
    owner: candidate.ownership?.owner ?? null,
    ownerSource: candidate.ownership?.source ?? null,
    detail: candidate.detail,
  }));
}

/** The conformance rows: contract, dataset, field, and the kind of divergence. */
export function conformanceRows(report) {
  return (report?.conformance ?? []).map((finding) => ({
    contract: finding.contract,
    dataset: finding.dataset,
    field: finding.field,
    kind: finding.kind,
    detail: finding.detail,
    file: finding.contractEvidence?.file ?? null,
    line: finding.contractEvidence?.line ?? null,
  }));
}

/**
 * The ER view: datasets with their recorded columns and the model findings that name them.
 *
 * PK/FK facts are not on the dataset node; they are in the model findings, so this joins a
 * dataset to the findings about it and names each finding rather than restating a key.
 */
export function erRows(report) {
  const findings = report?.model?.findings ?? [];
  const byDataset = new Map();
  for (const finding of findings) {
    const list = byDataset.get(finding.dataset) ?? [];
    list.push(finding);
    byDataset.set(finding.dataset, list);
  }
  return (report?.datasets ?? [])
    .filter((dataset) => dataset.kind === 'table' || dataset.kind === 'view' || dataset.kind === 'materialized-view')
    .map((dataset) => ({
      dataset: dataset.id,
      label: dataset.label ?? dataset.id,
      kind: dataset.kind,
      columns: (dataset.columns ?? []).map((column) => column.name),
      findings: (byDataset.get(dataset.id) ?? []).map((finding) => ({ kind: finding.kind, detail: finding.detail })),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The entity mappings the model recorded: entity name, table, and the rule that read it. */
export function entityRows(report) {
  return (report?.model?.entities ?? []).map((entity) => ({
    entity: entity.entity,
    table: entity.table,
    file: entity.file,
    line: entity.line,
    evidence: entity.evidence,
  }));
}

/**
 * The classification rows: dataset, field, tag, and whether it was declared or derived.
 *
 * A derived tag carries its evidence path length, so the panel can say how far it travelled.
 */
export function classificationRows(report) {
  return (report?.classifications ?? []).map((tag) => ({
    dataset: tag.dataset,
    field: tag.field,
    tag: tag.tag,
    source: tag.source,
    pathLength: (tag.path ?? []).length,
  }));
}

/**
 * The catalog declarations grouped by whether the recorded scan agrees they exist.
 *
 * A disagreement is the point of this view: a dataset the catalog lists that no code writes,
 * or a declaration Strabo could not observe, is named rather than merged into the facts.
 */
export function catalogRows(report) {
  const rows = (report?.catalogs ?? []).map((entry) => ({
    catalog: entry.catalog,
    dataset: entry.dataset,
    owner: entry.owner,
    domain: entry.domain,
    observed: entry.observed === true,
    exportedAt: entry.exportedAt,
    detail: entry.detail,
  }));
  return {
    rows,
    observed: rows.filter((row) => row.observed).length,
    unobserved: rows.filter((row) => !row.observed).length,
  };
}

/** The dbt projects as rows: name, root, and model/seed/snapshot counts. */
export function dbtRows(report) {
  return (report?.dbt ?? []).map((project) => ({
    name: project.name,
    root: project.root,
    models: project.modelCount,
    seeds: project.seedCount,
    snapshots: project.snapshotCount,
    unresolved: (project.unresolved ?? []).length,
  }));
}

/** The event flows: topic, kind, and producer/consumer counts, with the contract id. */
export function eventRows(report) {
  return (report?.events ?? []).map((flow) => ({
    topic: flow.topic,
    kind: flow.kind,
    producers: (flow.producers ?? []).length,
    consumers: (flow.consumers ?? []).length,
    contract: flow.contract,
  }));
}

/** The contracts as rows: id, format, and field count, with any shape twin. */
export function contractRows(report) {
  const twins = new Map();
  for (const twin of report?.shapeTwins ?? []) {
    for (const id of twin.contracts ?? []) {
      twins.set(id, twin.contracts.filter((other) => other !== id));
    }
  }
  return (report?.contracts ?? []).map((contract) => ({
    id: contract.id,
    bareId: contract.bareId,
    qualifiedId: contract.qualifiedId,
    format: contract.format,
    fields: (contract.fields ?? []).length,
    twins: twins.get(contract.id) ?? [],
  }));
}

/**
 * The contract boundary rows (Phase 36 K2/K7): definitions with their declared-vs-DTO
 * origin, governed boundaries with badges, drifting contracts with field deviations,
 * ungoverned candidates, and orphaned contracts. Every row is a recorded fact.
 */
export function contractBoundaryRows(boundary) {
  const deviationsByContract = new Map();
  for (const finding of boundary?.conformanceDeviations ?? boundary?.conformance ?? []) {
    const list = deviationsByContract.get(finding.contract) ?? [];
    list.push({ field: finding.field, kind: finding.kind, detail: finding.detail });
    deviationsByContract.set(finding.contract, list);
  }
  return {
    definitions: (boundary?.definitions ?? []).map((definition) => ({
      id: definition.id,
      format: definition.format,
      origin: definition.origin ?? 'dto',
      repository: definition.repository,
      source: definition.source,
      fields: (definition.fields ?? []).length,
    })),
    governed: (boundary?.governedEdges ?? []).map((edge) => ({
      source: edge.source,
      target: edge.target,
      contract: edge.contract,
      format: edge.contractFormat,
      kind: edge.kind,
      conformance: edge.conformance,
      badge: edge.badge,
    })),
    drifting: [...deviationsByContract.entries()].map(([contract, deviations]) => ({ contract, deviations })),
    ungoverned: (boundary?.uncontractedBoundaries ?? []).map((edge) => ({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      reason: edge.reason,
      badge: edge.badge,
    })),
    orphaned: (boundary?.orphanedContracts ?? []).map((entry) => ({ id: entry.id, format: entry.format, source: entry.source })),
    unverified: boundary?.unverifiedEdges ?? [],
  };
}

/**
 * The canvas badge for one boundary edge (Phase 36 K3): `📜 Name (format)` for a
 * governed dependency, `⚡ Topic (event)` for a message/event contract, and
 * `⚠️ uncontracted` for a cross-unit edge with no agreed contract. The badge is read
 * off the recorded edge, never composed from a guess.
 */
export function contractEdgeBadge(edge) {
  if (!edge || typeof edge !== 'object') {
    return null;
  }
  if (typeof edge.badge === 'string' && edge.badge !== '') {
    return edge.badge;
  }
  if (edge.contract) {
    if (edge.kind === 'event') {
      return `⚡ ${edge.contract} (event)`;
    }
    return `📜 ${edge.contract} (${edge.contractFormat ?? edge.format ?? 'contract'})`;
  }
  return '⚠️ uncontracted';
}

/** One line per contract impact: severity and the named consumers (Phase 36 K4). */
export function contractImpactSummary(impact) {
  const changes = (impact?.changes ?? []).length;
  const consumers = (impact?.consumers ?? []).length;
  return `${impact?.contract ?? 'contract'} · ${impact?.severity ?? 'unknown'} · ${changes} field change(s) · ${consumers} consumer(s)`;
}
