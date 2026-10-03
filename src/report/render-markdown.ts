import type {
  PainPoint,
  RepositoryChangeSection,
  RepositoryContractsSection,
  RepositoryCoverageSection,
  RepositoryDataSection,
  RepositoryReportDocument,
  RepositoryStructureSection,
  Severity,
} from './report-types.ts';

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low'];

/**
 * Render the report as Markdown: the portable form, suitable for a PR description or a chat
 * paste. Every figure comes from the document, so the Markdown never disagrees with the JSON.
 */
export function renderReportMarkdown(document: RepositoryReportDocument): string {
  const lines: string[] = [];
  const revision = document.revision;

  lines.push(`# Strabo repository report · ${document.repository}`);
  lines.push(
    [
      revision.head ? `HEAD \`${revision.head}\`` : 'HEAD unresolved',
      `graph \`${revision.fingerprint ?? 'no fingerprint'}\``,
      revision.scannedAt ? `scanned ${revision.scannedAt}` : null,
      revision.stale ? 'stale: older than the working tree' : null,
      `generated ${document.generatedAt}`,
    ]
      .filter((part): part is string => part !== null)
      .join(' · '),
  );
  lines.push('');

  renderOverview(lines, document);
  renderPainPoints(lines, document.painPoints);
  renderChange(lines, document.change);
  renderCoverage(lines, document.coverage);
  renderTierStructure(lines, document.structure);
  renderDrift(lines, document.drift);
  renderData(lines, document.data);
  renderContracts(lines, document.contracts);
  renderApi(lines, document.api);
  renderSuggestions(lines, document);
  renderEvidence(lines, document);
  return `${lines.join('\n')}\n`;
}

function renderOverview(lines: string[], document: RepositoryReportDocument): void {
  const { overview } = document;
  lines.push('## Overview');
  lines.push(
    `- ${overview.size.files} files · ${overview.size.edges} edges · ${overview.size.directories} directories · ${overview.size.tests} tests`,
  );
  if (overview.languages.length > 0) {
    lines.push(
      `- Languages: ${overview.languages.map((entry) => `${entry.language} ${entry.files}`).join(', ')}`,
    );
  } else {
    lines.push('- Languages: none recorded');
  }

  section(
    lines,
    `Entry points (${overview.entryPoints.length})`,
    overview.entryPoints.map((entry) => `\`${entry.file}\` — ${entry.reason}`),
  );
  section(
    lines,
    `Top directories (${overview.topDirectories.length})`,
    overview.topDirectories.map(
      (entry) => `\`${entry.directory}\` — ${entry.files} files, ${entry.incoming} incoming`,
    ),
  );
  section(
    lines,
    `Most depended-upon files (${overview.topFiles.length})`,
    overview.topFiles.map(
      (entry) => `\`${entry.id}\` — fan-in ${entry.fanIn}, blast radius ${entry.transitiveDependents}`,
    ),
  );
  lines.push('');
}

function renderPainPoints(lines: string[], painPoints: readonly PainPoint[]): void {
  lines.push(`## Pain points (${painPoints.length})`);
  if (painPoints.length === 0) {
    lines.push('- no recorded pain point crossed a threshold');
    lines.push('');
    return;
  }
  for (const severity of SEVERITY_ORDER) {
    const group = painPoints.filter((point) => point.severity === severity);
    if (group.length === 0) {
      continue;
    }
    lines.push(`### ${severity} (${group.length})`);
    for (const point of group) {
      const where = point.location.length > 0 ? ` · ${point.location.map((id) => `\`${id}\``).join(', ')}` : '';
      lines.push(`- \`${point.kind}\` — ${point.summary}${where}`);
    }
  }
  lines.push('');
}

