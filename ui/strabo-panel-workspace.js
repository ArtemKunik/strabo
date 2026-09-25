/**
 * The read-only workspace panel and the repository passport.
 *
 * Split out of strabo-panels.js.
 */

import {
  compatRows,
  contractRows,
  databaseRows,
  driftRows,
  flowRows,
  liveDriftRows,
  preflightRows,
  probeConsent,
  repositoryRows,
  schemaDriftRows,
  schemaGapRows,
  schemaRows,
  serviceEndpointRows,
  serviceFlowRows,
  usageCaption,
  usageFindingRows,
  workspaceSummary,
} from './strabo-workspace.js';

import { button, matches } from './strabo-panel-kit.js';


function workspaceHeading(text, count) {
  const heading = document.createElement('h4');
  heading.textContent = `${text} (${count})`;
  return heading;
}


function workspaceNote(text) {
  const note = document.createElement('p');
  note.className = 'unavailable';
  note.textContent = text;
  return note;
}


function workspaceList(className, rows, fill) {
  const list = document.createElement('ul');
  list.className = className;
  for (const row of rows) {
    const item = document.createElement('li');
    item.className = 'workspace-row';
    fill(item, row);
    list.append(item);
  }
  return list;
}


/**
 * Render the read-only workspace: repositories, cross-repo flows, contracts, and drift.
 *
 * Unrecorded sections say so rather than showing an empty list, and a shared contract that
 * matches field-for-field is kept and labelled clean rather than hidden.
 */
