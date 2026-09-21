/**
 * The tier lens panel: the tier × unit matrix, the per-tier shares, the direction check,
 * and the table index.
 *
 * DOM only; all shaping comes from the pure helpers in `strabo-tiers.js`. An empty cell is
 * drawn as `·` rather than blank, because a unit with no Data tier is information.
 */

import {
  tierCallSites,
  tierDirectionLabel,
  tierEndpointSites,
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

function numberCell(text, title) {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (title) {
    cell.title = title;
  }
  return cell;
}

export function renderTierPanel(container, report, filter = 'all') {
  container.replaceChildren();

  const title = document.createElement('h3');
  title.textContent = 'Tier lens';
  container.append(title);

  const note = document.createElement('p');
  note.className = 'overlay-note';
  note.textContent = tierSummaryLabel(report);
  container.append(note);

  const rows = tierMatrixRows(report);
  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'unavailable';
    empty.textContent = 'No file was classified into a tier.';
    container.append(empty);
    return;
  }

  const units = report?.matrix?.units ?? [];
  const table = document.createElement('table');
  table.className = 'tier-matrix';
  const head = document.createElement('tr');
  head.append(headerCell('Tier'));
  for (const unit of units) {
    head.append(headerCell(unit === '.' ? '/' : unit));
  }
  head.append(headerCell('Files'), headerCell('Lines'));
  table.append(head);

  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.role = 'tier-row';
    tr.dataset.tier = row.tier;
    if (filter !== 'all' && filter === row.tier) {
      tr.classList.add('is-selected');
    }
    const name = document.createElement('th');
    name.textContent = row.label;
    tr.append(name);
    for (const cell of row.cells) {
      tr.append(numberCell(cell.files === 0 ? '·' : String(cell.files), `${cell.lines} line(s)`));
    }
    tr.append(numberCell(String(row.files)), numberCell(String(row.lines)));
    table.append(tr);
  }
  container.append(table);

  const shares = document.createElement('p');
  shares.className = 'tier-shares';
  shares.dataset.role = 'tier-shares';
  shares.textContent = tierPerTierRows(report)
    .map((entry) => `${entry.label} ${entry.shareLabel}`)
    .join(' · ');
  container.append(shares);

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