function renderChange(lines: string[], change: RepositoryChangeSection | null): void {
  lines.push('## Pending change set');
  if (!change) {
    lines.push('- not included in this report');
    lines.push('');
    return;
  }
  lines.push(
    change.head === null && change.base === 'HEAD'
      ? 'Against `HEAD` (staged, unstaged, untracked)'
      : `Base \`${change.base}\` (${change.baseRevision ?? 'unresolved'}) → HEAD \`${change.head ?? 'working tree'}\``,
  );
  section(
    lines,
    `Changed files (${change.changedFiles.length})`,
    change.changedFiles.map((file) => {
      const rename = file.previousPath ? ` (from \`${file.previousPath}\`)` : '';
      return `\`${file.path}\` — ${file.status}${rename}`;
    }),
  );
  section(
    lines,
    `Reach (${change.reach.affected.length})`,
    change.reach.affected.map((entry) => `\`${entry.id}\` — distance ${entry.distance}`),
  );
  if (change.reach.outsideGraph.length > 0) {
    lines.push(`- ${change.reach.outsideGraph.length} changed path(s) outside the scanned graph`);
  }
  section(
    lines,
    `Untested reach (${change.untestedReach.length})`,
    change.untestedReach.map((file) => `\`${file}\``),
  );
  section(
    lines,
    `Hotspots touched (${change.hotspotsTouched.length})`,
    change.hotspotsTouched.flatMap((hotspot) =>
      hotspot.findings.map((finding) => `\`${hotspot.file}\` — [${finding.rule}] ${finding.detail}`),
    ),
  );
  renderStructure(lines, change);
  for (const warning of change.warnings) {
    lines.push(`- warning: ${warning}`);
  }
  lines.push('');
}

function renderStructure(lines: string[], change: RepositoryChangeSection): void {
  const structural = change.structural;
  if (!structural) {
    return;
  }
  if (!structural.available) {
    lines.push(`- structure unavailable: ${structural.reason}${structural.detail ? ` — ${structural.detail}` : ''}`);
    return;
  }
  const diff = structural.diff;
  section(
    lines,
    `Dependency edges added (${diff.edgesAdded.length})`,
    diff.edgesAdded.map((edge) => `\`${edge.source}\` → \`${edge.target}\` (${edge.kind})`),
  );
  section(
    lines,
    `Dependency edges removed (${diff.edgesRemoved.length})`,
    diff.edgesRemoved.map((edge) => `\`${edge.source}\` → \`${edge.target}\` (${edge.kind})`),
  );
  section(
    lines,
    `Cycles introduced (${diff.cyclesIntroduced.length})`,
    diff.cyclesIntroduced.map((cycle) => cycle.members.map((member) => `\`${member}\``).join(' → ')),
  );
  section(
    lines,
    `Cycles resolved (${diff.cyclesResolved.length})`,
    diff.cyclesResolved.map((cycle) => cycle.members.map((member) => `\`${member}\``).join(' → ')),
  );
  section(
    lines,
    `Wrong-way tier edges added (${diff.tierEdgesAdded.length})`,
    diff.tierEdgesAdded.map((edge) => `\`${edge.source}\` → \`${edge.target}\` (${edge.kind}, ${edge.unit})`),
  );
  section(lines, `Entry points added (${diff.entryPointsAdded.length})`, diff.entryPointsAdded.map((file) => `\`${file}\``));
  section(lines, `Newly unreached (${diff.newlyUnreached.length})`, diff.newlyUnreached.map((file) => `\`${file}\``));
}

