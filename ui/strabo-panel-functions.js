/**
 * The function table, including the virtualized list for large files.
 *
 * Split out of strabo-panels.js.
 */

import {
  createVirtualList,
  rovingIndex,
} from './strabo-core.js';

import {
  coverageCaption,
  functionCallers,
  functionCalls,
  functionCoverage,
  functionCoverageLabel,
  functionEntryBadge,
  functionLabel,
  functionMetrics,
  functionSignature,
  functionSignals,
  functionSummary,
} from './strabo-functions.js';

import { button } from './strabo-panel-kit.js';

import { appendNarratorBlock } from './strabo-panel-narrative.js';


/**
 * Render the function inventory: signature, body metrics, and recorded call relationships.
 *
 * A language without a function extractor says so; a file with no functions says so. A
 * function whose body was not read shows `signature only`, and a function with no recorded
 * calls or callers says so rather than showing an empty list.
 */
export function renderFunctions(container, result, handlers = {}) {
  container.replaceChildren();
  const report = result?.functions;
  const title = document.createElement('h3');
  title.textContent = `Functions (${report?.functions?.length ?? 0})`;
  container.append(title);

  if (!result || result.available === false) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent = result?.detail ?? 'Functions are not recorded for this file.';
    container.append(note);
    return;
  }
  if (!report || report.available === false) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent = report?.detail ?? 'Functions are not recorded for this file.';
    container.append(note);
    return;
  }
  if (report.functions.length === 0) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent = 'No functions declared.';
    container.append(note);
    return;
  }

  const summary = document.createElement('p');
  summary.className = 'function-summary';
  summary.textContent = functionSummary(report);
  container.append(summary);

  if (result?.coverage) {
    const coverageNote = document.createElement('p');
    coverageNote.className = 'function-coverage-basis';
    coverageNote.textContent = `Coverage ${coverageCaption(result.coverage)}`;
    container.append(coverageNote);
  }

  if (report.functions.length > FUNCTION_TABLE_VIRTUALIZE_AT) {
    container.append(renderFunctionTableVirtual(report));
  } else {
    container.append(renderFunctionTable(report));
  }

  appendNarratorBlock(container, handlers, { id: 'narrate-functions', label: 'Narrate' });
}


/**
 * The Functions tab as a sortable table: one row per function with columns for name,
 * visibility or entry badge, lines, span, complexity, nesting, loops, calls (count),
 * callers (count or entry badge), and signals (chips).
 *
 * Names truncate in the middle with the full signature as a tooltip; expanding a row
 * shows the signature, the recorded metrics, and every call site with its line. Counts
 * are buttons that expand the same detail, and a call-site button jumps to the callee's
 * own row. Columns sort on click; the default order is signal count, then complexity.
 * Rows keep roving keyboard navigation, and files above
 * `FUNCTION_TABLE_VIRTUALIZE_AT` render through the virtualized list instead.
 */
const FUNCTION_TABLE_VIRTUALIZE_AT = 100;


const FUNCTION_COLUMNS = [
  { key: 'name', label: 'Function' },
  { key: 'entry', label: 'Visibility / entry' },
  { key: 'lines', label: 'Lines', numeric: true },
  { key: 'span', label: 'Span' },
  { key: 'complexity', label: 'Complexity', numeric: true },
  { key: 'nesting', label: 'Nesting', numeric: true },
  { key: 'loops', label: 'Loops', numeric: true },
  { key: 'calls', label: 'Calls', numeric: true },
  { key: 'callers', label: 'Callers' },
  { key: 'signals', label: 'Signals', numeric: true },
  { key: 'coverage', label: 'Coverage' },
];


/** Truncate a long name in the middle so both the owner and the tail stay visible. */
function truncateMiddle(text, max = 30) {
  if (text.length <= max) {
    return text;
  }
  const keep = Math.max(1, Math.floor((max - 1) / 2));
  return `${text.slice(0, keep)}…${text.slice(text.length - keep)}`;
}


function functionSortValue(entry, key) {
  switch (key) {
    case 'name':
      return functionLabel(entry).toLowerCase();
    case 'entry':
      return entry?.entry
        ? `${entry.entry.kind} ${entry.entry.evidence}`.toLowerCase()
        : String(entry?.visibility ?? '').toLowerCase();
    case 'lines':
      return entry?.metrics?.lines ?? -1;
    case 'span':
      return entry?.line ?? 0;
    case 'complexity':
      return entry?.metrics?.decisionPoints ?? -1;
    case 'nesting':
      return entry?.metrics?.maxNestingDepth ?? -1;
    case 'loops':
      return entry?.metrics?.loops ?? -1;
    case 'calls':
      return entry?.calls?.length ?? 0;
    case 'callers':
      return entry?.callers?.length ?? 0;
    case 'signals':
      return entry?.signals?.length ?? 0;
    case 'coverage':
      return entry?.coverage?.lineCoverage ?? entry?.coverage?.hits ?? -1;
    default:
      return 0;
  }
}


