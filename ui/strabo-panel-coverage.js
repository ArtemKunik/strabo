/**
 * The Coverage panel and the Module Passport's Coverage section.
 *
 * Every figure comes from the server's measured-or-reachable reading. A `measured` basis is a
 * real report and may read as a percent; a `reachable` basis is static test-reach, never drawn
 * as a coverage percent. A figure the report does not name says `unavailable` or `not in
 * report`, never 0%.
 */

import { coverageAge } from './strabo-functions.js';

const ROOT_FOLDER = '.';

function element(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** The short figure label: a real percent only on the measured basis. */
export function coverageEntryLabel(entry) {
  if (!entry) {
    return 'unavailable';
  }
  // Only a file entry carries a boolean here; a folder entry's `notInReport` is a count.
  if (entry.notInReport === true) {
    return 'not in report';
  }
  if (entry.basis === 'measured') {
    return entry.value === null || entry.value === undefined ? 'unavailable' : `${Math.round(entry.value)}%`;
  }
  return entry.reached ? 'reachable (test-reach)' : 'no test reaches it';
}

/** The summed figure label: reached/file count on the reachable basis, a percent measured. */
export function coverageTotalsLabel(totals) {
  if (!totals) {
    return 'unavailable';
  }
  if (totals.basis === 'measured') {
    return totals.value === null || totals.value === undefined ? 'unavailable' : `${Math.round(totals.value)}%`;
  }
  return `${totals.reached ?? 0}/${totals.files ?? 0} reached`;
}

/** One line naming where the figure came from: the report, or the reachable fallback and why. */
export function coverageProvenanceText(provenance) {
  if (!provenance) {
    return 'Coverage provenance unavailable.';
  }
  if (provenance.available) {
    const parts = ['measured basis'];
    if (provenance.format) {
      parts.push(provenance.format);
    }
    if (provenance.reportPath) {
      parts.push(provenance.reportPath);
    }
    const age = provenance.reportAgeMs;
    if (age !== null && age !== undefined) {
      parts.push(`report ${coverageAge(age)} old`);
    }
    const stale = provenance.stale?.length ?? 0;
    if (stale > 0) {
      parts.push(`${stale} stale`);
    }
    return parts.join(' · ');
  }
  const reason = provenance.reason ?? 'no-report-found';
  const detail = provenance.detail ? ` — ${provenance.detail}` : '';
  return `reachable basis (static test-reach, not executed coverage): ${reason}${detail}`;
}

/** The scope's name for a heading: the project, a folder path, or a file path. */
export function coverageSubjectLabel(report) {
  if (!report) {
    return 'coverage';
  }
  if (report.scope === 'project') {
    return 'project';
  }
  return report.subject ?? report.scope;
}

function figureCell(label, basis) {
  const cell = element('span', 'coverage-figure', label);
  cell.dataset.basis = basis ?? 'unavailable';
  return cell;
}

function note(text) {
  return element('p', 'unavailable', text);
}

/**
 * Render a project or folder coverage report: the provenance, the subtree totals, the child
 * folders table, and (folder scope) the direct files. Handlers are `onOpenProject`,
 * `onOpenFolder(folder)`, and `onSelect(file)`.
 */
export function renderCoverageReport(container, report, handlers = {}) {
  container.replaceChildren();

  if (report?.loading) {
    container.append(element('h3', null, 'Coverage'));
    container.append(note('Loading coverage…'));
    return;
  }

  container.append(element('h3', null, `Coverage — ${coverageSubjectLabel(report)}`));

  if (report?.error) {
    container.append(note(report.error));
    if (handlers.onRetry) {
      const retry = element('button', 'link', 'Retry');
      retry.type = 'button';
      retry.dataset.role = 'coverage-retry';
      retry.addEventListener('click', () => handlers.onRetry());
      container.append(retry);
    }
    return;
  }
  if (!report) {
    container.append(note('No coverage report was returned.'));
    return;
  }

  container.append(coverageBreadcrumb(report.subject, handlers));
  container.append(provenanceLine(report.provenance));
  container.append(coverageTotals(report.totals, report.threshold));
  container.append(coverageFolders(report.folders ?? [], handlers));

  if (Array.isArray(report.files)) {
    container.append(coverageFiles(report.files, handlers));
  }
}

function provenanceLine(provenance) {
  const line = element('p', 'evidence coverage-provenance', coverageProvenanceText(provenance));
  line.dataset.role = 'coverage-provenance';
  return line;
}

function coverageBreadcrumb(subject, handlers) {
  const nav = element('nav', 'coverage-breadcrumb');
  nav.setAttribute('aria-label', 'Coverage scope');

  const root = element('button', 'link', 'Project');
  root.type = 'button';
  root.dataset.folder = ROOT_FOLDER;
  root.addEventListener('click', () => handlers.onOpenProject?.());
  nav.append(root);

  const segments = subject && subject !== ROOT_FOLDER ? subject.split('/').filter(Boolean) : [];
  let path = '';
  for (const segment of segments) {
    path = path ? `${path}/${segment}` : segment;
    nav.append(element('span', 'coverage-crumb-sep', '/'));
    const current = path === subject;
    if (current) {
      const here = element('span', 'coverage-crumb-current', segment);
      here.setAttribute('aria-current', 'page');
      nav.append(here);
    } else {
      const crumb = element('button', 'link', segment);
      crumb.type = 'button';
      crumb.dataset.folder = path;
      const target = path;
      crumb.addEventListener('click', () => handlers.onOpenFolder?.(target));
      nav.append(crumb);
    }
  }
  return nav;
}

function statCard(value, label, { role, basis } = {}) {
  const card = element('div', 'stat-card');
  const valueNode = element('div', 'stat-value', value);
  if (role) {
    valueNode.dataset.role = role;
  }
  if (basis) {
    valueNode.dataset.basis = basis;
  }
  card.append(valueNode, element('div', 'stat-label', label));
  return card;
}

function coverageTotals(totals, threshold) {
  const cards = element('div', 'stat-cards coverage-totals');
  cards.dataset.role = 'coverage-totals';
  if (!totals) {
    cards.append(note('No totals were recorded.'));
    return cards;
  }
  cards.append(
    statCard(String(totals.files ?? 0), 'Files'),
    statCard(String(totals.filesMeasured ?? 0), 'Measured'),
    statCard(String(totals.notInReport ?? 0), 'Not in report'),
    statCard(String(totals.reached ?? 0), 'Reached by a test'),
    statCard(String(totals.untested ?? 0), `Under ${threshold ?? 50}% / unreached`),
    statCard(`${totals.linesHit ?? 0}/${totals.linesFound ?? 0}`, 'Lines hit / found'),
    statCard(coverageTotalsLabel(totals), 'Coverage', {
      role: 'coverage-value',
      basis: totals.basis,
    }),
  );
  return cards;
}

function coverageFolders(folders, handlers) {
  const section = element('section', 'coverage-folders');
  section.append(element('h4', null, `Folders (${folders.length})`));
  if (folders.length === 0) {
    section.append(note('No subfolders recorded at this scope.'));
    return section;
  }
  const table = element('table', 'coverage-table');
  const head = element('thead');
  const headRow = element('tr');
  for (const label of ['Folder', 'Files', 'Measured', 'Not in report', 'Reached', 'Untested', 'Coverage']) {
    const cell = element('th', null, label);
    cell.scope = 'col';
    headRow.append(cell);
  }
  head.append(headRow);
  const body = element('tbody');
  for (const folder of folders) {
    const row = element('tr', 'coverage-folder-row');
    row.dataset.folder = folder.folder;

    const nameCell = element('td');
    const open = element('button', 'link coverage-folder-link', folder.folder);
    open.type = 'button';
    open.addEventListener('click', () => handlers.onOpenFolder?.(folder.folder));
    nameCell.append(open);
    row.append(nameCell);

    row.append(element('td', 'coverage-count', String(folder.files ?? 0)));
    row.append(element('td', 'coverage-count', String(folder.filesMeasured ?? 0)));
    row.append(element('td', 'coverage-count', String(folder.notInReport ?? 0)));
    row.append(element('td', 'coverage-count', String(folder.reached ?? 0)));
    row.append(element('td', 'coverage-count', String(folder.untested ?? 0)));

    const coverageCell = element('td');
    coverageCell.append(figureCell(coverageEntryLabel(folder), folder.basis));
    row.append(coverageCell);
    body.append(row);
  }
  table.append(head, body);
  section.append(table);
  return section;
}

function coverageFiles(files, handlers) {
  const section = element('section', 'coverage-files-section');
  section.append(element('h4', null, `Files (${files.length})`));
  if (files.length === 0) {
    section.append(note('No files sit directly in this folder.'));
    return section;
  }
  const list = element('ul', 'passport-list coverage-files');
  for (const file of files) {
    const item = element('li', 'coverage-file-row');
    item.dataset.file = file.file;
    item.dataset.delegateNode = file.file;

    const open = element('button', 'link', file.file);
    open.type = 'button';
    open.addEventListener('click', () => handlers.onSelect?.(file.file));
    item.append(open);

    item.append(figureCell(coverageEntryLabel(file), file.basis));

    const facts = [];
    if (file.linesFound !== null && file.linesFound !== undefined) {
      facts.push(`${file.linesHit ?? 0}/${file.linesFound} lines`);
    }
    if (file.notInReport) {
      facts.push('not in report');
    }
    if (file.untested) {
      facts.push('untested');
    }
    if (file.stale === true) {
      facts.push('stale');
    }
    if (facts.length > 0) {
      item.append(element('span', 'evidence', facts.join(' · ')));
    }
    list.append(item);
  }
  section.append(list);
  return section;
}

/**
 * Render the Module Passport's Coverage section for one file: the basis and figure, its lines,
 * staleness and report age, and the tests that reach it and the files that import it as
 * clickable links. `handlers.onSelect(id)` selects a file, exactly as the Dependencies list does.
 */
export function renderCoverageFile(container, report, handlers = {}) {
  container.replaceChildren();
  container.append(element('h3', null, 'Coverage'));

  if (report?.unsupported) {
    container.append(note(report.unsupported));
    return;
  }

  if (report?.error) {
    container.append(note(report.error));
    if (handlers.onRetry) {
      const retry = element('button', 'link', 'Retry');
      retry.type = 'button';
      retry.dataset.role = 'coverage-retry';
      retry.addEventListener('click', () => handlers.onRetry());
      container.append(retry);
    }
    return;
  }

  const entry = report?.file;
  if (!entry) {
    container.append(note('Coverage is unavailable for this selection.'));
    return;
  }

  container.append(provenanceLine(report.provenance));

  const figure = element('p', 'coverage-file-figure');
  figure.dataset.role = 'coverage-file-figure';
  figure.dataset.basis = entry.basis ?? 'unavailable';
  figure.append(
    element('span', 'coverage-basis', entry.basis === 'measured' ? 'measured coverage' : 'static test-reach'),
    document.createTextNode(' · '),
    figureCell(coverageEntryLabel(entry), entry.basis),
  );
  container.append(figure);

  const facts = element('dl', 'coverage-facts');
  const fact = (term, value) => {
    facts.append(element('dt', null, term), element('dd', null, value));
  };
  fact('Basis', entry.basis === 'measured' ? 'measured (a report was read)' : 'reachable (test-reach, not executed coverage)');
  if (entry.notInReport) {
    fact('Report', 'the report does not name this file');
  }
  if (entry.basis === 'measured' && (entry.value === null || entry.value === undefined)) {
    fact('Lines', 'unavailable — the report records no line counts for this file');
  } else if (entry.linesFound !== null && entry.linesFound !== undefined) {
    fact('Lines', `${entry.linesHit ?? 0} hit / ${entry.linesFound} found`);
  }
  if (entry.stale === true) {
    fact('Freshness', 'stale — the report predates this file’s last commit');
  } else if (entry.stale === false) {
    fact('Freshness', 'unchanged since the report');
  }
  const age = report.provenance?.reportAgeMs;
  if (age !== null && age !== undefined) {
    fact('Report age', `${coverageAge(age)} old`);
  }
  fact('Untested', entry.untested ? `yes — under the ${report.threshold ?? 50}% / reached cut-off` : 'no');
  container.append(facts);

  container.append(
    fileLinkList('Tests that reach it', entry.tests ?? [], handlers, 'No test reaches this file.'),
  );
  container.append(
    fileLinkList('Importers', entry.importers ?? [], handlers, 'No file imports this one.'),
  );
}

function fileLinkList(title, files, handlers, emptyText) {
  const section = element('section', 'coverage-link-list');
  section.append(element('h4', null, `${title} (${files.length})`));
  if (files.length === 0) {
    section.append(note(emptyText));
    return section;
  }
  const list = element('ul', 'passport-list');
  for (const file of files) {
    const item = element('li');
    item.dataset.delegateNode = file;
    const open = element('button', 'link', file);
    open.type = 'button';
    open.addEventListener('click', () => handlers.onSelect?.(file));
    item.append(open);
    list.append(item);
  }
  section.append(list);
  return section;
}