function renderCoverage(lines: string[], coverage: RepositoryCoverageSection | null): void {
  lines.push('## Code coverage');
  if (!coverage) {
    lines.push('- not included in this report');
    lines.push('');
    return;
  }
  if (!coverage.available) {
    lines.push(`- unavailable: ${coverage.reason ?? 'no report'}${coverage.detail ? ` — ${coverage.detail}` : ''}`);
    if (coverage.checkedLocations && coverage.checkedLocations.length > 0) {
      lines.push(`- checked: ${coverage.checkedLocations.map((loc) => `\`${loc}\``).join(', ')}`);
    }
    if (coverage.suggestedCommands && coverage.suggestedCommands.length > 0) {
      lines.push(
        `- produce a report: ${coverage.suggestedCommands.map((c) => `\`${c.command}\` (${c.ecosystem})`).join(' · ')}`,
      );
    } else if (coverage.refreshCommand) {
      lines.push(`- produce a report: \`${coverage.refreshCommand}\``);
    }
    lines.push('');
    return;
  }
  lines.push(
    `- Line coverage: ${coverage.lineCoverage !== null ? `${coverage.lineCoverage}%` : 'unavailable'} (${coverage.linesHit}/${coverage.linesFound} lines across ${coverage.filesMeasured} file(s))`,
  );
  lines.push(
    `- Basis: ${coverage.basis} (${coverage.format ?? 'unknown format'})${coverage.reportPath ? ` · \`${coverage.reportPath}\`` : ''}${coverage.reportModified ? ` · modified ${coverage.reportModified}` : ''}`,
  );
  if (coverage.stale.length > 0) {
    lines.push(
      `- Stale for ${coverage.stale.length} file(s) (predates last commit): ${coverage.stale.slice(0, 5).map((f) => `\`${f}\``).join(', ')}${coverage.stale.length > 5 ? ` and ${coverage.stale.length - 5} more` : ''}`,
    );
  }
  if (coverage.outOfGraph.length > 0) {
    lines.push(`- ${coverage.outOfGraph.length} file(s) in report but outside scanned graph`);
  }
  if (coverage.refreshCommand) {
    lines.push(`- Refresh command: \`${coverage.refreshCommand}\``);
  }
  lines.push('');
}

function renderTierStructure(lines: string[], structure: RepositoryStructureSection | null): void {
  lines.push('## Logical structure');
  if (!structure) {
    lines.push('- not included in this report');
    lines.push('');
    return;
  }
  lines.push(
    `- ${structure.summary.classified} classified file(s) across ${structure.tierFlow.tiers.length} ranked tier(s) · ${structure.summary.unclassified} unclassified · ${structure.summary.mixed} mixed`,
  );
  lines.push(
    `- Flow: ${structure.tierFlow.edges.length} cross-tier edge(s) · ${structure.tierFlow.total} total recorded import(s) · intra-tier ratio ${Math.round(structure.tierFlow.intraRatio * 100)}%`,
  );
  section(
    lines,
    `Tier flow (${structure.tierFlow.edges.length})`,
    structure.tierFlow.edges.map(
      (edge) =>
        `\`${edge.source}\` → \`${edge.target}\` (${edge.kind}, weight ${edge.weight}${edge.crossUnit > 0 ? `, ${edge.crossUnit} cross-unit` : ''})`,
    ),
  );
  section(
    lines,
    `Support tiers (${structure.shelf.length})`,
    structure.shelf.map(
      (entry) =>
        `\`${entry.tier}\` — ${entry.files} file(s), ${entry.lines} line(s)${entry.mixed > 0 ? ` (${entry.mixed} mixed)` : ''}`,
    ),
  );
  section(
    lines,
    `Wrong-way dependencies (${structure.directions.length})`,
    structure.directions.map(
      (dir) =>
        `\`${dir.source}\` (${dir.sourceTier}) → \`${dir.target}\` (${dir.targetTier}) [${dir.kind}] at line ${dir.line}`,
    ),
  );
  const dataFlow = structure.dataFlow;
  if (dataFlow) {
    lines.push(
      `- Data flow: ${dataFlow.writes} write(s) · ${dataFlow.reads} read(s) through ${dataFlow.hubs} data hub(s) · ${dataFlow.crossTier} cross-tier pair(s) · ${dataFlow.governed} governed · ${dataFlow.uncontracted} uncontracted${
        dataFlow.unclassified > 0 ? ` · ${dataFlow.unclassified} file(s) with a data use but no tier` : ''
      }`,
    );
    section(
      lines,
      `Data-flow pairs (${dataFlow.pairs.length})`,
      dataFlow.pairs.map(
        (pair) => `\`${pair.source}\` → \`${pair.target}\` via \`${pair.hub}\`${pair.governed ? ' (governed)' : ''}`,
      ),
    );
    for (const diagnostic of dataFlow.diagnostics) {
      lines.push(`- data-flow limit: ${diagnostic}`);
    }
  }
  lines.push('');
}