function compareFunctionEntries(a, b, key, dir) {
  const first = functionSortValue(a, key);
  const second = functionSortValue(b, key);
  const order =
    typeof first === 'string' || typeof second === 'string'
      ? String(first).localeCompare(String(second))
      : first - second;
  if (order !== 0) {
    return dir === 'desc' ? -order : order;
  }
  // Ties break by signal count, then complexity, then source order.
  return (
    (b?.signals?.length ?? 0) - (a?.signals?.length ?? 0) ||
    (b?.metrics?.decisionPoints ?? -1) - (a?.metrics?.decisionPoints ?? -1) ||
    (a?.line ?? 0) - (b?.line ?? 0) ||
    String(a?.name ?? '').localeCompare(String(b?.name ?? ''))
  );
}


/** The full per-function detail: signature, metrics, call sites with lines, and signals. */
function functionDetailContent(entry, onJump) {
  const detail = document.createElement('div');
  detail.className = 'function-detail-content';

  const signature = document.createElement('code');
  signature.className = 'function-signature';
  signature.textContent = functionSignature(entry);
  signature.title = functionSignature(entry);
  detail.append(signature);

  const metrics = document.createElement('div');
  metrics.className = 'function-metrics';
  metrics.textContent = functionMetrics(entry);
  detail.append(metrics);

  const calls = document.createElement('div');
  calls.className = 'function-calls';
  calls.append(document.createTextNode('calls: '));
  if ((entry?.calls ?? []).length === 0) {
    calls.append(document.createTextNode(functionCalls(entry)));
  } else {
    for (const [index, call] of (entry.calls ?? []).entries()) {
      if (index > 0) {
        calls.append(document.createTextNode(', '));
      }
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'link function-callsite';
      jump.dataset.callee = call.name;
      jump.dataset.line = String(call.line);
      jump.title = `Show ${call.name} (line ${call.line})`;
      jump.textContent = `${call.name} (L${call.line})`;
      jump.addEventListener('click', () => onJump(call.name));
      calls.append(jump);
    }
  }
  detail.append(calls);

  const callers = document.createElement('div');
  callers.className = 'function-callers';
  callers.textContent = `called by: ${functionCallers(entry)}`;
  detail.append(callers);

  const signals = document.createElement('div');
  signals.className = 'function-signals';
  signals.textContent = `signals: ${functionSignals(entry)}`;
  detail.append(signals);

  const coverage = document.createElement('div');
  coverage.className = 'function-coverage-detail';
  coverage.textContent = `coverage: ${functionCoverage(entry)}`;
  detail.append(coverage);

  return detail;
}


function signalChips(entry) {
  const signals = entry?.signals ?? [];
  if (signals.length === 0) {
    const none = document.createElement('span');
    none.className = 'function-none';
    none.title = 'no cost signals';
    none.textContent = '—';
    return none;
  }
  const chips = document.createElement('span');
  chips.className = 'signal-chips';
  for (const signal of signals) {
    const chip = document.createElement('span');
    chip.className = 'signal-chip';
    chip.title = `${signal.kind} (${signal.detail})`;
    chip.textContent = signal.kind;
    chips.append(chip);
    chips.append(document.createTextNode(' '));
  }
  return chips;
}


/** Expand the row for `name` (and focus it), so a call site links to its callee. */
function jumpToFunctionRow(root, name) {
  const rows = [...root.querySelectorAll('.function-row')];
  const target = rows.find((row) => row.dataset.function === name);
  if (!target) {
    return;
  }
  const toggle = target.querySelector('[data-expand]');
  if (toggle?.getAttribute('aria-expanded') === 'false') {
    toggle.click();
  }
  const focusable = target.querySelector('.function-name');
  focusable?.focus();
  if (typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'nearest' });
  }
}


/**
 * Move focus between a table's row name buttons with the keyboard (roving tabindex):
 * ArrowUp/ArrowDown step, Home/End jump. Only the active row is tabbable.
 */
function wireFunctionRoving(tbody) {
  const names = () => [...tbody.querySelectorAll('.function-name')];
  tbody.addEventListener('keydown', (event) => {
    const current = names().indexOf(document.activeElement);
    if (current === -1) {
      return;
    }
    const next = rovingIndex(current, names().length, event.key);
    if (next === null) {
      return;
    }
    event.preventDefault();
    names().forEach((button, position) => {
      button.tabIndex = position === next ? 0 : -1;
    });
    names()[next]?.focus();
  });
}


