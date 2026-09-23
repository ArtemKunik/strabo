import type {
  PainPoint,
  RepositoryChangeSection,
  RepositoryReportDocument,
  Severity,
} from './report-types.ts';

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low'];

/**
 * Render the report as one self-contained HTML document: inline CSS, no script, no external
 * asset. This is the printable artifact and the source for the PDF render, so the two cannot
 * diverge. Every figure comes from the document.
 */
export function renderReportHtml(document: RepositoryReportDocument): string {
  const body: string[] = [];
  body.push(`<header>`);
  body.push(`<h1>Strabo repository report · ${escapeHtml(document.repository)}</h1>`);
  body.push(`<p class="meta">${revisionLine(document)}</p>`);
  body.push(`</header>`);

  body.push(overviewSection(document));
  body.push(painPointSection(document.painPoints));
  body.push(changeSection(document.change));
  body.push(driftSection(document.drift));
  body.push(suggestionSection(document));
  body.push(evidenceSection(document));

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>Strabo repository report · ${escapeHtml(document.repository)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    `<body>${body.join('\n')}</body>`,
    '</html>',
    '',
  ].join('\n');
}

function revisionLine(document: RepositoryReportDocument): string {
  const revision = document.revision;
  return [
    revision.head ? `HEAD <code>${escapeHtml(revision.head)}</code>` : 'HEAD unresolved',
    `graph <code>${escapeHtml(revision.fingerprint ?? 'no fingerprint')}</code>`,
    revision.scannedAt ? `scanned ${escapeHtml(revision.scannedAt)}` : null,
    revision.stale ? '<span class="stale">stale: older than the working tree</span>' : null,
    `generated ${escapeHtml(document.generatedAt)}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

function overviewSection(document: RepositoryReportDocument): string {
  const { overview } = document;
  const parts: string[] = ['<section>', '<h2>Overview</h2>', '<ul>'];
  parts.push(
    `<li>${overview.size.files} files · ${overview.size.edges} edges · ${overview.size.directories} directories · ${overview.size.tests} tests</li>`,
  );
  parts.push(
    `<li>Languages: ${overview.languages.length > 0 ? overview.languages.map((entry) => `${escapeHtml(entry.language)} ${entry.files}`).join(', ') : 'none recorded'}</li>`,
  );
  parts.push('</ul>');
  parts.push(
    sublist(
      `Entry points (${overview.entryPoints.length})`,
      overview.entryPoints.map((entry) => `<code>${escapeHtml(entry.file)}</code> — ${escapeHtml(entry.reason)}`),
    ),
  );
  parts.push(
    sublist(
      `Top directories (${overview.topDirectories.length})`,
      overview.topDirectories.map(
        (entry) => `<code>${escapeHtml(entry.directory)}</code> — ${entry.files} files, ${entry.incoming} incoming`,
      ),
    ),
  );
  parts.push(
    sublist(
      `Most depended-upon files (${overview.topFiles.length})`,
      overview.topFiles.map(
        (entry) => `<code>${escapeHtml(entry.id)}</code> — fan-in ${entry.fanIn}, blast radius ${entry.transitiveDependents}`,
      ),
    ),
  );
  parts.push('</section>');
  return parts.join('\n');
}

function painPointSection(painPoints: readonly PainPoint[]): string {
  const parts: string[] = ['<section>', `<h2>Pain points (${painPoints.length})</h2>`];
  if (painPoints.length === 0) {
    parts.push('<p class="muted">No recorded pain point crossed a threshold.</p>');
    parts.push('</section>');
    return parts.join('\n');
  }
  for (const severity of SEVERITY_ORDER) {
    const group = painPoints.filter((point) => point.severity === severity);
    if (group.length === 0) {
      continue;
    }
    parts.push(`<h3 class="sev-${severity}">${severity} (${group.length})</h3>`);
    parts.push('<ul>');
    for (const point of group) {
      const where =
        point.location.length > 0
          ? ` · ${point.location.map((id) => `<code>${escapeHtml(id)}</code>`).join(', ')}`
          : '';
      parts.push(`<li><span class="kind">${escapeHtml(point.kind)}</span> — ${escapeHtml(point.summary)}${where}</li>`);
    }
    parts.push('</ul>');
  }
  parts.push('</section>');
  return parts.join('\n');
}

function changeSection(change: RepositoryChangeSection | null): string {
  const parts: string[] = ['<section>', '<h2>Pending change set</h2>'];
  if (!change) {
    parts.push('<p class="muted">Not included in this report.</p>');
    parts.push('</section>');
    return parts.join('\n');
  }
  parts.push(
    change.head === null && change.base === 'HEAD'
      ? '<p>Against <code>HEAD</code> (staged, unstaged, untracked)</p>'
      : `<p>Base <code>${escapeHtml(change.base)}</code> (${escapeHtml(change.baseRevision ?? 'unresolved')}) → HEAD <code>${escapeHtml(change.head ?? 'working tree')}</code></p>`,
  );
  parts.push(
    sublist(
      `Changed files (${change.changedFiles.length})`,
      change.changedFiles.map((file) => {
        const rename = file.previousPath ? ` (from <code>${escapeHtml(file.previousPath)}</code>)` : '';
        return `<code>${escapeHtml(file.path)}</code> — ${escapeHtml(file.status)}${rename}`;
      }),
    ),
  );
  parts.push(
    sublist(
      `Reach (${change.reach.affected.length})`,
      change.reach.affected.map((entry) => `<code>${escapeHtml(entry.id)}</code> — distance ${entry.distance}`),
    ),
  );
  if (change.reach.outsideGraph.length > 0) {
    parts.push(`<p class="muted">${change.reach.outsideGraph.length} changed path(s) outside the scanned graph.</p>`);
  }
  parts.push(
    sublist(
      `Untested reach (${change.untestedReach.length})`,
      change.untestedReach.map((file) => `<code>${escapeHtml(file)}</code>`),
    ),
  );
  for (const warning of change.warnings) {
    parts.push(`<p class="warning">warning: ${escapeHtml(warning)}</p>`);
  }
  parts.push('</section>');
  return parts.join('\n');
}

function driftSection(drift: RepositoryReportDocument['drift']): string {
  const parts: string[] = ['<section>', '<h2>Architecture drift</h2>'];
  if (!drift) {
    parts.push('<p class="muted">Not included in this report.</p>');
    parts.push('</section>');
    return parts.join('\n');
  }
  if (!drift.available) {
    parts.push(`<p class="muted">Unavailable: ${escapeHtml(drift.reason ?? 'no drift series')}</p>`);
    parts.push('</section>');
    return parts.join('\n');
  }
  if (drift.points.length === 0) {
    parts.push('<p class="muted">No revision was measured.</p>');
    parts.push('</section>');
    return parts.join('\n');
  }
  const newest = drift.points[0]?.revision.slice(0, 7) ?? '?';
  const oldest = drift.points[drift.points.length - 1]?.revision.slice(0, 7) ?? '?';
  parts.push(`<p class="meta">${drift.points.length} revision(s), newest first · <code>${escapeHtml(newest)}</code> … <code>${escapeHtml(oldest)}</code></p>`);
  parts.push('<ul>');
  for (const series of drift.series) {
    const values = series.points
      .map((point) => (point.value === null ? '—' : String(point.value)))
      .join(' → ');
    parts.push(`<li>${escapeHtml(series.label)}: ${escapeHtml(values)}</li>`);
  }
  parts.push('</ul>');
  parts.push('</section>');
  return parts.join('\n');
}

function suggestionSection(document: RepositoryReportDocument): string {
  const parts: string[] = ['<section>', `<h2>Suggestions (${document.suggestions.length})</h2>`];
  if (document.suggestions.length === 0) {
    parts.push('<p class="muted">No recorded suggestion: no pain point crossed a threshold.</p>');
  } else {
    parts.push('<ul>');
    for (const suggestion of document.suggestions) {
      parts.push(`<li>${escapeHtml(suggestion.text)}</li>`);
    }
    parts.push('</ul>');
  }
  parts.push('</section>');
  return parts.join('\n');
}

function evidenceSection(document: RepositoryReportDocument): string {
  const { evidence } = document;
  const parts: string[] = ['<section>', '<h2>Evidence</h2>', '<ul>'];
  parts.push(
    `<li>${evidence.files} files · ${evidence.edges} edges · ${evidence.diagnostics} diagnostics · ${evidence.excluded} exclusions</li>`,
  );
  parts.push(
    `<li>Pain points by severity: ${SEVERITY_ORDER.map((severity) => `${severity} ${evidence.painPointsBySeverity[severity]}`).join(', ')}${evidence.truncated ? ' · truncated' : ''}</li>`,
  );
  if (evidence.unavailable.length > 0) {
    parts.push(`<li>Not computed: ${escapeHtml(evidence.unavailable.join('; '))}</li>`);
  }
  for (const warning of evidence.warnings) {
    parts.push(`<li class="warning">warning: ${escapeHtml(warning)}</li>`);
  }
  parts.push('</ul>');
  parts.push('</section>');
  return parts.join('\n');
}

function sublist(heading: string, items: readonly string[]): string {
  if (items.length === 0) {
    return '';
  }
  return [`<h4>${escapeHtml(heading)}</h4>`, '<ul>', ...items.map((item) => `<li>${item}</li>`), '</ul>'].join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  max-width: 60rem;
  padding: 2.5rem 2rem 4rem;
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #1b1f24;
  background: #ffffff;
}
h1 { font-size: 1.6rem; margin: 0 0 .35rem; }
h2 { font-size: 1.2rem; margin: 2rem 0 .6rem; padding-bottom: .3rem; border-bottom: 1px solid #e4e8ee; }
h3 { font-size: 1rem; margin: 1.2rem 0 .4rem; }
h4 { font-size: .9rem; margin: .9rem 0 .3rem; color: #444d57; }
ul { margin: .3rem 0 .8rem; padding-left: 1.3rem; }
li { margin: .15rem 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88em; background: #f2f4f8; padding: .05rem .3rem; border-radius: 3px; }
.meta { color: #55606b; font-size: .9rem; margin: 0 0 .5rem; }
.muted { color: #6b7580; }
.warning { color: #8a5a00; }
.stale { color: #8a5a00; font-weight: 600; }
.kind { font-weight: 600; }
.sev-critical { color: #b42318; }
.sev-high { color: #b54708; }
.sev-medium { color: #8a6100; }
.sev-low { color: #475467; }
header { border-bottom: 2px solid #1b1f24; padding-bottom: .8rem; }
@media print {
  body { max-width: none; padding: 0; }
  h2 { break-after: avoid; }
  li, h3 { break-inside: avoid; }
}
`;