function renderDrift(lines: string[], drift: RepositoryReportDocument['drift']): void {
  lines.push('## Architecture drift');
  if (!drift) {
    lines.push('- not included in this report');
    lines.push('');
    return;
  }
  if (!drift.available) {
    lines.push(`- unavailable: ${drift.reason ?? 'no drift series'}`);
    lines.push('');
    return;
  }
  if (drift.points.length === 0) {
    lines.push('- no revision was measured');
    lines.push('');
    return;
  }
  const newest = drift.points[0]?.revision.slice(0, 7) ?? '?';
  const oldest = drift.points[drift.points.length - 1]?.revision.slice(0, 7) ?? '?';
  lines.push(`${drift.points.length} revision(s), newest first · \`${newest}\` … \`${oldest}\``);
  lines.push('');
  for (const series of drift.series) {
    const values = series.points.map((point) => (point.value === null ? '—' : String(point.value)));
    lines.push(`- ${series.label}: ${values.join(' → ')}`);
  }
  lines.push('');
}

/** Rows shown per API list; the JSON document keeps them all. */
const API_ROWS = 20;

function renderApi(lines: string[], api: RepositoryReportDocument['api']): void {
  lines.push('## HTTP API');
  if (!api) {
    lines.push('- not included in this report');
    lines.push('');
    return;
  }
  if (!api.available) {
    lines.push(`- unavailable: ${api.reason ?? 'no conformance reading'}`);
    lines.push('');
    return;
  }
  const { totals } = api;
  lines.push(
    `- ${totals.operations} documented operations · ${totals.routes} registered routes · ${totals.matched} joined · ${totals.undocumented} undocumented · ${totals.unimplemented} unimplemented`,
  );
  for (const document of api.documents.filter((entry) => entry.describes === 'another-service')) {
    lines.push(`- \`${document.file}\` joins no route here; read as describing another service`);
  }
  const prefixed = api.matched.find((match) => match.prefix);
  if (prefixed?.prefix) {
    const adds = prefixed.prefix.side === 'spec' ? 'documents add' : 'code adds';
    lines.push(`- joined through the \`${prefixed.prefix.value}\` prefix the ${adds}`);
  }
  const list = (title: string, rows: string[]): void => {
    if (rows.length === 0) {
      return;
    }
    lines.push('');
    lines.push(title);
    lines.push(...rows.slice(0, API_ROWS).map((row) => `- ${row}`));
    if (rows.length > API_ROWS) {
      lines.push(`- … ${rows.length - API_ROWS} more`);
    }
  };
  list(
    'Registered but not documented:',
    api.undocumented.map((route) => `\`${route.method} ${route.path}\` · \`${route.file}:${route.line}\``),
  );
  list(
    'Documented but not registered:',
    api.unimplemented.map((operation) => `\`${operation.method} ${operation.path}\` · \`${operation.file}\``),
  );
  lines.push('');
}

function renderData(lines: string[], data: RepositoryDataSection | null): void {
  lines.push('## Data layer');
  if (!data) {
    lines.push('- not included in this report');
    lines.push('');
    return;
  }
  lines.push(
    `- ${data.datasets} datasets · ${data.edges} read/write edges · ${data.products.length} data products · ${data.contracts.length} contracts · ${data.events} topics/queues`,
  );
  lines.push(
    `- Gaps: ${data.gaps.noSingleWriter} dataset(s) without a single writer · ${data.gaps.contractlessPort} shared dataset(s) without a contract · ${data.gaps.unconformant} conformance finding(s)`,
  );
  section(
    lines,
    `Data products (${data.products.length})`,
    data.products.map((product) => {
      const ports = `${product.inputPorts.length} in, ${product.outputPorts.length} out`;
      return `\`${product.name}\` — ${product.format}, ${ports}${product.owner ? `, owned by ${product.owner}` : ''}`;
    }),
  );
  section(
    lines,
    `Conformance findings (${data.conformance.length})`,
    data.conformance.map(
      (finding) =>
        `\`${finding.contract}\` — ${finding.kind} field \`${finding.field}\`${finding.dataset ? ` on \`${finding.dataset}\`` : ''}: ${finding.detail}`,
    ),
  );
  section(
    lines,
    `Product candidates (${data.candidates.length})`,
    data.candidates.map(
      (candidate) =>
        `\`${candidate.dataset}\` — ${candidate.kind} (${candidate.writers.length} writer(s), ${candidate.readers.length} reader(s)): ${candidate.detail}`,
    ),
  );
  section(
    lines,
    `Classifications (${data.classifications.length})`,
    data.classifications.map(
      (tag) =>
        `\`${tag.dataset}\`${tag.field ? `.${tag.field}` : ''} — ${tag.tag} (${tag.source})`,
    ),
  );
  lines.push('');
}