export function renderWorkspace(container, report, handlers = {}) {
  container.replaceChildren();

  const title = document.createElement('h3');
  title.textContent = `Workspace — ${report?.name ?? 'unnamed'}`;
  container.append(title);

  const summary = document.createElement('p');
  summary.className = 'workspace-summary';
  summary.textContent = workspaceSummary(report);
  container.append(summary);

  const repositories = repositoryRows(report);
  container.append(workspaceHeading('Repositories', repositories.length));
  container.append(
    repositories.length === 0
      ? workspaceNote('No repositories recorded.')
      : workspaceList('workspace-repositories', repositories, (item, repository) => {
          const name = document.createElement('div');
          name.className = 'workspace-name';
          name.textContent = repository.name;
          item.append(name);
          const facts = [
            repository.head ? `@${repository.head}` : 'no commit recorded',
            repository.dirty ? 'dirty' : 'clean',
          ];
          if (repository.publishes) {
            facts.push(`publishes ${repository.publishes}`);
          }
          const detail = document.createElement('div');
          detail.className = 'workspace-detail';
          detail.textContent = facts.join(' · ');
          item.append(detail);
        }),
  );

  const flows = flowRows(report);
  container.append(workspaceHeading('Cross-repo flows', flows.length));
  container.append(
    flows.length === 0
      ? workspaceNote('No cross-repo flows recorded.')
      : workspaceList('workspace-flows', flows, (item, flow) => {
          item.textContent = flow.label;
          const detail = document.createElement('div');
          detail.className = 'workspace-detail';
          detail.textContent =
            `${flow.files} file${flow.files === 1 ? '' : 's'}` +
            (flow.publishedBy ? ` · published by ${flow.publishedBy}` : '');
          item.append(detail);
        }),
  );

  const endpoints = serviceEndpointRows(report);
  container.append(workspaceHeading('Service endpoints', endpoints.length));
  container.append(
    endpoints.length === 0
      ? workspaceNote('No service endpoints recorded.')
      : workspaceList('workspace-endpoints', endpoints, (item, endpoint) => {
          item.textContent = `${endpoint.label} — ${endpoint.repository}`;
          const detail = document.createElement('div');
          detail.className = 'workspace-detail';
          detail.textContent = endpoint.source;
          item.append(detail);
        }),
  );

  const serviceFlows = serviceFlowRows(report);
  container.append(workspaceHeading('Service flows', serviceFlows.length));
  container.append(
    serviceFlows.length === 0
      ? workspaceNote('No service flows recorded.')
      : workspaceList('workspace-service-flows', serviceFlows, (item, flow) => {
          item.textContent = flow.label;
          const detail = document.createElement('div');
          detail.className = 'workspace-detail';
          detail.textContent =
            `${flow.calls} call${flow.calls === 1 ? '' : 's'}` +
            (flow.declaredBy ? ` · declared by ${flow.declaredBy}` : '');
          item.append(detail);
        }),
  );

  const contracts = contractRows(report);
  container.append(workspaceHeading('Contracts', contracts.length));
  container.append(
    contracts.length === 0
      ? workspaceNote('No contracts recorded.')
      : workspaceList('workspace-contracts', contracts, (item, contract) => {
          item.textContent = contract.label;
          const detail = document.createElement('div');
          detail.className = 'workspace-detail';
          detail.textContent = `${contract.fields} field${contract.fields === 1 ? '' : 's'}`;
          item.append(detail);
        }),
  );

  const drift = driftRows(report);
  container.append(workspaceHeading('Contract drift', drift.length));
  container.append(
    drift.length === 0
      ? workspaceNote('No shared contracts recorded.')
      : workspaceList('workspace-drift', drift, (item, entry) => {
          item.textContent = entry.label;
          const detail = document.createElement('div');
          detail.className = 'workspace-detail';
          detail.textContent = entry.clean ? 'clean — definitions match' : entry.deviations.join('; ');
          item.append(detail);
        }),
  );

  const tables = schemaRows(report);
  container.append(workspaceHeading('Database schema', tables.length));
  container.append(
    tables.length === 0
      ? workspaceNote('No SQL schema recorded.')
      : workspaceList('workspace-schema', tables, (item, table) => {
          item.textContent = table.label;
          const detail = document.createElement('div');
          detail.className = 'workspace-detail';
          detail.textContent = table.detail;
          item.append(detail);
        }),
  );
  const gaps = schemaGapRows(report);
  if (gaps.length > 0) {
    container.append(workspaceHeading('Schema gaps', gaps.length));
    container.append(
      workspaceList('workspace-schema-gaps', gaps, (item, gap) => {
        item.textContent = gap.label;
        const detail = document.createElement('div');
        detail.className = 'workspace-detail';
        detail.textContent = `not applied: ${gap.reason}`;
        item.append(detail);
      }),
    );
  }

  const schemaDrift = schemaDriftRows(report);
  if (schemaDrift.length > 0) {
    container.append(workspaceHeading('Table drift', schemaDrift.length));
    container.append(
      workspaceList('workspace-table-drift', schemaDrift, (item, entry) => {
        item.textContent = entry.label;
        const detail = document.createElement('div');
        detail.className = 'workspace-detail';
        detail.textContent = entry.clean ? 'clean — declarations match' : entry.deviations.join('; ');
        item.append(detail);
      }),
    );
  }

  const findings = usageFindingRows(report);
  container.append(workspaceHeading('Code against schema', findings.length));
  container.append(workspaceNote(usageCaption(report)));
  if (findings.length > 0) {
    container.append(
      workspaceList('workspace-usage', findings, (item, finding) => {
        item.textContent = finding.label;
        const detail = document.createElement('div');
        detail.className = 'workspace-detail';
        detail.textContent = finding.detail;
        item.append(detail);
      }),
    );
  }

  if (handlers.tools) {
    renderWorkspaceTools(container, handlers.tools, handlers);
  }

  if (handlers.onClose) {
    const close = document.createElement('button');
    close.type = 'button';
    close.id = 'close-workspace';
    close.textContent = 'Close';
    close.addEventListener('click', () => handlers.onClose());
    container.append(close);
  }
}


function workspaceButton(label, action, onClick, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.action = action;
  button.disabled = disabled;
  button.addEventListener('click', () => onClick?.());
  return button;
}


function workspaceLine(className, text) {
  const line = document.createElement('div');
  line.className = className;
  line.textContent = text;
  return line;
}


