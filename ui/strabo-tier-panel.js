/**
 * The tier lens panel: the tier × unit matrix, the per-tier shares, the direction check,
 * and the table index.
 *
 * DOM only; all shaping comes from the pure helpers in `strabo-tiers.js`. An empty cell is
 * drawn as `·` rather than blank, because a unit with no Data tier is information.
 */

import {
  TIER_LABELS,
  TIER_ORDER,
  tierCallSites,
  tierColorVar,
  tierDirectionLabel,
  tierEndpointSites,
  tierLimits,
  tierMatrixRows,
  tierPerTierRows,
  tierSummaryLabel,
  tierTableTrace,
  tierTables,
  tierTraces,
} from './strabo-tiers.js';

function headerCell(text) {
  const cell = document.createElement('th');
  cell.textContent = text;
  return cell;
}

/** A count with thousands separators, so `43609` scans as `43,609`. */
function formatCount(value) {
  return Number(value).toLocaleString('en-US');
}

function numberCell(text, title) {
  const cell = document.createElement('td');
  cell.className = 'num';
  cell.textContent = text;
  if (title) {
    cell.title = title;
  }
  return cell;
}

function optionOf(text, value) {
  const option = document.createElement('option');
  option.textContent = text;
  option.value = value;
  return option;
}

/** How many unclassified files the panel lists before saying how many more there are. */
const UNCLASSIFIED_LIMIT = 40;

/**
 * The files no rule or signal placed, each with an "Assign to…" menu. Picking a tier writes
 * a declaration to `strabo.groups.yml` through `onAssign(glob, tier)`, for the file alone or
 * for its whole folder (`dir/**`), and the row says what was written or why it failed.
 */