function renderContracts(lines: string[], contracts: RepositoryContractsSection | null): void {
  lines.push('## Contracts & Boundaries');
  if (!contracts) {
    lines.push('- not included in this report');
    lines.push('');
    return;
  }
  lines.push(
    `- ${contracts.definitions.length} contract(s) · ${contracts.gaps.governed} governed edge(s) · ${contracts.gaps.uncontracted} uncontracted · ${contracts.gaps.drifting} drifting · ${contracts.gaps.orphaned} orphaned · ${contracts.gaps.unverified} unverified`,
  );
  section(
    lines,
    `Contract definitions (${contracts.definitions.length})`,
    contracts.definitions.map(
      (definition) => `\`${definition.id}\` — ${definition.format} (${definition.origin}), ${definition.fields.length} field(s) in \`${definition.source}\``,
    ),
  );
  section(
    lines,
    `Governed boundaries (${contracts.governedEdges.length})`,
    contracts.governedEdges.map(
      (edge) => `\`${edge.source}\` → \`${edge.target}\` — ${edge.badge} · ${edge.conformance}`,
    ),
  );
  section(
    lines,
    `Ungoverned boundaries (${contracts.uncontractedBoundaries.length})`,
    contracts.uncontractedBoundaries.map(
      (edge) => `\`${edge.source}\` → \`${edge.target}\` — ${edge.badge}: ${edge.reason}`,
    ),
  );
  section(
    lines,
    `Orphaned contracts (${contracts.orphaned.length})`,
    contracts.orphaned.map((entry) => `\`${entry.id}\` — ${entry.format} in \`${entry.source}\``),
  );
  if (contracts.unverified.length > 0) {
    section(
      lines,
      `Unverified (${contracts.unverified.length})`,
      contracts.unverified.map((entry) => `\`${entry.source}\` → \`${entry.target}\` names \`${entry.contract}\`: ${entry.reason}`),
    );
  }
  lines.push('');
}

function renderSuggestions(lines: string[], document: RepositoryReportDocument): void {
  lines.push(`## Suggestions (${document.suggestions.length})`);
  if (document.suggestions.length === 0) {
    lines.push('- no recorded suggestion: no pain point crossed a threshold');
    lines.push('');
    return;
  }
  for (const suggestion of document.suggestions) {
    lines.push(`- ${suggestion.text}`);
  }
  lines.push('');
}

function renderEvidence(lines: string[], document: RepositoryReportDocument): void {
  const { evidence } = document;
  lines.push('## Evidence');
  lines.push(
    `- ${evidence.files} files · ${evidence.edges} edges · ${evidence.diagnostics} diagnostics · ${evidence.excluded} exclusions`,
  );
  lines.push(
    `- Pain points by severity: ${SEVERITY_ORDER.map((severity) => `${severity} ${evidence.painPointsBySeverity[severity]}`).join(', ')}${evidence.truncated ? ' · truncated' : ''}`,
  );
  if (evidence.unavailable.length > 0) {
    lines.push(`- Not computed: ${evidence.unavailable.join('; ')}`);
  }
  for (const warning of evidence.warnings) {
    lines.push(`- warning: ${warning}`);
  }
  lines.push('');
}

function section(lines: string[], heading: string, items: readonly string[]): void {
  if (items.length === 0) {
    return;
  }
  lines.push(`### ${heading}`);
  for (const item of items) {
    lines.push(`- ${item}`);
  }
}