/**
 * The compatibility, preflight and live-database part of the Workspace panel.
 *
 * Everything shown is what a route recorded: a revision that could not be read says so, a
 * check that did not run says "not run", and a check that could not run is never drawn as a
 * pass. Running against a database is a two-step action that states what it will do first.
 */
export function renderWorkspaceTools(container, tools, handlers = {}) {
  const busy = Boolean(tools.busy);
  const section = document.createElement('section');
  section.className = 'workspace-tools';
  container.append(section);

  const heading = document.createElement('h4');
  heading.textContent = 'Compatibility and migrations';
  section.append(heading);

  const form = document.createElement('div');
  form.className = 'workspace-tools-form';
  const label = document.createElement('label');
  label.textContent = 'Compare with ';
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'workspace-base';
  input.value = tools.base ?? 'HEAD';
  input.placeholder = 'HEAD, a branch, a tag or a commit';
  input.spellcheck = false;
  input.addEventListener('input', () => handlers.onBase?.(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      handlers.onCompat?.();
    }
  });
  label.append(input);
  form.append(label);
  form.append(workspaceButton('Compare', 'compat', handlers.onCompat, busy));
  form.append(workspaceButton('Preflight queries', 'preflight', handlers.onPreflight, busy));
  if (tools.scriptHref) {
    const link = document.createElement('a');
    link.href = tools.scriptHref;
    link.textContent = 'SQL script';
    link.download = 'strabo-preflight.sql';
    link.className = 'workspace-script-link';
    form.append(link);
  }
  section.append(form);

  if (tools.busy) {
    section.append(workspaceNote(`Working: ${tools.busy}…`));
  }
  if (tools.error) {
    const error = workspaceNote(tools.error);
    error.classList.add('workspace-error');
    section.append(error);
  }

  for (const group of compatRows(tools.compat)) {
    section.append(workspaceLine('workspace-group', group.repository));
    section.append(workspaceNote(group.caption));
    if (group.rows.length > 0) {
      section.append(
        workspaceList('workspace-compat', group.rows, (item, row) => {
          const badge = document.createElement('span');
          badge.className = `compat-badge compat-${row.compatibility}`;
          badge.textContent = row.badge;
          item.append(badge, ` ${row.label}`);
          item.append(workspaceLine('workspace-detail', row.reason));
          if (row.detail.length > 0) {
            item.append(workspaceLine('workspace-detail', row.detail.join(' · ')));
          }
        }),
      );
    }
  }

  const preflightGroups = preflightRows(tools.preflight);
  for (const group of preflightGroups) {
    section.append(workspaceLine('workspace-group', `${group.repository} · preflight`));
    section.append(workspaceNote(group.caption));
    if (group.checks.length > 0) {
      section.append(
        workspaceList('workspace-preflight', group.checks, (item, check) => {
          const details = document.createElement('details');
          const summary = document.createElement('summary');
          const badge = document.createElement('span');
          badge.className = `compat-badge preflight-${check.status}`;
          badge.textContent = check.severity === 'data-loss' ? 'data loss' : 'blocks';
          summary.append(badge, ` ${check.label} — ${check.result}`);
          details.append(summary);
          details.append(workspaceLine('workspace-detail', `A count above zero means: ${check.failsWhen}`));
          if (check.approximate) {
            details.append(workspaceLine('workspace-detail', 'Approximate: the engine has the final say.'));
          }
          if (check.references.length > 0) {
            details.append(workspaceLine('workspace-detail', `Code that still uses it: ${check.references.join(', ')}`));
          }
          const sql = document.createElement('pre');
          sql.className = 'workspace-sql';
          sql.textContent = check.sql;
          details.append(sql);
          item.append(details);
        }),
      );
    }
    if (group.skipped.length > 0) {
      section.append(
        workspaceList('workspace-preflight-skipped', group.skipped, (item, entry) => {
          item.textContent = `not checked: ${entry.label}`;
          item.append(workspaceLine('workspace-detail', entry.reason));
        }),
      );
    }
  }

  const databases = databaseRows(tools.databases);
  const liveHeading = document.createElement('h4');
  liveHeading.textContent = `Live database (${databases.length})`;
  section.append(liveHeading);
  if (databases.length === 0) {
    section.append(
      workspaceNote('No database is declared. Add databases to the workspace config, naming an environment variable, to probe one read-only.'),
    );
  }
  const checkCount = preflightGroups.reduce((total, group) => total + group.checks.length, 0);
  for (const database of databases) {
    const row = document.createElement('div');
    row.className = 'workspace-database';
    row.append(workspaceLine('workspace-name', database.label));
    row.append(workspaceLine('workspace-detail', database.note));
    const actions = document.createElement('div');
    actions.className = 'workspace-tools-form';
    actions.append(
      workspaceButton(
        'Run preflight checks…',
        'run-preflight',
        () => handlers.onConfirmRun?.(database.name),
        busy || !database.configured || checkCount === 0,
      ),
      workspaceButton('Read live schema', 'live-schema', () => handlers.onLive?.(database.name), busy || !database.configured),
    );
    row.append(actions);
    if (database.configured && checkCount === 0) {
      row.append(workspaceLine('workspace-detail', 'Build the preflight queries first.'));
    }
    if (tools.confirming === database.name) {
      const consent = document.createElement('div');
      consent.className = 'workspace-consent';
      consent.append(workspaceLine('workspace-detail', probeConsent(database.name, checkCount)));
      const buttons = document.createElement('div');
      buttons.className = 'workspace-tools-form';
      buttons.append(
        workspaceButton('Run', 'confirm-run', () => handlers.onRun?.(database.name), busy),
        workspaceButton('Cancel', 'cancel-run', () => handlers.onCancelRun?.()),
      );
      consent.append(buttons);
      row.append(consent);
    }
    section.append(row);
  }

  if (tools.live) {
    const drift = liveDriftRows(tools.live);
    const tableCount = tools.live.tables;
    section.append(
      workspaceLine(
        'workspace-group',
        `${tools.live.database} · live schema (${tableCount} table${tableCount === 1 ? '' : 's'}, read ${tools.live.capturedAt})`,
      ),
    );
    section.append(
      drift.length === 0
        ? workspaceNote('The live database and the migrations agree.')
        : workspaceList('workspace-live-drift', drift, (item, entry) => {
            item.textContent = entry.label;
            item.append(workspaceLine('workspace-detail', entry.text));
          }),
    );
  }

  const runs = tools.databases?.runs ?? [];
  if (runs.length > 0) {
    section.append(workspaceLine('workspace-group', 'Recent probe runs'));
    section.append(
      workspaceList('workspace-runs', runs, (item, run) => {
        item.textContent =
          `${run.at} · ${run.database} · ${run.kind}` +
          (run.error
            ? ` · refused: ${run.error}`
            : run.kind === 'preflight'
              ? ` · ${run.checks} checks, ${run.violations} with violations, ${run.errors} errors`
              : ` · ${run.checks} tables`);
      }),
    );
  }
}