function functionTableHead(entries, sort, onSort) {
  const thead = document.createElement('thead');
  const row = document.createElement('tr');
  for (const column of FUNCTION_COLUMNS) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'function-sort';
    button.dataset.sort = column.key;
    const active = sort.key === column.key;
    button.setAttribute('aria-label', `Sort by ${column.label}`);
    button.textContent = `${column.label}${active ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : ''}`;
    if (active) {
      cell.setAttribute('aria-sort', sort.dir === 'desc' ? 'descending' : 'ascending');
    }
    button.addEventListener('click', () => onSort(column.key));
    cell.append(button);
    row.append(cell);
  }
  thead.append(row);
  return thead;
}


function functionTableRow(entry, onJump) {
  const row = document.createElement('tr');
  row.className = 'function-row';
  row.dataset.function = entry?.name ?? '';

  const nameCell = document.createElement('td');
  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'function-name link';
  name.dataset.expand = 'true';
  name.textContent = truncateMiddle(functionLabel(entry));
  name.title = functionSignature(entry);
  name.tabIndex = 0;
  name.setAttribute('aria-expanded', 'false');
  nameCell.append(name);
  row.append(nameCell);

  const entryCell = document.createElement('td');
  const badge = functionEntryBadge(entry);
  entryCell.className = 'function-entry-cell';
  entryCell.textContent = badge || (entry?.visibility ?? '');
  entryCell.title = badge || (entry?.visibility ?? '');
  row.append(entryCell);

  const linesCell = document.createElement('td');
  linesCell.textContent = entry?.metrics ? String(entry.metrics.lines) : '—';
  linesCell.title = entry?.metrics ? `${entry.metrics.lines} lines` : 'signature only; no body recorded';
  row.append(linesCell);

  const spanCell = document.createElement('td');
  spanCell.textContent = entry?.metrics ? `L${entry.line}-${entry.metrics.endLine}` : '—';
  row.append(spanCell);

  const complexityCell = document.createElement('td');
  complexityCell.textContent = entry?.metrics ? String(entry.metrics.decisionPoints) : '—';
  row.append(complexityCell);

  const nestingCell = document.createElement('td');
  nestingCell.textContent = entry?.metrics ? String(entry.metrics.maxNestingDepth) : '—';
  row.append(nestingCell);

  const loopsCell = document.createElement('td');
  loopsCell.textContent = entry?.metrics ? String(entry.metrics.loops) : '—';
  row.append(loopsCell);

  const callsCell = document.createElement('td');
  if ((entry?.calls ?? []).length === 0) {
    callsCell.textContent = '—';
    callsCell.title = functionCalls(entry);
  } else {
    const count = document.createElement('button');
    count.type = 'button';
    count.className = 'link function-count';
    count.dataset.expand = 'true';
    count.textContent = String(entry.calls.length);
    count.title = functionCalls(entry);
    count.setAttribute('aria-label', `${entry.calls.length} same-file calls: ${functionCalls(entry)}`);
    callsCell.append(count);
  }
  row.append(callsCell);

  const callersCell = document.createElement('td');
  if ((entry?.callers ?? []).length > 0) {
    const count = document.createElement('button');
    count.type = 'button';
    count.className = 'link function-count';
    count.dataset.expand = 'true';
    count.textContent = String(entry.callers.length);
    count.title = functionCallers(entry);
    count.setAttribute('aria-label', `${entry.callers.length} callers: ${functionCallers(entry)}`);
    callersCell.append(count);
  } else {
    callersCell.textContent = badge || functionCallers(entry);
    callersCell.title = functionCallers(entry);
  }
  row.append(callersCell);

  const signalsCell = document.createElement('td');
  signalsCell.append(signalChips(entry));
  row.append(signalsCell);

  const coverageCell = document.createElement('td');
  coverageCell.className = 'function-coverage';
  coverageCell.textContent = functionCoverageLabel(entry);
  coverageCell.title = functionCoverage(entry);
  coverageCell.dataset.basis = entry?.coverage ? 'measured' : 'unavailable';
  row.append(coverageCell);

  const detailRow = document.createElement('tr');
  detailRow.className = 'function-detail';
  detailRow.hidden = true;
  const detailCell = document.createElement('td');
  detailCell.colSpan = FUNCTION_COLUMNS.length;
  detailCell.append(functionDetailContent(entry, (name) => jumpToFunctionRow(row.closest('table, .function-table-virtual') ?? document, name)));
  detailRow.append(detailCell);

  const toggle = () => {
    const open = detailRow.hidden;
    detailRow.hidden = !open;
    for (const control of row.querySelectorAll('[data-expand]')) {
      control.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  };
  for (const control of row.querySelectorAll('[data-expand]')) {
    control.addEventListener('click', toggle);
  }

  const fragment = document.createDocumentFragment();
  fragment.append(row, detailRow);
  return fragment;
}


/** The sortable Functions table for files that fit in the DOM. */
function renderFunctionTable(report) {
  const table = document.createElement('table');
  table.className = 'function-table';
  let sort = { key: 'signals', dir: 'desc' };
  const draw = () => {
    for (const old of [...table.children]) {
      old.remove();
    }
    table.append(functionTableHead(report.functions, sort, (key) => {
      if (sort.key === key) {
        sort.dir = sort.dir === 'desc' ? 'asc' : 'desc';
      } else {
        sort = { key, dir: key === 'name' || key === 'entry' ? 'asc' : 'desc' };
      }
      draw();
    }));
    const tbody = document.createElement('tbody');
    const ordered = [...(report.functions ?? [])].sort((a, b) => compareFunctionEntries(a, b, sort.key, sort.dir));
    for (const entry of ordered) {
      tbody.append(functionTableRow(entry, (name) => jumpToFunctionRow(table, name)));
    }
    wireFunctionRoving(tbody);
    // Only the first row's name button is tabbable; the rest is arrow-key travel.
    tbody.querySelectorAll('.function-name').forEach((button, position) => {
      button.tabIndex = position === 0 ? 0 : -1;
    });
    table.append(tbody);
  };
  draw();
  return table;
}


/**
 * The Functions table for large files: the same sortable columns, but the rows render
 * through the virtualized list so a thousand-function file costs a viewport of rows.
 * Selecting a row shows its detail (signature, metrics, call sites) underneath.
 */
function renderFunctionTableVirtual(report) {
  const wrapper = document.createElement('div');
  wrapper.className = 'function-table-virtual';
  let sort = { key: 'signals', dir: 'desc' };

  const header = document.createElement('div');
  header.className = 'function-virtual-head';
  wrapper.append(header);

  const list = createVirtualList({
    rowHeight: 30,
    overscan: 8,
    className: 'function-virtual-list',
    renderRow: (entry) => {
      const row = document.createElement('div');
      row.className = 'function-row function-virtual-row';
      row.dataset.function = entry?.name ?? '';
      row.setAttribute('role', 'button');
      row.tabIndex = -1;

      const name = document.createElement('span');
      name.className = 'function-name';
      name.textContent = truncateMiddle(functionLabel(entry));
      name.title = functionSignature(entry);
      row.append(name);

      const badge = functionEntryBadge(entry);
      const meta = document.createElement('span');
      meta.className = 'function-virtual-meta';
      const signals = entry?.signals?.length ?? 0;
      const complexity = entry?.metrics?.decisionPoints ?? '—';
      meta.textContent =
        `${badge || (entry?.visibility ?? '')} · complexity ${complexity}` +
        ` · ${signals} signal${signals === 1 ? '' : 's'}` +
        ` · coverage ${functionCoverageLabel(entry)}`;
      row.append(meta);
      return row;
    },
  });
  wrapper.append(list.element);

  const detail = document.createElement('div');
  detail.className = 'function-virtual-detail';
  detail.textContent = 'Select a function for its signature, metrics, and call sites.';
  wrapper.append(detail);

  const select = (entry) => {
    detail.replaceChildren(functionDetailContent(entry, (name) => {
      const ordered = orderedEntries();
      const target = ordered.find((candidate) => candidate?.name === name);
      if (target) {
        select(target);
      }
    }));
    for (const row of list.element.querySelectorAll('.function-row')) {
      row.classList.toggle('selected', row.dataset.function === entry?.name);
    }
  };

  const orderedEntries = () =>
    [...(report.functions ?? [])].sort((a, b) => compareFunctionEntries(a, b, sort.key, sort.dir));

  const draw = () => {
    header.replaceChildren(
      functionTableHead(report.functions, sort, (key) => {
        if (sort.key === key) {
          sort.dir = sort.dir === 'desc' ? 'asc' : 'desc';
        } else {
          sort = { key, dir: key === 'name' || key === 'entry' ? 'asc' : 'desc' };
        }
        draw();
      }),
    );
    list.setItems(orderedEntries());
    list.refresh();
  };

  list.element.addEventListener('click', (event) => {
    const row = event.target.closest?.('.function-row');
    const entry = orderedEntries().find((candidate) => candidate?.name === row?.dataset.function);
    if (entry) {
      select(entry);
    }
  });
  list.element.addEventListener('keydown', (event) => {
    const rows = [...list.element.querySelectorAll('.function-row')];
    const current = rows.indexOf(document.activeElement?.closest?.('.function-row') ?? null);
    const next = rovingIndex(Math.max(0, current), rows.length, event.key);
    if (next === null) {
      return;
    }
    event.preventDefault();
    const entry = orderedEntries()[next];
    if (entry) {
      select(entry);
    }
    rows[next]?.focus?.();
  });

  draw();
  const first = orderedEntries()[0];
  if (first) {
    select(first);
  }
  return wrapper;
}
