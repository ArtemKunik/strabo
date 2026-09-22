import type {
  PainPoint,
  RepositoryChangeSection,
  RepositoryReportDocument,
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