function passportSection(title, count) {
  const heading = document.createElement('h4');
  heading.className = 'passport-section-heading';
  heading.textContent = `${title} (${count})`;
  return heading;
}


function passportNote(text) {
  const note = document.createElement('p');
  note.className = 'unavailable';
  note.textContent = text;
  return note;
}


function passportFileList(entries, handlers, label) {
  const list = document.createElement('ul');
  list.className = 'passport-list';
  for (const entry of entries) {
    const item = document.createElement('li');
    const id = entry.file ?? entry.id;
    item.dataset.delegateNode = id;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'link';
    open.textContent = id;
    open.addEventListener('click', () => handlers.onSelect?.(id));
    item.append(open);
    const detail = label(entry);
    if (detail) {
      const span = document.createElement('span');
      span.className = 'evidence';
      span.textContent = detail;
      item.append(span);
    }
    list.append(item);
  }
  return list;
}


/**
 * The graph fingerprint and scan time behind a passport, with a stale label when the served
 * graph is older than the working tree (T6). Never invents a revision: an absent fingerprint
 * yields no line at all.
 */
export function passportProvenanceText(provenance) {
  if (!provenance || !provenance.fingerprint) {
    return '';
  }
  const short = String(provenance.fingerprint).split(':')[0]?.slice(0, 7) || provenance.fingerprint;
  const scanned = provenance.scannedAt
    ? ` · scanned ${provenance.scannedAt.slice(0, 19).replace('T', ' ')}`
    : '';
  const behind =
    typeof provenance.behind === 'number' && provenance.behind > 0
      ? ` · ${provenance.behind} behind`
      : '';
  const stale = provenance.stale === true ? ' · stale: the working tree has moved on' : '';
  return `graph ${short}${scanned}${behind}${stale}`;
}