function renderUnclassified(container, report, onAssign) {
  const files = (report?.files ?? []).filter((entry) => entry.tier === 'unclassified');
  if (files.length === 0) {
    return;
  }
  const section = document.createElement('div');
  section.className = 'tier-unclassified';
  section.dataset.role = 'tier-unclassified';

  const heading = document.createElement('h4');
  heading.textContent = `Unclassified (${files.length})`;
  section.append(heading);

  const note = document.createElement('p');
  note.className = 'overlay-note';
  note.textContent = 'Pick a tier to declare it in strabo.groups.yml; the map re-reads it at once.';
  section.append(note);

  let scope = 'file';
  const scopes = document.createElement('div');
  scopes.className = 'tier-assign-scope';
  scopes.setAttribute('role', 'group');
  scopes.setAttribute('aria-label', 'What an assignment covers');
  for (const [value, text] of [
    ['file', 'This file'],
    ['folder', 'Whole folder'],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.dataset.scope = value;
    button.setAttribute('aria-pressed', String(value === scope));
    button.addEventListener('click', () => {
      scope = value;
      for (const other of scopes.children) other.setAttribute('aria-pressed', String(other.dataset.scope === scope));
    });
    scopes.append(button);
  }
  section.append(scopes);

  const list = document.createElement('ul');
  for (const entry of [...files].sort((a, b) => a.file.localeCompare(b.file)).slice(0, UNCLASSIFIED_LIMIT)) {
    const item = document.createElement('li');
    item.dataset.role = 'tier-unclassified-file';
    const name = document.createElement('span');
    name.className = 'tier-unclassified-path';
    name.textContent = entry.file;
    name.title = entry.file;
    const select = document.createElement('select');
    select.setAttribute('aria-label', `Assign ${entry.file} to a tier`);
    select.append(optionOf('Assign to…', ''));
    for (const tier of TIER_ORDER.filter((candidate) => candidate !== 'unclassified')) {
      select.append(optionOf(TIER_LABELS[tier], tier));
    }
    const status = document.createElement('span');
    status.className = 'tier-assign-status';
    select.addEventListener('change', async () => {
      const tier = select.value;
      if (!tier) return;
      const folder = entry.file.includes('/') ? entry.file.slice(0, entry.file.lastIndexOf('/')) : '';
      const glob = scope === 'folder' && folder ? `${folder}/**` : entry.file;
      select.disabled = true;
      status.textContent = 'saving…';
      try {
        await onAssign(glob, tier);
        status.textContent = `→ ${TIER_LABELS[tier]} (${glob})`;
      } catch (error) {
        status.textContent = error.message;
        select.disabled = false;
        select.value = '';
      }
    });
    item.append(name, select, status);
    list.append(item);
  }
  section.append(list);
  if (files.length > UNCLASSIFIED_LIMIT) {
    const more = document.createElement('p');
    more.className = 'overlay-note';
    more.textContent = `${files.length - UNCLASSIFIED_LIMIT} more; assigning a folder covers many at once.`;
    section.append(more);
  }
  container.append(section);
}

export function renderTierPanel(container, report, filter = 'all', options = {}) {
  container.replaceChildren();
  // The panel is shared with the analysis overlays, whose render hides it when their report
  // is absent; taking it over means showing it.
  container.hidden = false;
  container.className = 'overlay-panel';

  const title = document.createElement('h3');
  title.textContent = 'Tier lens';
  if (options.onClose) {
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'panel-dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss tier lens panel');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => options.onClose());
    title.append(dismiss);
  }
  container.append(title);

  const note = document.createElement('p');
  note.className = 'overlay-note';
  note.textContent = tierSummaryLabel(report);
  container.append(note);

  // The named limits (Y9): what this reading cannot claim, said plainly rather than hidden.
  const limits = document.createElement('ul');
  limits.className = 'tier-limits';
  limits.dataset.role = 'tier-limits';
  for (const limit of tierLimits(report)) {
    const item = document.createElement('li');
    item.className = 'tier-limit';
    item.textContent = limit;
    limits.append(item);
  }
  container.append(limits);

  const rows = tierMatrixRows(report);
  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'unavailable';
    empty.textContent = 'No file was classified into a tier.';
    container.append(empty);
    return;
  }

  // A per-unit column only says something when there is more than one unit; with one, it
  // repeats the Files column.
  const allUnits = report?.matrix?.units ?? [];
  const units = allUnits.length > 1 ? allUnits : [];
  const table = document.createElement('table');
  table.className = 'tier-matrix';
  const head = document.createElement('tr');
  head.append(headerCell('Tier'));
  for (const unit of units) {
    // A unit column is named by its last path segment; the full path rides on the title,
    // so a deep monorepo path cannot stretch the table past the panel.
    const header = headerCell(unit === '.' ? '/' : unit.split('/').pop());
    header.title = unit === '.' ? 'repository root' : unit;
    header.classList.add('tier-unit');
    head.append(header);
  }
  head.append(headerCell('Files'), headerCell('Lines'));
  for (const cell of [...head.children].slice(1)) {
    cell.classList.add('num');
  }
  table.append(head);

  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.role = 'tier-row';
    tr.dataset.tier = row.tier;
    if (filter !== 'all' && filter === row.tier) {
      tr.classList.add('is-selected');
    }
    const name = document.createElement('th');
    const swatch = document.createElement('span');
    swatch.className = 'tier-swatch';
    swatch.style.background = tierColorVar(row.tier);
    name.append(swatch, row.label);
    tr.append(name);
    for (const cell of units.length > 0 ? row.cells : []) {
      tr.append(numberCell(cell.files === 0 ? '·' : formatCount(cell.files), `${formatCount(cell.lines)} line(s)`));
    }
    tr.append(numberCell(formatCount(row.files)), numberCell(formatCount(row.lines)));
    table.append(tr);
  }
  // Many units can still outgrow the panel; the table scrolls sideways rather than clip.
  const scroller = document.createElement('div');
  scroller.className = 'tier-matrix-scroll';
  scroller.append(table);
  container.append(scroller);

  const shares = document.createElement('p');
  shares.className = 'tier-shares';
  shares.dataset.role = 'tier-shares';
  shares.textContent = tierPerTierRows(report)
    .map((entry) => `${entry.label} ${entry.shareLabel}`)
    .join(' · ');
  container.append(shares);

  if (options.onAssign) {
    renderUnclassified(container, report, options.onAssign);
  }

  // The direction check: a count, then each wrong-way edge with its line.
  const directionNote = document.createElement('p');
  directionNote.className = 'overlay-note';
  directionNote.dataset.role = 'tier-directions';
  directionNote.textContent = tierDirectionLabel(report);
  container.append(directionNote);
  for (const entry of report?.directions ?? []) {
    const item = document.createElement('div');
    item.className = 'tier-direction';
    item.dataset.role = 'tier-direction';
    item.textContent = `${entry.kind === 'upward' ? 'upward' : 'skip-layer'} · ${entry.source} → ${entry.target} (L${entry.line})`;
    container.append(item);
  }

  // The top half of the end-to-end trace: outbound call sites and the endpoints declared here.
  const calls = tierCallSites(report);
  if (calls.length > 0) {
    const heading = document.createElement('h4');
    heading.textContent = 'Calls';
    container.append(heading);
    for (const call of calls.slice(0, 20)) {
      const item = document.createElement('div');
      item.className = 'tier-call';
      item.dataset.role = 'tier-call';
      item.textContent = `${call.method ?? 'CALL'} ${call.target} · ${call.file}:${call.line}`;
      container.append(item);
    }
  }

  const endpoints = tierEndpointSites(report);
  if (endpoints.length > 0) {
    const heading = document.createElement('h4');
    heading.textContent = 'Endpoints';
    container.append(heading);
    for (const endpoint of endpoints.slice(0, 20)) {
      const item = document.createElement('div');
      item.className = 'tier-endpoint';
      item.dataset.role = 'tier-endpoint';
      item.textContent = `${endpoint.method} ${endpoint.path} · ${endpoint.file}`;
      container.append(item);
    }
  }

  const joined = tierTraces(report).filter((entry) => entry.endpoint !== null);
  if (joined.length > 0) {
    const heading = document.createElement('h4');
    heading.textContent = 'Trace';
    container.append(heading);
    for (const entry of joined.slice(0, 20)) {
      const item = document.createElement('div');
      item.className = 'tier-trace';
      item.dataset.role = 'tier-trace';
      item.textContent = `${entry.call.file}:${entry.call.line} → ${entry.endpoint.method} ${entry.endpoint.path} (${entry.endpoint.file})`;
      container.append(item);
    }
  }

  // The table index: the start of the end-to-end trace.
  const tables = tierTables(report);
  if (tables.length > 0) {
    const heading = document.createElement('h4');
    heading.textContent = 'Tables';
    container.append(heading);
    for (const entry of tables.slice(0, 20)) {
      const item = document.createElement('div');
      item.className = 'tier-table';
      item.dataset.role = 'tier-table';
      item.textContent = `${entry.table} · ${entry.count} reference(s)`;
      container.append(item);
      const trace = tierTableTrace(report, entry.table);
      if (trace.length > 0) {
        const caption = document.createElement('div');
        caption.className = 'tier-table-trace';
        caption.dataset.role = 'tier-table-trace';
        caption.textContent = trace
          .map((row) => `${row.file} (${row.tier}${row.unit === '.' ? '' : `, ${row.unit}`})`)
          .join(' · ');
        container.append(caption);
      }
    }
  }
}