/** A list of rows that name no selectable file (languages, directories). */
function passportPlainList(entries, label) {
  const list = document.createElement('ul');
  list.className = 'passport-list';
  for (const entry of entries) {
    const item = document.createElement('li');
    item.textContent = label(entry);
    list.append(item);
  }
  return list;
}


/**
 * "Start here": the three jobs people open Strabo for, each one click from the passport that
 * greets a first visit. A job whose handler is absent is left out, never drawn inert.
 */
function passportStartHere(handlers) {
  const jobs = [
    ['onOpenRoute', 'open-route', 'Learn this codebase', 'Read the files in order, starting from the entry points'],
    ['onReviewChange', 'start-review', 'Review my change', 'What your uncommitted changes reach, and which tests to run'],
    ['onCheckBranches', 'start-branches', 'Check a branch before merging', 'Ahead and behind, conflicts, and what the branch reaches'],
  ].filter(([key]) => typeof handlers[key] === 'function');
  if (jobs.length === 0) {
    return null;
  }
  const block = document.createElement('div');
  block.className = 'passport-start';
  block.dataset.role = 'passport-start';
  const heading = document.createElement('h4');
  heading.textContent = 'Start here';
  block.append(heading);
  for (const [key, id, label, hint] of jobs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = id;
    button.className = 'passport-job';
    const name = document.createElement('strong');
    name.textContent = label;
    const detail = document.createElement('span');
    detail.textContent = hint;
    button.append(name, detail);
    button.addEventListener('click', () => handlers[key]());
    block.append(button);
  }
  return block;
}

/**
 * The Repository passport: the opening summary for an unfamiliar repository.
 *
 * Languages, size, entry points, top-level layers, the files that decide the codebase by
 * fan-in, cycles, and what no test reaches. A section with no recorded evidence says so
 * rather than showing an empty list, and every number comes from the scan.
 */
export function renderRepositoryPassport(container, report, handlers = {}) {
  container.replaceChildren();

  const title = document.createElement('h3');
  title.textContent = `Repository passport — ${report?.repository ?? 'repository'}`;
  container.append(title);

  if (!report) {
    container.append(passportNote('No passport was recorded for this repository.'));
    return;
  }

  const provenance = report.provenance ?? null;
  if (provenance && provenance.fingerprint) {
    const line = document.createElement('p');
    line.className = provenance.stale === true ? 'evidence is-stale' : 'evidence';
    line.dataset.role = 'passport-provenance';
    line.textContent = passportProvenanceText(provenance);
    container.append(line);
  }

  const size = report.size ?? {};
  const summary = document.createElement('p');
  summary.className = 'passport-summary';
  summary.textContent =
    `${size.files ?? 0} files · ${size.edges ?? 0} edges · ${size.directories ?? 0} directories · ` +
    `${size.tests ?? 0} tests · ${size.diagnostics ?? 0} diagnostics · ${size.excluded ?? 0} excluded`;
  container.append(summary);

  const start = passportStartHere(handlers);
  if (start) {
    container.append(start);
  }

  const languages = report.languages ?? [];
  container.append(passportSection('Languages', languages.length));
  container.append(
    languages.length === 0
      ? passportNote('No source languages recorded.')
      : passportPlainList(languages, (entry) => `${entry.language} · ${entry.files} file(s)`),
  );

  const entryPoints = report.entryPoints ?? [];
  container.append(passportSection('Entry points', entryPoints.length));
  container.append(
    entryPoints.length === 0
      ? passportNote('No entry point declared by a manifest (package.json, Cargo.toml, pom.xml).')
      : passportFileList(entryPoints, handlers, (entry) => entry.reason),
  );

  const directories = report.topDirectories ?? report.layers ?? [];
  container.append(passportSection('Top-level directories', directories.length));
  container.append(
    directories.length === 0
      ? passportNote('No directories recorded.')
      : passportPlainList(
          directories,
          (entry) => `${entry.directory} · ${entry.files} file(s) · ${entry.incoming} incoming`,
        ),
  );

  const topFiles = report.topFiles ?? [];
  container.append(passportSection('Most depended-upon files (by fan-in)', topFiles.length));
  container.append(
    topFiles.length === 0
      ? passportNote('No files recorded.')
      : passportFileList(
          topFiles,
          handlers,
          (entry) => {
            const base =
              `${entry.fanIn} importer(s) · blast radius ${entry.transitiveDependents} · ${entry.kind}`;
            return entry.reExports > 0 ? `${base} · ${entry.reExports} re-export(s)` : base;
          },
        ),
  );

  const cycles = report.cycles ?? { total: 0, largest: [] };
  container.append(passportSection('Cycles', cycles.total ?? 0));
  if ((cycles.largest ?? []).length === 0) {
    container.append(passportNote('No dependency cycles recorded.'));
  } else {
    const list = document.createElement('ul');
    list.className = 'passport-list';
    for (const group of cycles.largest) {
      const item = document.createElement('li');
      item.textContent = `${group.size} file(s): ${group.members.join(' ↔ ')}`;
      list.append(item);
    }
    container.append(list);
  }

  const untested = report.untested ?? { total: 0, files: [] };
  const measured = untested.basis === 'measured';
  container.append(
    passportSection(
      measured ? `Used and under ${untested.threshold}% measured` : 'Used but no test reaches',
      untested.total ?? 0,
    ),
  );
  const figures = untested.figures ?? (untested.files ?? []).map((file) => ({ file, value: null, stale: null }));
  container.append(
    figures.length === 0
      ? passportNote(
          measured
            ? `Every used module the report names is at or above ${untested.threshold}% measured.`
            : 'Every used module is reachable from a test, or no test file was identified.',
        )
      : passportFileList(figures, handlers, (figure) =>
          figure.value === null ? '' : `measured ${figure.value}%${figure.stale ? ' · stale' : ''}`,
        ),
  );
  if (measured && untested.notInReport > 0) {
    container.append(passportNote(`${untested.notInReport} used module(s) not in the coverage report.`));
  }

  if (handlers.onExportReport) {
    const bar = document.createElement('p');
    bar.className = 'passport-export';
    const select = document.createElement('select');
    select.id = 'report-format';
    select.title = 'Report format';
    for (const [value, text] of [
      ['md', 'Markdown'],
      ['json', 'JSON'],
      ['html', 'HTML (print to PDF)'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.append(option);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'export-report';
    button.textContent = 'Export report';
    button.title = 'Download the repository report: pain points, pending change set, and suggestions';
    button.addEventListener('click', () => handlers.onExportReport(select.value));
    bar.append(select, button);
    container.append(bar);
  }

  if (handlers.onClose) {
    const close = document.createElement('button');
    close.type = 'button';
    close.id = 'close-passport';
    close.textContent = 'View the map';
    close.addEventListener('click', () => handlers.onClose());
    container.append(close);
  }
}
