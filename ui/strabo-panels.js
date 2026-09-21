/**
 * Inspector, diagnostics, legend, breadcrumb, folder, overlay, and tests-strip panels.
 *
 * Exposes file metrics and source evidence so a connection can be explained, and reports
 * unrecorded detail as unavailable rather than implying there is none.
 */

import {
  SHAPES,
  breadcrumb,
  changeMetricSummary,
  cohesionDelta,
  commitMetricBadge,
  constellationLayout,
  clusterSeriesClass,
  createVirtualList,
  constellationPoints,
  explainClass,
  fieldCard,
  flowGraph,
  layoutFlowGraph,
  graphSummary,
  isWiredField,
  isWiredMethod,
  memberClusters,
  memberMapSteps,
  methodCard,
  metricDelta,
  orderMetricFiles,
  orderAdvisories,
  orderMembers,
  passportFor,
  polygonPoints,
  rovingIndex,
  radarFrame,
  radarPoints,
  readingLegend,
  reviewGroups,
  riskSummary,
  shortcutSheet,
  summarizeDiagnostics,
} from './strabo-core.js';
import {
  functionCallers,
  functionCalls,
  functionEntryBadge,
  functionLabel,
  functionMetrics,
  functionSignature,
  functionSignals,
  functionSummary,
} from './strabo-functions.js';
import { highlightIsolated, highlightLines, languageForFile } from './strabo-highlight.js';
import {
  NARRATOR_ATTRIBUTION,
  narrativeBlocks,
  narratorDisabledReason,
  narratorNeedsSetup,
  narratorReplyLabel,
  narratorStatusLabel,
} from './strabo-narrator.js';
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
import {
  complexityValue,
  filePassportCells,
  impactFunctionLabel,
  passportHeading,
  riskBandLabel,
  riskTone,
  totalsPassportCells,
} from './strabo-impact.js';
import { Fragment, h, host, mount } from './view.js';

/** Unique ids so each tab and its panel can point at each other with ARIA. */
let inspectorSeq = 0;

/**
 * The in-panel Back control: a drill-in view steps down to the view it was opened from.
 *
 * `handlers.canGoBack === false` renders it disabled, for a view with nothing behind it;
 * `handlers.backTitle` names the destination in the tooltip and for screen readers.
 */
function backButton(handlers, fallbackTitle) {
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'panel-back';
  back.dataset.role = 'panel-back';
  back.textContent = '← Back';
  back.disabled = handlers.canGoBack === false;
  const title = handlers.backTitle ?? fallbackTitle;
  back.title = title;
  back.setAttribute('aria-label', title);
  back.addEventListener('click', () => handlers.onBack?.());
  return back;
}

/** The Module Passport for the selected node. */
export function renderInspector(container, model, id, handlers = {}) {
  const passport = passportFor(model, id);
  if (!passport) {
    container.hidden = true;
    return;
  }
  const node = (model.nodes ?? []).find((candidate) => candidate.id === id);
  container.hidden = false;
  container.replaceChildren();

  const title = document.createElement('h2');
  const chip = document.createElement('span');
  chip.className = `kind-chip kind-${passport.kind ?? 'module'}`;
  chip.textContent = passport.kind ?? 'module';
  title.append(chip);
  title.append(document.createTextNode(node?.label ?? id));
  container.append(title);
  if (handlers.onBack) {
    title.prepend(backButton(handlers, 'Back to the map'));
  }

  const path = document.createElement('p');
  path.className = 'passport-path';
  path.textContent = node?.workspacePath ?? id;
  container.append(path);

  // A System-view unit says why it is grouped, so the caption is evidence, not decoration.
  if (passport.why) {
    const why = document.createElement('p');
    why.className = 'passport-why';
    why.textContent = `Grouped by: ${passport.why}`;
    container.append(why);
  }

  const actions = document.createElement('div');
  actions.className = 'inspector-actions';
  if (handlers.onOpenWorkspace) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'primary';
    open.textContent = 'Open in Workspace';
    open.addEventListener('click', () => handlers.onOpenWorkspace(id));
    actions.append(open);
  }
  if (handlers.onViewSource) {
    const source = document.createElement('button');
    source.type = 'button';
    source.className = 'source-open';
    source.textContent = 'View source';
    source.addEventListener('click', () => handlers.onViewSource(id));
    actions.append(source);
  }
  if (handlers.onOpenMemberMap) {
    const memberMap = document.createElement('button');
    memberMap.type = 'button';
    memberMap.className = 'member-open';
    memberMap.id = 'open-member-map';
    memberMap.textContent = 'Member map';
    memberMap.addEventListener('click', () => handlers.onOpenMemberMap(id));
    actions.append(memberMap);
  }
  if (handlers.onOpenRoute) {
    const route = document.createElement('button');
    route.type = 'button';
    route.className = 'route-open';
    route.id = 'open-route';
    route.textContent = 'Read next';
    route.title = 'Step through the repository reading route from its entry points';
    route.addEventListener('click', () => handlers.onOpenRoute(id));
    actions.append(route);
  }
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'icon-button';
  copy.textContent = '⧉ Copy path';
  copy.title = 'Copy repository-relative path';
  copy.addEventListener('click', () => {
    const text = node?.workspacePath ?? id;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    copy.textContent = '✓ Copied';
    setTimeout(() => {
      copy.textContent = '⧉ Copy path';
    }, 1200);
  });
  actions.append(copy);
  container.append(actions);

  const cards = document.createElement('div');
  cards.className = 'stat-cards';
  for (const metric of passport.metrics) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    const value = document.createElement('div');
    value.className = 'stat-value';
    value.textContent = String(metric.value);
    const label = document.createElement('div');
    label.className = 'stat-label';
    label.textContent = metric.label;
    card.append(value, label);
    cards.append(card);
  }
  container.append(cards);

  // A System-view unit has no members or functions to tab through; its one extra
  // affordance is the opt-in narrator, which may name the group but never change it.
  if (model.system) {
    if (model.systemUnit) {
      appendOutsideLinks(container, model, id, node, handlers);
      return;
    }
    const narrator = document.createElement('div');
    narrator.className = 'system-narrator';
    appendNarratorBlock(narrator, handlers, { id: 'narrate-group', label: 'Name group' });
    container.append(narrator);
    return;
  }

  const tabs = document.createElement('div');
  tabs.className = 'inspector-tabs';
  tabs.setAttribute('role', 'tablist');
  const panels = document.createElement('div');
  panels.className = 'inspector-panels';

  const members = document.createElement('section');
  members.dataset.role = 'members';
  const membersTitle = document.createElement('h3');
  membersTitle.textContent = 'Members';
  members.append(membersTitle);
  const membersBody = document.createElement('p');
  membersBody.className = 'unavailable';
  membersBody.textContent = 'Loading members…';
  members.append(membersBody);

  const depsSection = listSection('Dependencies', id, passport.imports, handlers);
  const dependentsSection = listSection('Dependents', id, passport.usedBy, handlers);

  const functions = document.createElement('section');
  functions.dataset.role = 'functions';
  const functionsTitle = document.createElement('h3');
  functionsTitle.textContent = 'Functions';
  functions.append(functionsTitle);
  const functionsBody = document.createElement('p');
  functionsBody.className = 'unavailable';
  functionsBody.textContent = 'Loading functions…';
  functions.append(functionsBody);

  const impact = document.createElement('section');
  impact.dataset.role = 'impact';
  const impactTitle = document.createElement('h3');
  impactTitle.textContent = 'Impact';
  impact.append(impactTitle);
  const impactBody = document.createElement('p');
  impactBody.className = 'unavailable';
  impactBody.textContent = 'Loading impact…';
  impact.append(impactBody);

  const tabDefs = [
    ['deps', `Dependencies (${passport.imports.length})`, depsSection],
    ['dependents', `Dependents (${passport.usedBy.length})`, dependentsSection],
    ['members', 'Members', members],
    ['functions', 'Functions', functions],
    ['impact', 'Impact', impact],
  ];
  const base = `inspector-${(inspectorSeq += 1)}`;
  const tabButtons = [];
  const tabSections = [];

  /** Show one tab panel and make its tab the single tabbable one (roving tabindex). */
  const selectTab = (index, { focus = false } = {}) => {
    tabButtons.forEach((button, position) => {
      const selected = position === index;
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
    });
    tabSections.forEach((section, position) => {
      section.hidden = position !== index;
    });
    if (focus) {
      tabButtons[index].focus();
    }
  };

  for (const [key, label, section] of tabDefs) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'inspector-tab';
    tab.setAttribute('role', 'tab');
    tab.dataset.tab = key;
    tab.textContent = label;
    tab.id = `${base}-tab-${key}`;
    tab.setAttribute('aria-controls', `${base}-panel-${key}`);
    section.id = `${base}-panel-${key}`;
    section.setAttribute('role', 'tabpanel');
    section.setAttribute('aria-labelledby', tab.id);
    section.tabIndex = 0;
    tab.addEventListener('click', () => selectTab(tabButtons.indexOf(tab)));
    tab.addEventListener('keydown', (event) => {
      const next = rovingIndex(tabButtons.indexOf(tab), tabButtons.length, event.key);
      if (next === null) {
        return;
      }
      event.preventDefault();
      selectTab(next, { focus: true });
    });
    tabs.append(tab);
    tabButtons.push(tab);
    tabSections.push(section);
    panels.append(section);
  }
  selectTab(0);
  container.append(tabs, panels);

  // K4: the "Changes with" section lists the files this one changes together with, from
  // recorded commits. It is filled on demand by the server's co-change report, and says so
  // while loading rather than showing an invented relationship.
  const changesWith = document.createElement('section');
  changesWith.dataset.role = 'changes-with';
  const changesWithTitle = document.createElement('h3');
  changesWithTitle.textContent = 'Changes with';
  changesWith.append(changesWithTitle);
  const changesWithBody = document.createElement('p');
  changesWithBody.className = 'unavailable';
  changesWithBody.textContent = 'Loading co-change…';
  changesWith.append(changesWithBody);
  container.append(changesWith);

  const trace = document.createElement('p');
  trace.className = 'trace';
  trace.dataset.role = 'trace';
  trace.textContent = 'Use a row button to trace a directed path.';
  container.append(trace);
}

function listSection(heading, from, entries, handlers) {
  const section = document.createElement('section');
  const title = document.createElement('h3');
  title.textContent = `${heading} (${entries.length})`;
  section.append(title);

  const list = document.createElement('ul');
  for (const entry of entries.slice(0, 100)) {
    const item = document.createElement('li');
    item.dataset.delegateNode = entry.id;

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'link';
    open.textContent = entry.id;
    open.addEventListener('click', () => handlers.onSelect?.(entry.id));
    item.append(open);

    if (handlers.onTrace) {
      const trace = document.createElement('button');
      trace.type = 'button';
      trace.className = 'trace-button';
      trace.textContent = 'trace';
      trace.addEventListener('click', () => handlers.onTrace(from, entry.id));
      item.append(trace);
    }

    if (entry.line) {
      const evidence = document.createElement('span');
      evidence.className = 'evidence';
      evidence.textContent = `L${entry.line} ${entry.specifier ?? ''}`.trim();
      item.append(evidence);
    }
    list.append(item);
  }
  section.append(list);
  return section;
}

function appendFact(list, term, value) {
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = value;
  list.append(dt, dd);
}

/**
 * Render the "Changes with" section: the partners this file changes together with, each
 * showing the commits behind the pair. Only an edge with a listable commit is shown, so the
 * section never states a relationship the history did not record; a report that is not for
 * this file, or that has no partner, says so rather than showing an empty list.
 */
export function renderChangesWith(container, result, handlers = {}) {
  container.replaceChildren();
  const title = document.createElement('h3');
  title.textContent = 'Changes with';
  container.append(title);

  if (!result || result.available === false) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent = result?.detail ?? 'Co-change is unavailable: no Git history was read.';
    container.append(note);
    return;
  }

  const partners = result.partners ?? [];
  if (partners.length === 0) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent =
      'No recorded commits changed this file together with another in the window.';
    container.append(note);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'passport-list';
  list.dataset.role = 'changes-with-list';
  for (const partner of partners) {
    const item = document.createElement('li');
    item.dataset.delegateNode = partner.file;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'link';
    open.textContent = partner.file;
    open.addEventListener('click', () => handlers.onSelect?.(partner.file));
    item.append(open);

    const badge = document.createElement('span');
    badge.className = 'evidence';
    badge.hidden = !partner.hidden;
    badge.textContent = 'hidden coupling';
    item.append(badge);

    const summary = document.createElement('span');
    summary.className = 'evidence';
    summary.textContent = `${partner.commitsShared} shared commit(s) · ratio ${partner.ratio}`;
    item.append(summary);

    const commits = document.createElement('ul');
    commits.className = 'cochange-commits';
    for (const commit of partner.commits.slice(0, 5)) {
      const line = document.createElement('li');
      line.textContent = `${commit.hash.slice(0, 8)} · ${commit.date} · ${commit.subject}`;
      commits.append(line);
    }
    if (partner.commits.length > 5) {
      const more = document.createElement('li');
      more.className = 'unavailable';
      more.textContent = `+${partner.commits.length - 5} more commit(s)`;
      commits.append(more);
    }
    item.append(commits);
    list.append(item);
  }
  container.append(list);
}

/**
 * Render the Member map: members grouped by type, then the data-flow panels.
 *
 * Wiring is shown only where the scan recorded field references in this file; when none
 * were recorded the panels say so instead of showing empty lists.
 */
export function renderMembers(container, result) {  container.replaceChildren();
  const symbols = result?.symbols ?? [];
  const title = document.createElement('h3');
  title.textContent = `Members (${symbols.length})`;
  container.append(title);

  if (!result || result.available === false) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent = result?.detail ?? 'Not recorded by the scan.';
    container.append(note);
    return;
  }

  if (symbols.length === 0) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent = 'No members declared.';
    container.append(note);
    return;
  }

  const memberMap = result.memberMap;
  const types = memberMap?.types ?? [];
  if (types.length > 0) {
    for (const type of types) {
      container.append(renderMemberType(type));
    }
  } else {
    const list = document.createElement('ul');
    for (const symbol of symbols.slice(0, 200)) {
      const item = document.createElement('li');
      const owner = symbol.owner ? `${symbol.owner}.` : '';
      const type = symbol.type ? `: ${symbol.type}` : '';
      item.textContent = `${symbol.kind} · ${symbol.visibility} · ${owner}${symbol.name}${type}`;
      list.append(item);
    }
    container.append(list);
  }

  container.append(renderDataFlow(memberMap?.dataFlow));
}

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
        ` · ${signals} signal${signals === 1 ? '' : 's'}`;
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

/**
 * The outside-links affordance for the selected file in a System drill-down (L17).
 *
 * Nothing crossing the unit frame is drawn until the action is taken. Once it is, each
 * target unit is a badge with its file count; expanding the badge lists the files in place.
 */
function appendOutsideLinks(container, model, id, node, handlers) {
  const isFile = Boolean(node?.systemUnit) && !id.endsWith('#support');
  const block = document.createElement('div');
  block.className = 'outside-links';

  if (isFile && handlers.onShowOutside) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'show-outside-links';
    button.className = handlers.outsideShown ? 'outside-toggle active' : 'outside-toggle';
    button.setAttribute('aria-pressed', String(Boolean(handlers.outsideShown)));
    button.textContent = handlers.outsideShown ? 'Hide outside links' : 'Show outside links';
    button.title = 'Draw this file’s links to other units (O)';
    button.addEventListener('click', () => handlers.onShowOutside());
    block.append(button);
  }

  const links = (model.outsideLinks ?? []).filter((link) => link.file === id);
  for (const link of links) {
    const badge = document.createElement('div');
    badge.className = 'outside-badge';
    badge.dataset.unit = link.targetUnit;
    const label = document.createElement('span');
    label.textContent = `${link.count} file${link.count === 1 ? '' : 's'} in ${link.targetName}`;
    badge.append(label);
    badge.append(document.createTextNode(' · '));
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'link';
    expand.textContent = 'expand';
    expand.addEventListener('click', () => handlers.onExpandUnit?.(link.targetUnit));
    badge.append(expand);
    block.append(badge);
  }

  if (isFile || links.length > 0) {
    container.append(block);
  }
}

/**
 * Fill `target` with a narrator reply: prose blocks under the model-generated attribution, or
 * the reason the narrator is unavailable. Built from text nodes and elements only, so the
 * reply is never parsed as HTML.
 */
export function renderNarrativeReply(target, reply) {
  if (reply?.available !== true) {
    target.replaceChildren(narratorReplyLabel(reply));
    return;
  }
  const nodes = [];
  for (const block of narrativeBlocks(reply.text)) {
    const inline = (runs) =>
      runs.map((run) => {
        if (!run.code && !run.strong) {
          return document.createTextNode(run.text);
        }
        const element = document.createElement(run.code ? 'code' : 'strong');
        element.textContent = run.text;
        return element;
      });
    if (block.type === 'p') {
      const paragraph = document.createElement('p');
      paragraph.append(...inline(block.runs));
      nodes.push(paragraph);
    } else {
      const list = document.createElement(block.type);
      for (const item of block.items) {
        const entry = document.createElement('li');
        entry.append(...inline(item));
        list.append(entry);
      }
      nodes.push(list);
    }
  }
  const attribution = document.createElement('p');
  attribution.className = 'narrator-attribution';
  attribution.textContent = NARRATOR_ATTRIBUTION;
  target.replaceChildren(...nodes, attribution);
}

/**
 * The content of the right-click narration window: what is being narrated, then the reply.
 * `state` is `{ label, phase: 'loading' | 'done' | 'error', reply?, message? }`.
 */
export function renderNarrationPanel(container, state, handlers = {}) {
  const heading = document.createElement('h3');
  heading.textContent = `Narrator · ${state.label}`;
  const reply = document.createElement('div');
  reply.className = 'narrator-reply';
  reply.dataset.role = 'narrative';
  if (state.phase === 'loading') {
    reply.textContent = 'Asking the narrator…';
  } else if (state.phase === 'error') {
    reply.textContent = `Narrator unavailable: ${state.message}`;
  } else {
    renderNarrativeReply(reply, state.reply);
  }
  const nodes = [heading, reply];
  if (state.phase === 'done' && state.reply?.available !== true && handlers.onOpenNarratorSettings) {
    const setup = document.createElement('button');
    setup.type = 'button';
    setup.className = 'narrator-setup';
    setup.textContent = 'Open narrator settings →';
    setup.addEventListener('click', () => handlers.onOpenNarratorSettings());
    nodes.push(setup);
  }
  container.replaceChildren(...nodes);
}

/**
 * The opt-in narrator affordance: a status line, a button, and a reply under the
 * model-generated attribution. Shared by the Functions tab, a System-view unit, and the
 * Member map.
 */
function appendNarratorBlock(container, handlers, { id, label }) {
  if (!handlers.onNarrate) {
    return;
  }
  const block = document.createElement('div');
  block.className = 'narrator-block';

  const note = document.createElement('p');
  note.className = 'narrator-note';
  note.textContent = narratorStatusLabel(handlers.narratorStatus);
  block.append(note);

  // One clear call to action where the narrator is off: the two old lines collapse into a
  // single "Set up →" that opens Settings at the Narrator section.
  if (narratorNeedsSetup(handlers.narratorStatus) && handlers.onOpenNarratorSettings) {
    const setup = document.createElement('button');
    setup.type = 'button';
    setup.className = 'narrator-setup';
    setup.dataset.role = 'narrator-setup';
    setup.textContent = 'Set up →';
    setup.title = 'Open Settings at the Narrator section';
    setup.addEventListener('click', () => handlers.onOpenNarratorSettings());
    block.append(setup);
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.id = id;
  button.className = 'narrator-button';
  button.textContent = label;
  // Disabled with the reason as its tooltip, instead of clickable and failing.
  const disabledReason = narratorDisabledReason(handlers.narratorStatus);
  if (disabledReason) {
    button.disabled = true;
    button.title = disabledReason;
  }
  block.append(button);

  const reply = document.createElement('div');
  reply.className = 'narrator-reply';
  reply.dataset.role = 'narrative';
  block.append(reply);

  button.addEventListener('click', async () => {
    button.disabled = true;
    reply.replaceChildren('Asking the narrator…');
    try {
      renderNarrativeReply(reply, await handlers.onNarrate());
    } catch (error) {
      reply.replaceChildren(`Narrator unavailable: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  });

  container.append(block);
}

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

  const size = report.size ?? {};
  const summary = document.createElement('p');
  summary.className = 'passport-summary';
  summary.textContent =
    `${size.files ?? 0} files · ${size.edges ?? 0} edges · ${size.directories ?? 0} directories · ` +
    `${size.tests ?? 0} tests · ${size.diagnostics ?? 0} diagnostics · ${size.excluded ?? 0} excluded`;
  container.append(summary);

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
  container.append(passportSection('Used but no test reaches', untested.total ?? 0));
  container.append(
    (untested.files ?? []).length === 0
      ? passportNote('Every used module is reachable from a test, or no test file was identified.')
      : passportFileList(
          untested.files.map((file) => ({ file })),
          handlers,
          () => '',
        ),
  );

  if (handlers.onOpenRoute) {
    const route = document.createElement('button');
    route.type = 'button';
    route.id = 'open-route';
    route.textContent = 'Read next';
    route.title = 'Step through the outward route from the declared entry points';
    route.addEventListener('click', () => handlers.onOpenRoute());
    container.append(route);
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

function renderMemberType(type) {
  const section = document.createElement('section');
  section.className = 'member-type';
  const title = document.createElement('h4');
  title.className = 'member-type-name';
  title.textContent = type.name;
  section.append(title);

  if (type.fields.length > 0) {
    const heading = document.createElement('h5');
    heading.textContent = `Fields (${type.fields.length})`;
    section.append(heading);
    const list = document.createElement('ul');
    list.className = 'member-fields';
    for (const field of type.fields) {
      const item = document.createElement('li');
      item.className = 'member-field';
      const kind = field.mutable === false ? 'val' : 'var';
      item.textContent = `${field.visibility} ${kind} ${field.name}: ${field.type ?? 'unrecorded type'}`;
      item.append(wiring(`reads ${field.reads} · writes ${field.writes}`));
      list.append(item);
    }
    section.append(list);
  }

  if (type.methods.length > 0) {
    const heading = document.createElement('h5');
    heading.textContent = `Methods (${type.methods.length})`;
    section.append(heading);
    const list = document.createElement('ul');
    list.className = 'member-methods';
    for (const method of type.methods) {
      const item = document.createElement('li');
      item.className = 'member-method';
      const returns = method.type ? `: ${method.type}` : '';
      item.textContent = `${method.visibility} fun ${method.name}(${method.parameters ?? 0})${returns}`;
      if (method.reads.length > 0 || method.writes.length > 0) {
        item.append(
          wiring(`reads ${method.reads.join(', ') || 'none'} · writes ${method.writes.join(', ') || 'none'}`),
        );
      }
      list.append(item);
    }
    section.append(list);
  }

  if (type.fields.length === 0 && type.methods.length === 0) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent = 'No members declared.';
    section.append(note);
  }

  return section;
}

function wiring(text) {
  const span = document.createElement('span');
  span.className = 'wiring';
  span.textContent = ` · ${text}`;
  return span;
}

const DATA_FLOW_PANELS = [
  ['sources', 'Sources / inputs'],
  ['resources', 'Resources / hubs'],
  ['transforms', 'Transforms'],
  ['sinks', 'Sinks / outputs'],
];

function renderDataFlow(dataFlow) {
  const section = document.createElement('section');
  section.className = 'data-flow';

  const title = document.createElement('h4');
  title.textContent = 'Data flow';
  section.append(title);

  if (!dataFlow || dataFlow.available === false) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.dataset.role = 'flow-unavailable';
    note.textContent = `Wiring not recorded: ${dataFlow?.detail ?? 'not recorded by the scan.'}`;
    section.append(note);
    return section;
  }

  for (const [key, label] of DATA_FLOW_PANELS) {
    const panel = document.createElement('div');
    panel.className = 'flow-panel';
    panel.dataset.flow = key;

    const heading = document.createElement('h5');
    heading.textContent = label;
    panel.append(heading);

    const list = document.createElement('ul');
    const items = dataFlow[key] ?? [];
    if (items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'unavailable';
      empty.textContent = 'none recorded';
      list.append(empty);
    } else {
      for (const item of items) {
        const entry = document.createElement('li');
        entry.textContent = item;
        list.append(entry);
      }
    }
    panel.append(list);
    section.append(panel);
  }

  const caveat = document.createElement('p');
  caveat.className = 'caveat';
  caveat.textContent = dataFlow.caveat ?? '';
  section.append(caveat);

  return section;
}

export function renderDiagnostics(container, model, runtime = {}) {
  const summary = summarizeDiagnostics(model);
  container.replaceChildren();

  const title = document.createElement('h3');
  title.textContent = `Diagnostics · ${summary.diagnostics}`;
  container.append(title);

  const runtimeLine = document.createElement('p');
  runtimeLine.className = 'diag-runtime';
  runtimeLine.dataset.role = 'runtime';
  runtimeLine.textContent = `cache: ${summary.cache}${summary.stale ? ' (stale)' : ''} · renderer: ${
    runtime.renderer ?? 'unknown'
  } · ${runtime.shown ?? 0} shown`;
  container.append(runtimeLine);

  const counts = document.createElement('p');
  counts.textContent = `excluded: ${summary.excluded} · ${Object.entries(summary.byKind)
    .map(([kind, count]) => `${kind}: ${count}`)
    .join(', ') || 'none'}`;
  container.append(counts);

  const groups = new Map();
  for (const diagnostic of model.diagnostics ?? []) {
    if (!groups.has(diagnostic.kind)) groups.set(diagnostic.kind, []);
    groups.get(diagnostic.kind).push(diagnostic);
  }
  if (groups.size > 0) {
    for (const [kind, items] of groups) {
      const details = document.createElement('details');
      details.className = 'diag-group';
      if (kind === [...groups.keys()][0]) details.open = true;
      const summaryEl = document.createElement('summary');
      summaryEl.textContent = `${kind} (${items.length})`;
      details.append(summaryEl);
      const list = document.createElement('ul');
      for (const diagnostic of items.slice(0, 20)) {
        const item = document.createElement('li');
        item.dataset.delegateDiagnostic = `${diagnostic.file}:${diagnostic.line} ${diagnostic.message}`;
        item.textContent = `${diagnostic.file}:${diagnostic.line} ${diagnostic.message}`;
        list.append(item);
      }
      details.append(list);
      container.append(details);
    }
  } else if (summary.samples.length > 0) {
    const list = document.createElement('ul');
    for (const diagnostic of summary.samples) {
      const item = document.createElement('li');
      item.dataset.delegateDiagnostic = `${diagnostic.file}:${diagnostic.line} ${diagnostic.message}`;
      item.textContent = `${diagnostic.file}:${diagnostic.line} ${diagnostic.message}`;
      list.append(item);
    }
    container.append(list);
  }
  return summary;
}

const LEGEND_SWATCHES = {
  'size = dependents': 'linear-gradient(135deg,var(--node-fill),var(--accent))',
  'island = directory': 'linear-gradient(135deg,var(--island-fill),var(--node-fill))',
  'diamond = test': 'linear-gradient(135deg,var(--node-fill),var(--accent))',
  'hover = blast radius': 'linear-gradient(135deg,var(--ink-3),var(--accent))',
  'box = build unit': 'linear-gradient(135deg,var(--node-fill),var(--accent))',
  'size = files': 'linear-gradient(135deg,var(--node-fill),var(--accent))',
  'edge = import between units': 'linear-gradient(135deg,var(--graph-edge),var(--accent))',
  'support = unit footer': 'linear-gradient(135deg,var(--wash),var(--node-fill))',
};

export function renderLegend(container, model) {
  container.replaceChildren();

  const guide = document.createElement('div');
  guide.className = 'legend-guide';
  for (const text of readingLegend(model)) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = LEGEND_SWATCHES[text] ?? 'var(--accent)';
    if (text.startsWith('diamond')) {
      swatch.style.transform = 'rotate(45deg)';
      swatch.style.borderRadius = '2px';
    }
    item.append(swatch);
    item.append(document.createTextNode(text));
    guide.append(item);
  }
  container.append(guide);

  const kinds = [...new Set((model.nodes ?? []).map((node) => node.kind))].sort();
  for (const kind of kinds) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const glyph = document.createElement('span');
    glyph.className = 'legend-shape';
    glyph.textContent =
      kind === 'test'
        ? '◆'
        : kind === 'entry'
          ? '★'
          : kind === 'service'
            ? '⬡'
            : kind === 'unit'
              ? '▤'
              : kind === 'shelf'
                ? '▥'
                : '▣';
    item.append(glyph);
    item.append(document.createTextNode(`${kind} (${SHAPES[kind] ?? 'round-rectangle'})`));
    container.append(item);
  }
}

/** The keyboard cheat-sheet, split out of the legend so it opens on `?` instead. */
export function renderShortcuts(container) {
  container.replaceChildren();

  const title = document.createElement('h3');
  title.textContent = 'Keyboard shortcuts';
  container.append(title);

  const list = document.createElement('dl');
  list.className = 'shortcut-list';
  for (const entry of shortcutSheet()) {
    const term = document.createElement('dt');
    const kbd = document.createElement('kbd');
    kbd.textContent = entry.keys;
    term.append(kbd);
    const description = document.createElement('dd');
    description.textContent = entry.action;
    list.append(term, description);
  }
  container.append(list);
}

/** Counts by directory and kind; clicking a chip filters the map. */
export function renderTestsStrip(container, counts, onFilter, activeFilter = '') {
  const chip = (label, filter, className = 'strip-chip') =>
    h(
      'button',
      {
        // The filter is the chip's stable identity, so a re-render reuses the same button.
        key: filter || 'modules',
        type: 'button',
        className,
        dataset: { filter },
        'aria-pressed': activeFilter === filter ? 'true' : 'false',
        onClick: () => onFilter(filter),
      },
      label,
    );

  mount(
    container,
    h(
      Fragment,
      null,
      chip(`tests ${counts.tests}`, '.test'),
      chip(`modules ${counts.modules}`, ''),
      ...counts.entries
        .slice(0, 12)
        .map((entry) => chip(`${entry.label} ${entry.count}`, entry.filter, 'strip-chip strip-dir')),
    ),
  );
}

export function renderBreadcrumb(container, state, onNavigate) {
  container.replaceChildren();
  for (const crumb of breadcrumb(state)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'crumb';
    button.textContent = crumb.label;
    if (crumb.prefix === (state.prefix ?? '')) {
      button.disabled = true;
    }
    button.addEventListener('click', () => onNavigate(crumb.prefix));
    container.append(button);
  }
}

/** Render the directory listing for the folder-selection dialog. */
export function renderFolderList(container, result, onNavigate) {
  container.replaceChildren();

  for (const directory of result.directories) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = directory.isRepository ? 'folder folder-repository' : 'folder';
    button.dataset.path = directory.path;
    button.textContent = directory.isRepository ? `${directory.name} · repository` : directory.name;
    button.addEventListener('click', () => onNavigate(directory.path));
    item.append(button);
    container.append(item);
  }

  if (result.directories.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'folder-empty';
    empty.textContent = 'No subfolders';
    container.append(empty);
  }
}
/** Render the summary for the active review overlay. */
export function renderOverlayPanel(container, title, overlay, options = {}) {
  if (!overlay || !overlay.summary) {
    container.hidden = true;
    container.replaceChildren();
    container.className = 'overlay-panel';
    return;
  }
  container.hidden = false;
  container.replaceChildren();
  const kind = options.kind ?? 'impact';
  container.className = `overlay-panel overlay-kind-${kind}`;

  const heading = document.createElement('h3');
  const dot = document.createElement('span');
  dot.className = 'overlay-dot';
  dot.setAttribute('aria-hidden', 'true');
  heading.append(dot);
  heading.append(document.createTextNode(`${title} · ${overlay.summary}`));
  heading.className = 'overlay-summary';
  container.append(heading);

  if (options.onClose) {
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'panel-dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss overlay panel');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => options.onClose());
    heading.append(dismiss);
  }

  if (overlay.meta && (overlay.meta.testFiles !== undefined || overlay.meta.unreached !== undefined)) {
    const counts = document.createElement('p');
    counts.className = 'overlay-counts';
    const parts = [];
    if (overlay.meta.testFiles !== undefined) parts.push(`${overlay.meta.testFiles} test files`);
    if (overlay.meta.reached !== undefined) parts.push(`${overlay.meta.reached} reached`);
    if (overlay.meta.unreached !== undefined) parts.push(`${overlay.meta.unreached} unreached`);
    counts.textContent = parts.join(' · ');
    container.append(counts);
  }

  if ((!overlay.items || overlay.items.length === 0) && overlay.emptyNote) {
    const note = document.createElement('p');
    note.className = 'overlay-empty';
    note.textContent = overlay.emptyNote;
    container.append(note);
    return;
  }

  if (overlay.items.length > 0) {
    const needsSearch = overlay.items.length > 8;
    let filter = '';

    const rowFor = (item) => {
      const entry = document.createElement('div');
      entry.className = 'overlay-list-row';
      entry.setAttribute('role', 'listitem');
      if (typeof item === 'string') {
        entry.dataset.delegateOverlayItem = item;
      }
      if (options.onSelect && typeof item === 'string' && !item.includes('↔') && !item.includes(':')) {
        const jump = document.createElement('button');
        jump.type = 'button';
        jump.textContent = item;
        jump.title = `Select ${item}`;
        jump.addEventListener('click', () => options.onSelect(item.split(' · ')[0]));
        entry.append(jump);
      } else {
        entry.textContent = item;
      }
      return entry;
    };

    // A long overlay list scrolls instead of paging: only the visible slice is in the DOM.
    const list = createVirtualList({
      rowHeight: 20,
      overscan: 6,
      className: 'overlay-list',
      renderRow: rowFor,
    });

    const matchingItems = () => (
      filter
        ? overlay.items.filter((item) => String(item).toLowerCase().includes(filter))
        : overlay.items
    );

    const empty = document.createElement('p');
    empty.className = 'overlay-empty';
    empty.textContent = 'No modules match this filter.';
    empty.hidden = true;

    const renderList = () => {
      const matching = matchingItems();
      empty.hidden = matching.length > 0;
      list.setItems(matching);
    };

    if (needsSearch) {
      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'overlay-filter';
      search.placeholder = 'Filter modules…';
      search.setAttribute('aria-label', 'Filter overlay modules');
      search.addEventListener('input', () => {
        filter = search.value.trim().toLowerCase();
        renderList();
      });
      container.append(search);
    }
    container.append(list.element);
    container.append(empty);
    renderList();
    list.refresh();
  }
}

/**
 * Explain one edge: endpoints, relationship kind, and the evidence that produced it.
 * Pass null to hide. Unrecorded fields are shown as unavailable, never guessed.
 */
export function renderEdgeEvidence(container, evidence, handlers = {}) {
  if (!evidence) {
    container.hidden = true;
    container.replaceChildren();
    delete container.dataset.delegateEdge;
    return;
  }
  container.hidden = false;
  container.replaceChildren();
  container.dataset.delegateEdge = evidence.id;

  const heading = document.createElement('h3');
  heading.className = 'overlay-summary';
  heading.textContent = `Edge · ${evidence.kind}`;
  container.append(heading);

  const route = document.createElement('p');
  route.className = 'edge-route';
  route.append(edgeEndpoint(evidence.source, handlers.onSelect));
  route.append(document.createTextNode(' → '));
  route.append(edgeEndpoint(evidence.target, handlers.onSelect));
  container.append(route);

  const facts = document.createElement('dl');
  facts.className = 'passport-metrics';
  appendFact(facts, 'Specifier', evidence.specifier ?? 'not recorded');
  appendFact(facts, 'Line', evidence.line === null ? 'not recorded' : String(evidence.line));
  appendFact(facts, 'Resolution', evidence.resolutionLabel);
  container.append(facts);

  if (handlers.onViewSource) {
    const source = document.createElement('button');
    source.type = 'button';
    source.className = 'source-open';
    source.textContent = 'View source';
    source.addEventListener('click', () => handlers.onViewSource(evidence.source, evidence.line ?? null));
    container.append(source);
  }

  if (handlers.onTrace) {
    const trace = document.createElement('button');
    trace.type = 'button';
    trace.className = 'trace-button';
    trace.textContent = 'Trace path';
    trace.addEventListener('click', () => handlers.onTrace(evidence.source, evidence.target));
    container.append(trace);
  }

  if (handlers.onClear) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'edge-clear';
    clear.textContent = 'Clear edge';
    clear.addEventListener('click', () => handlers.onClear());
    container.append(clear);
  }
}

function edgeEndpoint(id, onSelect) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'link';
  button.textContent = id;
  if (onSelect) {
    button.addEventListener('click', () => onSelect(id));
  }
  return button;
}

/** Render recorded changes, newest first; selecting one compares it with the working tree. */
export function renderTimeline(container, result, onSelect, options = {}) {
  container.replaceChildren();

  const title = document.createElement('h3');
  title.textContent = 'Timeline';
  container.append(title);
  if (options.onClose) {
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'panel-dismiss';
    dismiss.setAttribute('aria-label', 'Close timeline');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => options.onClose());
    title.append(dismiss);
  }

  if (!result || result.available === false) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent = result?.detail ? `No history: ${result.detail}` : 'No Git history available.';
    container.append(note);
    return;
  }

  if (result.commits.length === 0) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent = 'No commits recorded.';
    container.append(note);
    return;
  }

  const list = document.createElement('ul');
  for (const commit of result.commits.slice(0, 50)) {
    const item = document.createElement('li');
    if (options.selectedHash && commit.hash === options.selectedHash) {
      item.classList.add('selected-commit');
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'commit';
    button.dataset.hash = commit.hash;
    button.textContent = `${commit.shortHash} · ${commit.subject}`;
    button.addEventListener('click', () => onSelect(commit));
    item.append(button);
    const meta = document.createElement('span');
    meta.className = 'evidence';
    meta.textContent = `${commit.author} · ${commit.date.slice(0, 10)}`;
    item.append(meta);
    const badge = commitMetricBadge(options.metrics?.get(commit.hash) ?? null);
    if (badge) {
      const metric = document.createElement('span');
      metric.className = `metric-delta ${badge.tone}`;
      metric.dataset.role = 'commit-metrics';
      metric.textContent = badge.text;
      metric.title = badge.title;
      item.append(metric);
    }
    list.append(item);
  }
  container.append(list);
}

/** Days since an ISO date, or null when it does not parse. */
function ageInDays(iso, now = Date.now()) {
  const time = Date.parse(iso ?? '');
  return Number.isFinite(time) ? Math.max(0, Math.floor((now - time) / 86_400_000)) : null;
}

/** A compact age: `today`, `3d`, `5w`, `8mo`, `2y`. */
export function formatAge(days) {
  if (days === null || days === undefined) return '';
  if (days < 1) return 'today';
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  if (days < 730) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** Branches untouched this long are called stale. */
export const STALE_BRANCH_DAYS = 90;

/**
 * How a branch stands, as short tags, most actionable first. Every tag is read from the
 * listing; none is inferred beyond it.
 */
export function branchTags(branch, now = Date.now()) {
  const tags = [];
  if (branch.isBase) tags.push({ text: 'base', tone: 'none' });
  if (branch.current) tags.push({ text: 'checked out', tone: 'none' });
  if (branch.kind === 'remote') tags.push({ text: 'remote only', tone: 'none' });
  if (branch.againstBase?.merged) tags.push({ text: 'merged', tone: 'better' });
  if (branch.upstream?.gone) {
    tags.push({ text: 'upstream gone', tone: 'worse' });
  } else if (branch.upstream && (branch.upstream.ahead > 0 || branch.upstream.behind > 0)) {
    const parts = [];
    if (branch.upstream.ahead > 0) parts.push(`${branch.upstream.ahead} to push`);
    if (branch.upstream.behind > 0) parts.push(`${branch.upstream.behind} to pull`);
    tags.push({ text: parts.join(', '), tone: 'worse' });
  } else if (!branch.upstream && branch.kind === 'local' && !branch.isBase) {
    tags.push({ text: 'no upstream', tone: 'none' });
  }
  const age = ageInDays(branch.tip?.date, now);
  if (age !== null && age >= STALE_BRANCH_DAYS) tags.push({ text: 'stale', tone: 'worse' });
  return tags;
}

/** A small action button shared by the branch panel's header and rows. */
function branchActionButton(role, text, title, handler, busy) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'branch-action';
  button.dataset.role = role;
  button.textContent = text;
  button.title = title;
  button.disabled = Boolean(busy);
  button.addEventListener('click', () => handler());
  return button;
}

/**
 * Branches against a base: commits ahead and behind, sync with the upstream, and age.
 * Selecting one opens its branch review. Counts are as fresh as the last fetch, and the
 * panel says so rather than implying a live remote.
 */
export function renderBranches(container, result, handlers = {}) {
  container.replaceChildren();

  const title = document.createElement('h3');
  title.textContent = 'Branches';
  container.append(title);
  if (handlers.onClose) {
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'panel-dismiss';
    dismiss.setAttribute('aria-label', 'Close branches');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => handlers.onClose());
    title.append(dismiss);
  }

  if (!result || result.available === false) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.dataset.role = 'branches-unavailable';
    note.textContent = result?.detail ? `No branches: ${result.detail}` : 'No Git branches available.';
    container.append(note);
    return;
  }

  const baseLine = document.createElement('p');
  baseLine.className = 'evidence branch-base';
  baseLine.dataset.role = 'branches-base';
  if (result.base) {
    const label = document.createElement('label');
    label.textContent = 'Compared with ';
    const select = document.createElement('select');
    select.dataset.role = 'branches-base-select';
    for (const name of new Set([result.base.name, ...result.branches.map((branch) => branch.name)])) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      option.selected = name === result.base.name;
      select.append(option);
    }
    select.addEventListener('change', () => handlers.onBase?.(select.value));
    label.append(select);
    baseLine.append(label);
    const why = result.base.source === 'remote-default'
      ? ' · the remote’s default branch'
      : result.base.source === 'current'
        ? ' · checked out, no trunk found'
        : '';
    baseLine.append(document.createTextNode(`${why} · as of the last fetch`));
  } else {
    baseLine.textContent = 'No base branch found; divergence is not measured.';
  }
  container.append(baseLine);

  const others = result.branches.filter((branch) => !branch.isBase);
  const unmerged = others.filter((branch) => branch.againstBase && !branch.againstBase.merged).length;
  const summary = document.createElement('p');
  summary.className = 'overlay-summary';
  summary.dataset.role = 'branches-summary';
  summary.textContent = `${others.length} branch(es) · ${unmerged} with unmerged work${
    result.capped ? ' · list capped' : ''
  }`;
  container.append(summary);

  const actions = document.createElement('div');
  actions.className = 'branch-actions';
  actions.dataset.role = 'branch-actions';
  if (handlers.onFetch) {
    actions.append(branchActionButton('branch-fetch', 'Fetch', 'Update the remote-tracking refs', handlers.onFetch, handlers.busy));
  }
  if (handlers.onPull && result.current) {
    actions.append(
      branchActionButton('branch-pull', `Pull ${result.current}`, `Fetch and fast-forward ${result.current} from its upstream (no push)`, handlers.onPull, handlers.busy),
    );
  }
  if (actions.childElementCount > 0) {
    if (handlers.busy) {
      const running = document.createElement('span');
      running.className = 'evidence';
      running.dataset.role = 'branch-busy';
      running.textContent = 'Running…';
      actions.append(running);
    }
    container.append(actions);
  }

  const maxCount = Math.max(
    1,
    ...others.map((branch) => Math.max(branch.againstBase?.ahead ?? 0, branch.againstBase?.behind ?? 0)),
  );

  const list = document.createElement('ul');
  list.className = 'branch-list';
  list.dataset.role = 'branches-list';
  for (const branch of result.branches) {
    const item = document.createElement('li');
    item.className = 'branch-row';
    if (branch.current) item.classList.add('current-branch');
    if (handlers.selected && handlers.selected === branch.name) item.classList.add('selected-branch');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'branch';
    button.dataset.branch = branch.name;
    button.textContent = branch.name;
    if (branch.isBase) {
      button.disabled = true;
      button.title = 'The base every other branch is compared with';
    } else if (handlers.onSelect) {
      button.title = `Review ${branch.name} against ${result.base?.name ?? 'the base'}`;
      button.addEventListener('click', () => handlers.onSelect(branch));
    }
    item.append(button);

    if (branch.againstBase) {
      item.append(divergenceBar(branch.againstBase, maxCount));
    }

    const meta = document.createElement('span');
    meta.className = 'evidence branch-meta';
    const age = formatAge(ageInDays(branch.tip?.date));
    meta.textContent = `${branch.tip.shortHash} · ${branch.tip.author}${age ? ` · ${age}` : ''} · ${branch.tip.subject}`;
    item.append(meta);

    const tags = branchTags(branch);
    if (tags.length > 0) {
      const tagLine = document.createElement('span');
      tagLine.className = 'branch-tags';
      tagLine.dataset.role = 'branch-tags';
      for (const tag of tags) {
        const chip = document.createElement('span');
        chip.className = `metric-delta ${tag.tone}`;
        chip.textContent = tag.text;
        tagLine.append(chip);
      }
      item.append(tagLine);
    }

    const behindCount = branch.upstream?.behind ?? 0;
    if (handlers.onPullBranch && branch.kind === 'local' && !branch.current && !branch.upstream?.gone && behindCount > 0) {
      const pull = document.createElement('button');
      pull.type = 'button';
      pull.className = 'branch-action';
      pull.dataset.role = 'branch-pull-branch';
      pull.dataset.branch = branch.name;
      pull.textContent = `Pull ↓${behindCount}`;
      pull.title = `Fast-forward ${branch.name} from ${branch.upstream?.name ?? 'its upstream'}`;
      pull.disabled = Boolean(handlers.busy);
      pull.addEventListener('click', () => handlers.onPullBranch(branch));
      item.append(pull);
    }

    const pushCount = branch.upstream?.ahead ?? 0;
    const publish = branch.kind === 'local' && !branch.isBase && (!branch.upstream || branch.upstream.gone);
    if (handlers.onPush && branch.kind === 'local' && !branch.isBase && (pushCount > 0 || publish)) {
      const push = document.createElement('button');
      push.type = 'button';
      push.className = 'branch-action';
      push.dataset.role = 'branch-push';
      push.dataset.branch = branch.name;
      push.textContent = pushCount > 0 ? `Push ↑${pushCount}` : 'Publish';
      push.title = pushCount > 0
        ? `Push ${branch.name} to ${branch.upstream?.name ?? 'its remote'}`
        : `Publish ${branch.name} to the remote`;
      push.disabled = Boolean(handlers.busy);
      push.addEventListener('click', () => handlers.onPush(branch));
      item.append(push);
    }
    list.append(item);
  }
  container.append(list);
}

/**
 * Behind on the left, ahead on the right, of a centre line that stands for the base, each
 * scaled to the largest count in the list so branches compare at a glance.
 */
function divergenceBar(counts, maxCount) {
  const bar = document.createElement('span');
  bar.className = 'divergence';
  bar.dataset.role = 'branch-divergence';
  bar.title = `${counts.behind} commit(s) behind the base · ${counts.ahead} ahead`;
  const behind = document.createElement('span');
  behind.className = 'divergence-count';
  behind.textContent = `↓${counts.behind}`;
  const track = document.createElement('span');
  track.className = 'divergence-track';
  const left = document.createElement('span');
  left.className = 'divergence-fill behind';
  left.style.width = `${(counts.behind / maxCount) * 50}%`;
  const right = document.createElement('span');
  right.className = 'divergence-fill ahead';
  right.style.width = `${(counts.ahead / maxCount) * 50}%`;
  track.append(left, right);
  const ahead = document.createElement('span');
  ahead.className = 'divergence-count';
  ahead.textContent = `↑${counts.ahead}`;
  bar.append(behind, track, ahead);
  return bar;
}

/**
 * The branch half of a branch review: divergence, the trial-merge verdict, and the base's
 * newer changes that the branch's files build on.
 */
function renderBranchDivergence(container, branch, handlers = {}) {
  const meta = document.createElement('p');
  meta.className = 'evidence';
  meta.dataset.role = 'review-branch';
  meta.textContent = `${branch.ahead} commit(s) ahead of ${branch.base} · ${branch.behind} behind · merge base ${branch.mergeBase.slice(0, 7)}`;
  container.append(meta);

  const merge = document.createElement('p');
  merge.dataset.role = 'review-merge';
  if (!branch.conflicts.available) {
    merge.className = 'unavailable';
    merge.textContent = `Trial merge unavailable (needs Git 2.38+): ${branch.conflicts.detail}`;
  } else if (branch.conflicts.clean) {
    merge.className = 'merge-verdict clean';
    merge.textContent =
      branch.behind > 0
        ? `Merges cleanly into ${branch.base}, which has moved ${branch.behind} commit(s) on.`
        : `Merges cleanly into ${branch.base}.`;
  } else {
    merge.className = 'merge-verdict conflicted';
    merge.textContent = `Conflicts with ${branch.base} in ${branch.conflicts.paths.length} file(s).`;
  }
  container.append(merge);

  const fileList = (role, heading, entries, describe) => {
    if (entries.length === 0) return;
    const title = document.createElement('h4');
    title.textContent = `${heading} (${entries.length})`;
    container.append(title);
    const list = document.createElement('ul');
    list.dataset.role = role;
    for (const entry of entries.slice(0, 100)) {
      const id = typeof entry === 'string' ? entry : entry.id;
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link';
      button.dataset.path = id;
      button.textContent = id;
      if (handlers.onSelect) button.addEventListener('click', () => handlers.onSelect(id));
      item.append(button);
      const detail = describe?.(entry);
      if (detail) {
        const span = document.createElement('span');
        span.className = 'evidence';
        span.textContent = detail;
        item.append(span);
      }
      list.append(item);
    }
    container.append(list);
  };

  const conflicted = new Set(branch.conflicts.available ? branch.conflicts.paths : []);
  fileList('review-conflicts', 'Conflicting files', [...conflicted]);
  fileList(
    'review-overlap',
    'Also changed on the base',
    branch.overlap.filter((file) => !conflicted.has(file)),
    () => branch.conflicts.available ? 'merges without conflict' : null,
  );
  fileList(
    'review-moved-underneath',
    'Moved underneath the branch',
    branch.movedUnderneath,
    (entry) => `changed on the base · imported by ${entry.via}${entry.distance > 1 ? ` (distance ${entry.distance})` : ''}`,
  );

  if (!branch.checkedOut) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.dataset.role = 'review-branch-graph';
    note.textContent =
      'Impact is traced through the checked-out graph, not this branch’s own; check the branch out for its Change passport.';
    container.append(note);
  }
}

/**
 * Show that a review is being computed. The panel's window opens before the request
 * settles, and a full review of a large change can take tens of seconds, so without this
 * the window would show whatever the previous render left behind.
 */
export function renderReviewLoading(container, handlers = {}) {
  container.replaceChildren();
  const title = document.createElement('h3');
  title.textContent = 'Review';
  container.append(title);
  if (handlers.onBack) {
    title.prepend(backButton(handlers, 'Back to the previous review'));
  }
  if (handlers.onClose) {
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'panel-dismiss';
    dismiss.setAttribute('aria-label', 'Close review');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => handlers.onClose());
    title.append(dismiss);
  }
  const note = document.createElement('p');
  note.className = 'evidence';
  note.dataset.role = 'review-loading';
  note.textContent = 'Reviewing changes…';
  container.append(note);
}

/**
 * The Structure section's rows: the structural diff between the reviewed base and HEAD,
 * grouped for reading. Pure, so the browser and the headless report agree on the events.
 */
export function structuralDiffGroups(structural) {
  if (!structural || structural.available === false) {
    return [];
  }
  const diff = structural.diff ?? {};
  return [
    { key: 'edges-added', label: 'Dependency edges added', items: (diff.edgesAdded ?? []).map(structuralEdgeLabel) },
    { key: 'edges-removed', label: 'Dependency edges removed', items: (diff.edgesRemoved ?? []).map(structuralEdgeLabel) },
    { key: 'cycles-introduced', label: 'Cycles introduced', items: (diff.cyclesIntroduced ?? []).map(structuralCycleLabel) },
    { key: 'cycles-resolved', label: 'Cycles resolved', items: (diff.cyclesResolved ?? []).map(structuralCycleLabel) },
    { key: 'tier-edges-added', label: 'Wrong-way tier edges added', items: (diff.tierEdgesAdded ?? []).map(structuralTierEdgeLabel) },
    { key: 'entry-points-added', label: 'Entry points added', items: [...(diff.entryPointsAdded ?? [])] },
    { key: 'newly-unreached', label: 'Newly unreached', items: [...(diff.newlyUnreached ?? [])] },
  ].filter((group) => group.items.length > 0);
}

/** One dependency edge as a single line. */
export function structuralEdgeLabel(edge) {
  return `${edge.source} → ${edge.target} (${edge.kind})`;
}

/** One cycle as its members in order. */
export function structuralCycleLabel(cycle) {
  return (cycle.members ?? []).join(' → ');
}

/** One wrong-way tier edge with its unit. */
export function structuralTierEdgeLabel(edge) {
  return `${edge.source} → ${edge.target} (${edge.kind}, ${edge.unit})`;
}

/**
 * The Structure section of the Review panel: what the change did to the architecture,
 * from the same document `strabo report` prints. An unreadable base says so rather than
 * rendering an empty diff as if nothing had changed.
 */
function renderStructuralDiff(container, structural) {
  const heading = document.createElement('h4');
  heading.textContent = 'Structure';
  container.append(heading);
  if (!structural || structural.available === false) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.dataset.role = 'review-structure-unavailable';
    note.textContent = structural?.detail
      ? `Structure unavailable: ${structural.detail}`
      : 'Structure unavailable: no base revision to compare.';
    container.append(note);
    return;
  }
  const groups = structuralDiffGroups(structural);
  if (groups.length === 0) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.dataset.role = 'review-structure-empty';
    note.textContent = 'No structural change between the base and HEAD.';
    container.append(note);
    return;
  }
  for (const group of groups) {
    const title = document.createElement('h5');
    title.textContent = `${group.label} (${group.items.length})`;
    container.append(title);
    const list = document.createElement('ul');
    list.dataset.role = `review-structure-${group.key}`;
    for (const item of group.items) {
      const entry = document.createElement('li');
      entry.textContent = item;
      list.append(entry);
    }
    container.append(list);
  }
}

/**
 * Render a Git review: what changed, by how much, and what the change can reach.
 *
 * A commit review names its revision; a working-tree review groups staged, unstaged, and
 * untracked files. Files outside the scanned graph are called out because no dependency
 * impact can be computed for them, and uncounted files are reported rather than shown
 * as zero lines.
 */
export function renderReview(container, result, handlers = {}) {
  container.replaceChildren();

  const title = document.createElement('h3');
  title.textContent =
    result?.kind === 'commit'
      ? 'Commit review'
      : result?.kind === 'branch'
        ? `Branch review · ${result.ref}`
        : 'Working tree review';
  container.append(title);
  if (handlers.onBack) {
    title.prepend(backButton(handlers, 'Back to the previous review'));
  }
  if (handlers.onClose) {
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'panel-dismiss';
    dismiss.setAttribute('aria-label', 'Close review');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => handlers.onClose());
    title.append(dismiss);
  }

  if (!result || result.available === false) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.dataset.role = 'review-unavailable';
    note.textContent = result?.detail
      ? `Review unavailable: ${result.detail}`
      : 'Review unavailable: no Git metadata.';
    container.append(note);
    return;
  }

  if (result.commit) {
    const meta = document.createElement('p');
    meta.className = 'evidence';
    meta.dataset.role = 'review-commit';
    meta.textContent = `${result.commit.shortHash} · ${result.commit.author} · ${result.commit.date.slice(0, 10)} · ${result.commit.subject}`;
    container.append(meta);
  }

  const totals = result.totals ?? { files: 0, insertions: 0, deletions: 0, uncounted: 0 };
  const summary = document.createElement('p');
  summary.className = 'overlay-summary';
  summary.dataset.role = 'review-summary';
  summary.textContent = `${totals.files} file(s) · +${totals.insertions} −${totals.deletions}${
    totals.uncounted > 0 ? ` · ${totals.uncounted} uncounted` : ''
  }`;
  container.append(summary);

  // The opt-in narrator may explain the change set; it never alters the recorded review.
  const narrator = document.createElement('div');
  narrator.className = 'review-narrator';
  appendNarratorBlock(narrator, handlers, { id: 'narrate-change', label: 'Narrate change' });
  if (narrator.childElementCount > 0) {
    container.append(narrator);
  }

  if (result.branch) {
    renderBranchDivergence(container, result.branch, handlers);
  }

  if ((result.files ?? []).length === 0) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent =
      result.kind === 'commit'
        ? 'This commit recorded no file changes.'
        : result.kind === 'branch'
          ? 'This branch has no changes the base lacks.'
          : 'No pending changes.';
    container.append(note);
  }

  for (const [group, files] of reviewGroups(result.files)) {
    const heading = document.createElement('h4');
    heading.textContent = `${REVIEW_GROUP_LABELS[group] ?? group} (${files.length})`;
    container.append(heading);

    const list = document.createElement('ul');
    list.dataset.role = `review-group-${group}`;
    for (const file of files) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link';
      button.dataset.path = file.path;
      button.textContent = file.path;
      if (handlers.onSelect && file.inGraph) {
        button.addEventListener('click', () => handlers.onSelect(file.path));
      } else {
        button.disabled = true;
        button.title = 'Not a node in the scanned graph';
      }
      item.append(button);
      const status = document.createElement('span');
      status.className = 'review-status';
      status.textContent = file.status;
      item.append(status);
      const counts = document.createElement('span');
      counts.className = 'evidence';
      counts.textContent =
        file.insertions === null || file.deletions === null
          ? 'line counts unavailable'
          : `+${file.insertions} −${file.deletions}`;
      item.append(counts);
      if (handlers.onOpenDiff) {
        const diff = document.createElement('button');
        diff.type = 'button';
        diff.className = 'link review-diff';
        diff.dataset.path = file.path;
        diff.textContent = 'Diff';
        diff.title = `Show the change to ${file.path}`;
        diff.addEventListener('click', () => handlers.onOpenDiff(file.path, file));
        item.append(diff);
      }
      list.append(item);
    }
    container.append(list);
  }

  if (result.structural !== undefined) {
    renderStructuralDiff(container, result.structural);
  }

  renderChangeMetrics(container, result.metrics, handlers);
  renderChangePassport(container, result.cohesion);
  if (result.impactPassport) {
    const impactSection = document.createElement('div');
    impactSection.className = 'impact-passport-section';
    container.append(impactSection);
    renderImpactPassport(impactSection, result.impactPassport, handlers);
  }

  const affected = (result.impact?.affected ?? []).filter((entry) => entry.distance > 0);
  const impactHeading = document.createElement('h4');
  impactHeading.textContent = `Potentially affected (${affected.length})`;
  container.append(impactHeading);
  if (affected.length === 0) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.dataset.role = 'review-impact-empty';
    note.textContent = 'Nothing depends on the changed files.';
    container.append(note);
  } else {
    const list = document.createElement('ul');
    list.dataset.role = 'review-impact';
    for (const entry of affected.slice(0, 100)) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link';
      button.textContent = entry.id;
      if (handlers.onSelect) {
        button.addEventListener('click', () => handlers.onSelect(entry.id));
      }
      item.append(button);
      const distance = document.createElement('span');
      distance.className = 'evidence';
      distance.textContent = `distance ${entry.distance}`;
      item.append(distance);
      list.append(item);
    }
    container.append(list);
  }

  if ((result.impact?.outsideGraph ?? []).length > 0) {
    const outside = document.createElement('p');
    outside.className = 'unavailable';
    outside.dataset.role = 'review-outside';
    outside.textContent = `${result.impact.outsideGraph.length} changed path(s) are outside the scanned graph.`;
    container.append(outside);
  }
}

/**
 * Change metrics: complexity and coupling before and after, per change set and per file.
 * Complexity is the summed decision points of each file's functions; coupling is the file's
 * resolved imports. A side that was not measured shows a dash, not a zero.
 */
function renderChangeMetrics(container, metrics, handlers = {}) {
  if (!metrics || metrics.available === false) {
    return;
  }

  const heading = document.createElement('h4');
  heading.textContent = 'Change metrics';
  container.append(heading);

  const summary = document.createElement('p');
  summary.className = 'overlay-summary';
  summary.dataset.role = 'change-metrics-summary';
  summary.textContent = changeMetricSummary(metrics.totals);
  container.append(summary);

  const files = orderMetricFiles(metrics.files);
  if (files.length === 0) {
    return;
  }

  const table = document.createElement('table');
  table.className = 'change-metrics';
  table.dataset.role = 'change-metrics';
  const head = document.createElement('tr');
  for (const [label, title] of [
    ['File', ''],
    ['Cx', 'Complexity: net change in summed function decision points'],
    ['Out', 'Fan-out: resolved in-repository imports, before → after'],
    ['In', 'Fan-in change from importers inside this change set'],
    ['Lines', 'Line count, net'],
  ]) {
    const cell = document.createElement('th');
    cell.textContent = label;
    if (title) cell.title = title;
    head.append(cell);
  }
  table.append(head);

  for (const file of files) {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'link';
    link.textContent = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
    if (handlers.onSelect && file.status !== 'deleted') {
      link.addEventListener('click', () => handlers.onSelect(file.path));
    } else {
      link.disabled = true;
    }
    name.append(link);
    if (file.note) name.title = file.note;
    row.append(name);

    const churn = file.complexityChange;
    const complexity = churn ? metricDelta(0, churn.added - churn.removed) : metricDelta(null, null);
    row.append(
      metricCell(
        complexity,
        churn
          ? [
              `${file.before?.complexity ?? '—'} → ${file.after?.complexity ?? '—'} (+${churn.added} −${churn.removed})`,
              ...file.functions
                .slice(0, 8)
                .map((fn) => `${fn.owner ? `${fn.owner}.` : ''}${fn.name}: ${fn.before ?? 'new'} → ${fn.after ?? 'removed'}`),
            ].join('\n')
          : (file.note ?? 'not measured'),
      ),
    );
    row.append(
      metricCell(
        file.fanOut ? metricDelta(file.fanOut.before, file.fanOut.after) : metricDelta(null, null),
        file.fanOut
          ? [
              `${file.fanOut.before} → ${file.fanOut.after}`,
              ...file.importsAdded.map((target) => `+ ${target}`),
              ...file.importsRemoved.map((target) => `− ${target}`),
            ].join('\n')
          : (file.note ?? 'imports not resolved'),
      ),
    );
    row.append(metricCell(metricDelta(0, file.fanInDelta ?? 0), 'Importers gained or lost within this change set'));
    const lines = metricDelta(file.before?.lines ?? 0, file.after?.lines ?? 0);
    row.append(metricCell({ ...lines, tone: lines.delta ? 'flat' : lines.tone }, `${file.before?.lines ?? 0} → ${file.after?.lines ?? 0}`));
    table.append(row);
  }
  container.append(table);

  if (metrics.capped) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent = 'Only the first files in the change set were measured.';
    container.append(note);
  }
}

function metricCell(delta, title) {
  const cell = document.createElement('td');
  const value = document.createElement('span');
  value.className = `metric-delta ${delta.tone}`;
  value.textContent = delta.text;
  cell.append(value);
  if (title) cell.title = title;
  return cell;
}

const REVIEW_GROUP_LABELS = {
  commit: 'Changed',
  branch: 'Changed on the branch',
  staged: 'Staged',
  unstaged: 'Unstaged',
  untracked: 'Untracked',
};

/**
 * The Change passport: cohesion before and after each changed file, from recorded wiring.
 * A file whose side is missing names why instead of showing a number.
 */
function renderChangePassport(container, passport) {
  if (!passport || !Array.isArray(passport.files) || passport.files.length === 0) {
    return;
  }

  const heading = document.createElement('h4');
  heading.textContent = 'Change passport';
  container.append(heading);

  const caption = document.createElement('p');
  caption.className = 'unavailable';
  caption.textContent = passport.baseline
    ? `Cohesion from recorded member wiring, compared with ${passport.baseline}.`
    : 'Cohesion from recorded member wiring; no baseline revision was available.';
  container.append(caption);

  const list = document.createElement('ul');
  list.className = 'change-passport';
  list.dataset.role = 'change-passport';
  for (const change of passport.files) {
    const item = document.createElement('li');
    const path = document.createElement('span');
    path.className = 'passport-change-path';
    path.textContent = change.previousPath
      ? `${change.previousPath} → ${change.path}`
      : change.path;
    item.append(path);
    const delta = cohesionDelta(change);
    const value = document.createElement('span');
    value.className = `health-delta ${delta.tone}`;
    value.dataset.role = 'cohesion-delta';
    value.textContent = delta.text;
    value.title = change.note ?? '';
    item.append(value);
    list.append(item);
  }
  container.append(list);

  if (passport.capped) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent = 'Only the first files in the change set were measured.';
    container.append(note);
  }
}

/**
 * The Change impact passport: the current-graph risk surface plus the deltas a change
 * produced. Rendered for one file, or rolled up for a change set or revision. Every value
 * comes from the server's recorded facts; a missing measure is a dash with its reason.
 */
export function renderImpactPassport(container, set, handlers = {}) {
  container.replaceChildren();
  if (!set || !Array.isArray(set.files) || set.files.length === 0) {
    container.append(unavailableNote('No impact passport was recorded.'));
    return;
  }

  const heading = document.createElement('h4');
  heading.textContent = passportHeading(set.scope);
  container.append(heading);

  const caption = document.createElement('p');
  caption.className = 'unavailable';
  caption.textContent = set.baseline
    ? `Current graph; compared with ${set.baseline}.`
    : 'Current graph; no baseline revision was available.';
  container.append(caption);

  if (set.scope === 'file') {
    container.append(impactCard(set.files[0], false));
    return;
  }

  container.append(impactCard(set.totals, true));
  const list = document.createElement('ul');
  list.className = 'impact-files';
  list.dataset.role = 'impact-files';
  for (const file of set.files) {
    list.append(impactFileRow(file, handlers));
  }
  container.append(list);

  if (set.capped) {
    container.append(unavailableNote('Only the first files in the change set were measured.'));
  }
}

function impactCard(card, totals) {
  const wrapper = document.createElement('div');
  wrapper.className = 'impact-card';
  wrapper.dataset.role = totals ? 'impact-totals' : 'impact-file-card';

  const grid = document.createElement('div');
  grid.className = 'impact-grid';
  const cells = totals ? totalsPassportCells(card) : filePassportCells(card);
  for (const cell of cells) {
    const item = document.createElement('div');
    item.className = 'impact-cell';
    item.dataset.role = `impact-${cell.key}`;
    const label = document.createElement('div');
    label.className = 'impact-cell-label';
    label.textContent = cell.label;
    const value = document.createElement('div');
    value.className = `impact-cell-value ${cell.tone ?? 'none'}`;
    value.textContent = cell.value;
    const detail = document.createElement('div');
    detail.className = 'impact-cell-detail';
    detail.textContent = cell.detail;
    item.append(label, value, detail);
    grid.append(item);
  }
  wrapper.append(grid);

  wrapper.append(
    impactList(
      'Risk signals',
      (card?.signals ?? []).map((signal) => ({ text: signal.label, detail: signal.detail })),
      'impact-signals',
    ),
  );
  wrapper.append(
    impactList(
      'Most complex functions',
      (card?.mostComplex ?? []).map((fn) => ({
        text: impactFunctionLabel(fn),
        detail: `C${fn.complexity}${fn.delta ? ` (${fn.delta > 0 ? '+' : '−'}C${Math.abs(fn.delta)})` : ''}`,
      })),
      'impact-most-complex',
    ),
  );

  return wrapper;
}

function impactList(title, entries, role) {
  const section = document.createElement('div');
  section.className = 'impact-list';
  const heading = document.createElement('h5');
  heading.textContent = title;
  section.append(heading);
  if (entries.length === 0) {
    section.append(unavailableNote('None recorded.'));
    section.dataset.role = role;
    return section;
  }
  const list = document.createElement('ul');
  list.dataset.role = role;
  for (const entry of entries) {
    const item = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = entry.text;
    item.append(text);
    if (entry.detail) {
      const detail = document.createElement('span');
      detail.className = 'evidence';
      detail.textContent = entry.detail;
      item.append(detail);
    }
    list.append(item);
  }
  section.append(list);
  return section;
}

function impactFileRow(file, handlers) {
  const item = document.createElement('li');
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'link';
  link.dataset.path = file.path;
  link.textContent = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
  if (handlers.onSelect) {
    link.addEventListener('click', () => handlers.onSelect(file.path));
  } else {
    link.disabled = true;
  }
  item.append(link);

  const risk = document.createElement('span');
  risk.className = `impact-risk-band ${file.risk ? riskTone(file.risk.band) : 'none'}`;
  risk.textContent = file.risk ? `${riskBandLabel(file.risk.band)} ${file.risk.score}` : '—';
  item.append(risk);

  const cx = document.createElement('span');
  cx.className = 'evidence';
  cx.textContent = `${complexityValue(file.complexity?.maxAfter)} · coherence ${file.coherence ? `${file.coherence.score}/100` : '—'}`;
  item.append(cx);
  return item;
}

export { graphSummary };

/* ------------------------------------------------------------------ Member map view */

const MEMBER_ORDER_OPTIONS = [
  ['source', 'Source order'],
  ['name', 'Name'],
  ['visibility', 'Visibility'],
];

const ZOOM_LEVELS = [
  ['overview', 'Overview'],
  ['medium', 'Medium'],
  ['detail', 'Detail'],
];

function unavailableNote(text) {
  const note = document.createElement('p');
  note.className = 'unavailable';
  note.textContent = text;
  return note;
}

function button(id, text, handler, className = '') {
  const element = document.createElement('button');
  element.type = 'button';
  element.id = id;
  element.className = className || undefined;
  element.textContent = text;
  if (handler) {
    element.addEventListener('click', handler);
  }
  return element;
}

/**
 * Dependency risk: advisories, license policy, and the files that import each package.
 *
 * A finding is shown only as far as the scan can justify it: the dependency version comes
 * from a lockfile, the importing files come from recorded imports, and impact is reverse
 * reachability. When online lookup is off the panel says so rather than showing an empty
 * advisory list that would read as a clean bill of health.
 */
export function renderRisk(container, report, handlers = {}) {
  container.replaceChildren();

  const title = document.createElement('h3');
  title.textContent = 'Dependency risk';
  container.append(title);
  if (handlers.onClose) {
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'panel-dismiss';
    dismiss.setAttribute('aria-label', 'Close risk panel');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => handlers.onClose());
    title.append(dismiss);
  }

  if (!report || report.available === false) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.dataset.role = 'risk-unavailable';
    note.textContent = 'Risk report unavailable.';
    container.append(note);
    return;
  }

  const summary = document.createElement('p');
  summary.className = 'overlay-summary';
  summary.dataset.role = 'risk-summary';
  summary.textContent = riskSummary(report);
  container.append(summary);

  const online = document.createElement('p');
  online.className = report.online ? 'evidence' : 'unavailable';
  online.dataset.role = 'risk-mode';
  online.textContent = report.online
    ? 'Advisory and license data from OSV.dev and deps.dev.'
    : 'Online advisory and license lookup is off; showing inventory and imports only.';
  container.append(online);

  if (report.inventory.undeclared.length > 0) {
    const undeclared = document.createElement('p');
    undeclared.className = 'unavailable';
    undeclared.dataset.role = 'risk-undeclared';
    undeclared.textContent = `${report.inventory.undeclared.length} imported package(s) are not declared in any manifest: ${report.inventory.undeclared.slice(0, 8).join(', ')}`;
    container.append(undeclared);
  }

  const advisories = orderAdvisories(report.advisories);
  const heading = document.createElement('h4');
  heading.textContent = `Advisories (${advisories.length})`;
  container.append(heading);

  if (advisories.length === 0) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.dataset.role = 'risk-advisories-empty';
    note.textContent = report.online
      ? 'No known advisories for the resolved dependencies.'
      : 'Advisories were not looked up.';
    container.append(note);
  } else {
    const list = document.createElement('ul');
    list.dataset.role = 'risk-advisories';
    for (const advisory of advisories) {
      const item = document.createElement('li');
      item.className = `risk-advisory severity-${advisory.severity}`;
      item.dataset.role = 'risk-advisory';

      const line = document.createElement('div');
      const severity = document.createElement('span');
      severity.className = `risk-severity severity-${advisory.severity}`;
      severity.textContent = advisory.severity;
      line.append(severity);

      const link = document.createElement('a');
      link.className = 'link';
      link.href = advisory.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = advisory.id;
      line.append(link);
      if (advisory.aliases.length > 0) {
        const aliases = document.createElement('span');
        aliases.className = 'evidence';
        aliases.textContent = advisory.aliases.join(', ');
        line.append(aliases);
      }
      item.append(line);

      const subject = document.createElement('p');
      subject.className = 'evidence';
      subject.textContent = `${advisory.dependency.name}@${advisory.dependency.version ?? 'unresolved'} · ${advisory.summary}`;
      item.append(subject);

      if (advisory.fixed.length > 0) {
        const fixed = document.createElement('p');
        fixed.className = 'evidence';
        fixed.textContent = `Fixed in: ${advisory.fixed.join(', ')}`;
        item.append(fixed);
      }

      if (advisory.importedBy.length > 0) {
        const files = document.createElement('p');
        files.className = 'evidence';
        files.textContent = `Imported by: ${advisory.importedBy.join(', ')}`;
        item.append(files);
      } else {
        const files = document.createElement('p');
        files.className = 'unavailable';
        files.textContent = 'No source file imports this package directly.';
        item.append(files);
      }

      const impacted = advisory.impactedFiles.filter((entry) => entry.distance > 0);
      if (impacted.length > 0) {
        const list = document.createElement('ul');
        list.dataset.role = 'risk-impact';
        for (const entry of impacted.slice(0, 20)) {
          const entryItem = document.createElement('li');
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'link';
          button.textContent = entry.id;
          if (handlers.onSelect) {
            button.addEventListener('click', () => handlers.onSelect(entry.id));
          }
          entryItem.append(button);
          const distance = document.createElement('span');
          distance.className = 'evidence';
          distance.textContent = `distance ${entry.distance}`;
          entryItem.append(distance);
          list.append(entryItem);
        }
        item.append(list);
      }
      list.append(item);
    }
    container.append(list);
  }

  const flagged = report.licenses.filter((entry) => entry.denied || entry.risk !== 'permissive');
  const licenseHeading = document.createElement('h4');
  licenseHeading.textContent = `Licenses needing review (${flagged.length})`;
  container.append(licenseHeading);
  if (flagged.length === 0) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.dataset.role = 'risk-licenses-empty';
    note.textContent = report.online
      ? 'No denied or copyleft licenses were found.'
      : 'Licenses were not looked up.';
    container.append(note);
  } else {
    const list = document.createElement('ul');
    list.dataset.role = 'risk-licenses';
    for (const entry of flagged.slice(0, 50)) {
      const item = document.createElement('li');
      const label = `${entry.dependency.name}@${entry.dependency.version ?? 'unresolved'} · ${entry.licenses.join(' OR ') || 'no license recorded'}`;
      const span = document.createElement('span');
      span.textContent = label;
      item.append(span);
      const risk = document.createElement('span');
      risk.className = entry.denied ? 'risk-severity severity-critical' : 'evidence';
      risk.textContent = entry.denied ? 'denied' : entry.risk;
      item.append(risk);
      list.append(item);
    }
    container.append(list);
  }

  if (report.caveats.length > 0) {
    const caveats = document.createElement('p');
    caveats.className = 'unavailable';
    caveats.dataset.role = 'risk-caveats';
    caveats.textContent = report.caveats.join(' ');
    container.append(caveats);
  }
}

/**
 * The identity of the narrator affordance, so its block is rebuilt only when the narrator's
 * configured model or failure reason changes, not on every member-map interaction.
 */
function narratorBlockKey(status) {
  if (!status || status.configured !== true) {
    return 'off';
  }
  return `on:${status.model ?? ''}:${status.reason ?? ''}`;
}

/**
 * The full-screen Member map: toolbar, flow walkthrough, field/method cards, data-flow
 * panels, and the health and constellation insights.
 *
 * Every value comes from the server's member map and health report; panels without
 * evidence say so. `view` holds UI state only (order, find text, step index, ...).
 */
export function renderMemberMap(container, data, view, handlers = {}) {
  const memberMap = data?.memberMap;
  const steps = memberMapSteps(memberMap, {
    consumers: data?.consumerIds ? data.consumerIds.length : null,
  });
  const stepIndex = Math.min(Math.max(view.stepIndex ?? 0, 0), steps.length - 1);
  container.dataset.zoom = view.zoom ?? 'medium';
  container.dataset.step = steps[stepIndex]?.key ?? 'fingerprint';
  container.classList.toggle('wiring-off', view.showWiring === false);
  container.classList.toggle('dim-unrelated', view.dim === true);

  // The heavy sections stay imperative but are hosted under a key built from the inputs that
  // actually change them. A walkthrough tick or a zoom change reuses them instead of
  // rebuilding the tree, so the find input keeps focus and CSS animations do not restart.
  const mainKey = [
    data?.file ?? '',
    view.find ?? '',
    view.order ?? '',
    view.showWiring !== false,
    view.onlyFlow === true,
    view.dataFlow !== false,
  ].join('|');
  const insightsKey = [
    data?.file ?? '',
    data?.health?.score ?? '',
    (data?.consumerIds ?? []).length,
    (memberMap?.types ?? []).length,
  ].join('|');

  mount(
    container,
    h(
      Fragment,
      null,
      h(
        'header',
        { className: 'member-header', key: 'header' },
        handlers.onBack
          ? h(
              'button',
              {
                key: 'back',
                type: 'button',
                className: 'panel-back',
                dataset: { role: 'panel-back' },
                title: handlers.backTitle ?? 'Back to the module passport',
                'aria-label': handlers.backTitle ?? 'Back to the module passport',
                onClick: () => handlers.onBack?.(),
              },
              '← Back',
            )
          : null,
        h('p', { className: 'member-crumb', key: 'crumb' }, `${data?.repository ?? 'repository'} / ${data?.file ?? ''}`),
        h('h2', { key: 'title' }, 'Member map'),
      ),
      memberToolbar(view, handlers),
      memberWalkthrough(steps, stepIndex, handlers),
      view.explain
        ? h(
            'p',
            { className: 'member-explain', key: 'explain', dataset: { role: 'explain' } },
            explainClass(memberMap),
          )
        : null,
      // Hosted, so a reply survives a find keystroke or a walkthrough step; it is rebuilt for a
      // different file, or when the narrator's configured identity changes.
      handlers.onNarrate
        ? host(`narrator:${data?.file ?? ''}:${narratorBlockKey(handlers.narratorStatus)}`, () => {
            const narrator = document.createElement('div');
            narrator.className = 'member-narrator';
            appendNarratorBlock(narrator, handlers, { id: 'narrate-member', label: 'Narrate' });
            return narrator;
          })
        : null,
      h(
        'div',
        { className: 'member-body', key: 'body' },
        host(`main:${mainKey}`, () => buildMemberMain(memberMap, view, data)),
        host(`insights:${insightsKey}`, () => buildMemberInsights(data, memberMap)),
      ),
    ),
  );
}

/** The type sections and data-flow panels, rebuilt only when a filter or toggle changes. */
function buildMemberMain(memberMap, view, data) {
  const main = document.createElement('section');
  main.className = 'member-main';
  const clusters = memberClusters(memberMap);
  for (const type of memberMap?.types ?? []) {
    main.append(buildTypeSection(type, view, clusters, {}));
  }
  if ((memberMap?.types ?? []).length === 0) {
    main.append(unavailableNote(memberMap?.detail ?? 'No members declared for this file.'));
  }
  if (view.dataFlow !== false) {
    main.append(buildDataFlow(memberMap, data?.consumerIds ?? null));
  }
  return main;
}

function buildMemberInsights(data, memberMap) {
  const insights = document.createElement('aside');
  insights.className = 'member-insights';
  insights.append(buildHealth(data?.health, data?.metrics));
  insights.append(buildConstellation(memberMap, data?.consumerIds ?? null));
  return insights;
}

function memberToolbar(view, handlers) {
  const zoom = h(
    'span',
    { key: 'zoom', className: 'member-zoom', role: 'group', 'aria-label': 'Zoom' },
    ...ZOOM_LEVELS.map(([value, label]) =>
      h(
        'button',
        {
          key: value,
          type: 'button',
          id: `member-zoom-${value}`,
          className: (view.zoom ?? 'medium') === value ? 'active' : undefined,
          dataset: { zoom: value },
          onClick: () => handlers.onZoom?.(value),
        },
        label,
      ),
    ),
  );

  return h(
    'div',
    { className: 'member-toolbar', role: 'toolbar', key: 'toolbar' },
    memberControl(
      'Find member',
      h('input', {
        type: 'search',
        id: 'member-find',
        placeholder: 'Method or field name',
        value: view.find ?? '',
        onInput: (event) => handlers.onFind?.(event.target.value),
      }),
      'find',
    ),
    memberControl(
      'Order',
      h(
        'select',
        {
          id: 'member-order',
          value: view.order ?? 'source',
          onChange: (event) => handlers.onOrder?.(event.target.value),
        },
        ...MEMBER_ORDER_OPTIONS.map(([value, label]) => h('option', { key: value, value }, label)),
      ),
      'order',
    ),
    memberSeparator('sep-1'),
    zoom,
    memberControl(
      'Show wiring',
      h('input', {
        type: 'checkbox',
        id: 'member-wiring',
        checked: view.showWiring !== false,
        onChange: (event) => handlers.onWiring?.(event.target.checked),
      }),
      'wiring',
    ),
    memberControl(
      'Data flow',
      h('input', {
        type: 'checkbox',
        id: 'member-dataflow',
        checked: view.dataFlow !== false,
        onChange: (event) => handlers.onDataFlow?.(event.target.checked),
      }),
      'dataflow',
    ),
    memberSeparator('sep-2'),
    memberButton('member-explain', 'Explain', () => handlers.onExplain?.()),
    h(
      'button',
      {
        key: 'night',
        type: 'button',
        id: 'member-night',
        className: view.dim ? 'active' : undefined,
        title: 'Dim cards outside the current walkthrough step',
        onClick: () => handlers.onNight?.(),
      },
      view.dim ? 'Undim' : 'Dim unrelated',
    ),
    memberButton('member-compare', 'Compare', () => handlers.onCompare?.()),
    memberButton('member-only-flow', view.onlyFlow ? 'Show all' : 'Wired only', () => handlers.onOnlyFlow?.()),
    memberButton('member-reset', 'Reset', () => handlers.onReset?.()),
    memberButton('member-close', 'Close ✕', () => handlers.onClose?.()),
  );
}

function memberWalkthrough(steps, index, handlers) {
  return h(
    'div',
    { className: 'member-walkthrough', key: 'walkthrough' },
    h(
      'div',
      { className: 'walk-dots', key: 'dots' },
      ...steps.map((step, stepIndex) =>
        h('button', {
          key: step.key,
          type: 'button',
          className: 'walk-dot',
          title: step.label,
          'aria-label': `Go to step ${stepIndex + 1}: ${step.label}`,
          'aria-current': stepIndex === index ? 'step' : undefined,
          onClick: () => handlers.onStep?.(stepIndex - index),
        }),
      ),
    ),
    h(
      'p',
      { className: 'member-step', key: 'line', dataset: { role: 'member-step' } },
      `Step ${index + 1} of ${steps.length} (${steps[index]?.label ?? ''}): ${steps[index]?.caption ?? ''}`,
    ),
    h(
      'div',
      { className: 'walk-actions', key: 'actions' },
      memberButton('member-prev', '← Prev', () => handlers.onStep?.(-1)),
      memberButton('member-play', '▶ Play', () => handlers.onPlay?.()),
      memberButton('member-next', 'Step →', () => handlers.onStep?.(1)),
    ),
  );
}

function memberControl(label, control, key) {
  return h('label', { className: 'member-control', key }, label, control);
}

function memberSeparator(key) {
  return h('span', { className: 'tb-sep', key, 'aria-hidden': 'true' });
}

function memberButton(id, text, handler, className = '') {
  return h('button', { key: id, type: 'button', id, className: className || undefined, onClick: handler }, text);
}

function buildTypeSection(type, view, clusters, handlers) {
  const section = document.createElement('section');
  section.className = 'member-type';

  const heading = document.createElement('h3');
  heading.className = 'member-type-name';
  heading.textContent = type.name;
  const count = document.createElement('span');
  count.className = 'member-count';
  count.textContent = `${type.fields.length + type.methods.length} members`;
  heading.append(count);
  section.append(heading);

  const legend = document.createElement('div');
  legend.className = 'member-clusters';
  legend.dataset.role = 'clusters';
  for (const cluster of clusters.clusters) {
    const chip = document.createElement('span');
    chip.className = `cluster ${clusterSeriesClass(cluster.index)}`;
    chip.textContent = `cluster ${cluster.index}`;
    legend.append(chip);
  }
  section.append(legend);

  const find = (view.find ?? '').trim().toLowerCase();
  let fields = orderMembers(
    type.fields.filter((field) => matches(field.name, find) && (!view.onlyFlow || isWiredField(field))),
    view.order,
  );
  let methods = orderMembers(
    type.methods.filter((method) => matches(method.name, find) && (!view.onlyFlow || isWiredMethod(method))),
    view.order,
  );

  const relations = memberRelations(type);
  section.addEventListener('pointerover', (event) => {
    const card = event.target.closest?.('.member-card');
    if (card) traceMember(section, card);
  });
  section.addEventListener('pointerout', (event) => {
    const card = event.target.closest?.('.member-card');
    if (!card) return;
    const next = event.relatedTarget?.closest?.('.member-card');
    if (next && section.contains(next)) return;
    clearTrace(section);
  });

  const fieldHeading = document.createElement('h4');
  fieldHeading.textContent = `Fields / data (${fields.length})`;
  section.append(fieldHeading);
  const fieldList = document.createElement('div');
  fieldList.className = 'member-cards';
  fieldList.dataset.role = 'fields';
  for (const field of fields) {
    fieldList.append(buildFieldCard(field, clusters.clusterOf.get(field.name), relations.get(field.name)));
  }
  if (fields.length === 0) {
    fieldList.append(unavailableNote('No fields recorded.'));
  }
  section.append(fieldList);

  const methodHeading = document.createElement('h4');
  methodHeading.textContent = `Methods (${methods.length})`;
  section.append(methodHeading);
  const methodList = document.createElement('div');
  methodList.className = 'member-cards';
  methodList.dataset.role = 'methods';
  for (const method of methods) {
    methodList.append(buildMethodCard(method, clusters.clusterOf.get(method.name), relations.get(method.name)));
  }
  if (methods.length === 0) {
    methodList.append(unavailableNote('No methods recorded.'));
  }
  section.append(methodList);

  return section;
}

/**
 * The recorded read/write wiring as a member -> member map, so hovering a field can name
 * the methods that touch it and vice versa. Only recorded references are linked.
 */
function memberRelations(type) {
  const relations = new Map();
  const link = (owner, other) => {
    if (!relations.has(owner)) relations.set(owner, new Set());
    relations.get(owner).add(other);
  };
  for (const method of type.methods) {
    for (const fieldName of [...method.reads, ...method.writes]) {
      link(method.name, fieldName);
      link(fieldName, method.name);
    }
  }
  return relations;
}

function traceMember(section, card) {
  const name = card.dataset.member;
  const related = new Set((card.dataset.related ?? '').split(' ').filter(Boolean));
  related.add(name);
  for (const other of section.querySelectorAll('.member-card')) {
    const member = other.dataset.member;
    other.classList.toggle('trace-unrelated', !related.has(member));
    other.classList.toggle('trace-hit', related.has(member) && member !== name);
  }
  card.classList.remove('trace-unrelated');
  card.classList.add('trace-source');
}

function clearTrace(section) {
  for (const card of section.querySelectorAll('.member-card')) {
    card.classList.remove('trace-unrelated', 'trace-hit', 'trace-source');
  }
}

/** Bound the cluster stagger so a class with many clusters does not outrun the step tick. */
function staggerFor(clusterIndex) {
  return Math.min(Math.max(0, (clusterIndex ?? 1) - 1), 6);
}

function matches(name, needle) {
  return !needle || name.toLowerCase().includes(needle);
}

function buildFieldCard(field, clusterIndex, related) {
  const card = fieldCard(field);
  const element = document.createElement('article');
  element.className = 'member-card field-card';
  element.dataset.member = field.name;
  element.dataset.cluster = String(clusterIndex ?? 0);
  element.dataset.related = related ? [...related].join(' ') : '';
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', card.signature);
  element.style.setProperty('--cluster-stagger', String(staggerFor(clusterIndex)));
  element.append(cardLine('card-eyebrow', `${card.eyebrow} · CLUSTER ${clusterIndex ?? '—'}`));
  element.append(cardLine('card-signature', card.signature));
  const tag = cardLine('card-tag', card.tag);
  if (card.tag !== 'unconnected') tag.classList.add('is-wired');
  element.append(tag);
  element.append(cardLine('card-metrics', card.metrics));
  return element;
}

function buildMethodCard(method, clusterIndex, related) {
  const card = methodCard(method);
  const element = document.createElement('article');
  element.className = 'member-card method-card';
  element.dataset.member = method.name;
  element.dataset.cluster = String(clusterIndex ?? 0);
  element.dataset.related = related ? [...related].join(' ') : '';
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', card.signature);
  element.style.setProperty('--cluster-stagger', String(staggerFor(clusterIndex)));
  element.append(cardLine('card-eyebrow', `${card.eyebrow} · CLUSTER ${clusterIndex ?? '—'}`));
  element.append(cardLine('card-signature', card.signature));
  const tag = cardLine('card-tag', card.tag);
  if (card.tag === 'wired') tag.classList.add('is-wired');
  element.append(tag);
  element.append(cardLine('card-metrics', card.metrics));
  return element;
}

function cardLine(className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function flowPanel(label, key, items) {
  const panel = document.createElement('div');
  panel.className = 'flow-panel';
  panel.dataset.flow = key;

  const header = document.createElement('header');
  header.textContent = label;
  const count = document.createElement('span');
  count.className = 'flow-count';
  count.textContent = String(items.length);
  header.append(count);
  panel.append(header);

  if (items.length === 0) {
    panel.append(unavailableNote(emptyFlowText(key)));
    return panel;
  }
  const list = document.createElement('ul');
  for (const item of items) {
    const entry = document.createElement('li');
    entry.textContent = item;
    list.append(entry);
  }
  panel.append(list);
  return panel;
}

function emptyFlowText(key) {
  return (
    {
      sources: 'No input fields recorded',
      resources: 'No shared fields recorded',
      transforms: 'No transform evidence',
      sinks: 'No sink evidence',
    }[key] ?? 'No evidence recorded'
  );
}

/**
 * SVG data-flow diagram: fields left, methods right, arrows for recorded
 * reads (blue) and writes (amber). Hover traces one member's wiring, click
 * isolates it; everything else dims. Renders nothing when there is no wiring
 * to draw, so the panels below stay the source of truth.
 */
function buildFlowDiagram(memberMap) {
  const graph = flowGraph(memberMap);
  if (graph.edges.length === 0) {
    if (graph.nodes.length === 0) {
      return null;
    }
    return unavailableNote('Members recorded, but no read/write wiring between them.');
  }
  const layout = layoutFlowGraph(graph);
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));

  const svg = svgElement('svg', {
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    class: 'flow-diagram',
    role: 'img',
    'aria-label': `Data flow: ${graph.edges.length} recorded read/write connection(s)`,
  });
  svg.dataset.role = 'flow-diagram';

  const defs = svgElement('defs', {});
  for (const kind of ['read', 'write']) {
    const marker = svgElement('marker', {
      id: `flow-arrow-${kind}`,
      viewBox: '0 0 10 10',
      refX: '8',
      refY: '5',
      markerWidth: '7',
      markerHeight: '7',
      orient: 'auto-start-reverse',
    });
    marker.append(svgElement('path', { d: 'M 0 1 L 9 5 L 0 9 z', class: `flow-arrowhead ${kind}` }));
    defs.append(marker);
  }
  svg.append(defs);

  const edgeLayer = svgElement('g', { class: 'flow-edges' });
  for (const edge of layout.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) {
      continue;
    }
    const x1 = from.x + from.w;
    const y1 = from.y + from.h / 2;
    const x2 = to.x;
    const y2 = to.y + to.h / 2;
    const dx = Math.max(30, (x2 - x1) / 2);
    const path = svgElement('path', {
      d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2 - 2} ${y2}`,
      class: `flow-edge ${edge.kind}`,
      'marker-end': `url(#flow-arrow-${edge.kind})`,
    });
    path.dataset.from = edge.from;
    path.dataset.to = edge.to;
    const title = svgElement('title', {});
    title.textContent = edge.kind === 'read'
      ? `${to.label} reads ${from.label}`
      : `${from.label} writes ${to.label}`;
    path.append(title);
    edgeLayer.append(path);
  }
  svg.append(edgeLayer);

  const nodeLayer = svgElement('g', { class: 'flow-nodes' });
  for (const node of layout.nodes) {
    const group = svgElement('g', {
      class: `flow-node ${node.kind}`,
      transform: `translate(${node.x},${node.y})`,
      tabindex: '0',
      role: 'button',
      'aria-label': `${node.kind} ${node.label}: activate to isolate its wiring`,
    });
    group.dataset.node = node.id;
    group.dataset.member = node.label;
    group.append(svgElement('rect', { width: node.w, height: node.h, rx: '6' }));
    const text = svgElement('text', { x: '10', y: String(node.h / 2 + 4) });
    text.textContent = truncateLabel(node.label, 20);
    group.append(text);
    const title = svgElement('title', {});
    title.textContent = `${node.kind}: ${node.label}`;
    group.append(title);
    nodeLayer.append(group);
  }
  svg.append(nodeLayer);

  const connected = (id) => {
    const ids = new Set([id]);
    for (const edge of layout.edges) {
      if (edge.from === id) {
        ids.add(edge.to);
      }
      if (edge.to === id) {
        ids.add(edge.from);
      }
    }
    return ids;
  };
  const paint = (id) => {
    const ids = id ? connected(id) : null;
    for (const group of nodeLayer.childNodes) {
      const hit = !ids || ids.has(group.dataset.node);
      group.classList.toggle('dim', !hit);
      group.classList.toggle('hit', Boolean(ids) && group.dataset.node === id);
    }
    for (const path of edgeLayer.childNodes) {
      const hit = !ids || path.dataset.from === id || path.dataset.to === id;
      path.classList.toggle('dim', !hit);
    }
  };

  let isolated = null;
  const clearIsolation = () => {
    isolated = null;
    svg.classList.remove('isolated', 'tracing');
    paint(null);
  };
  for (const group of nodeLayer.childNodes) {
    const id = group.dataset.node;
    group.addEventListener('mouseenter', () => {
      if (!isolated) {
        svg.classList.add('tracing');
        paint(id);
      }
    });
    group.addEventListener('mouseleave', () => {
      if (!isolated) {
        svg.classList.remove('tracing');
        paint(null);
      }
    });
    group.addEventListener('focus', () => {
      if (!isolated) {
        svg.classList.add('tracing');
        paint(id);
      }
    });
    group.addEventListener('blur', () => {
      if (!isolated) {
        svg.classList.remove('tracing');
        paint(null);
      }
    });
    const toggle = () => {
      if (isolated === id) {
        clearIsolation();
        return;
      }
      isolated = id;
      svg.classList.add('isolated');
      svg.classList.remove('tracing');
      paint(id);
    };
    group.addEventListener('click', (event) => {
      event.stopPropagation();
      toggle();
    });
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      } else if (event.key === 'Escape') {
        clearIsolation();
      }
    });
  }
  svg.addEventListener('click', clearIsolation);

  const wrap = document.createElement('div');
  wrap.className = 'flow-diagram-wrap';
  wrap.append(svg);
  const hint = document.createElement('p');
  hint.className = 'caveat';
  hint.textContent = 'Reads flow left → right in blue, writes right → left in amber. Hover traces, click isolates.';
  wrap.append(hint);
  return wrap;
}

function truncateLabel(label, max) {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

function buildDataFlow(memberMap, consumerIds) {
  const section = document.createElement('section');
  section.className = 'member-dataflow';
  section.dataset.role = 'data-flow';

  const title = document.createElement('h4');
  title.textContent = 'Data flow';
  section.append(title);

  const flow = memberMap?.dataFlow;
  if (!flow || flow.available === false) {
    const note = unavailableNote(`Wiring not recorded: ${flow?.detail ?? 'not recorded by the scan.'}`);
    note.dataset.role = 'flow-unavailable';
    section.append(note);
    return section;
  }

  const diagram = buildFlowDiagram(memberMap);
  if (diagram) {
    section.append(diagram);
  }

  const row = document.createElement('div');
  row.className = 'flow-row';
  row.append(flowPanel('SOURCE / INPUTS', 'sources', flow.sources));
  row.append(flowPanel('RESOURCES / HUBS', 'resources', flow.resources));

  const divider = document.createElement('div');
  divider.className = 'flow-divider';
  const dividerLabel = document.createElement('span');
  dividerLabel.className = 'flow-divider-label';
  dividerLabel.textContent = 'DATA FLOW';
  const dividerAxis = document.createElement('span');
  dividerAxis.className = 'flow-divider-axis';
  dividerAxis.textContent = 'read / write';
  const dividerMarker = document.createElement('span');
  dividerMarker.className = 'flow-marker';
  dividerMarker.setAttribute('aria-hidden', 'true');
  divider.append(dividerLabel, dividerAxis, dividerMarker);
  row.append(divider);

  const right = document.createElement('div');
  right.className = 'flow-right';
  right.append(flowPanel('TRANSFORMS', 'transforms', flow.transforms));
  right.append(flowPanel('SINKS / OUTPUTS', 'sinks', flow.sinks));

  const external = document.createElement('div');
  external.className = 'flow-panel';
  external.dataset.flow = 'external';
  const externalHeader = document.createElement('header');
  externalHeader.textContent = 'EXTERNAL CONSUMPTION';
  const externalCount = document.createElement('span');
  externalCount.className = 'flow-count';
  externalCount.textContent = consumerIds ? String(consumerIds.length) : '—';
  externalHeader.append(externalCount);
  external.append(externalHeader);
  if (!consumerIds) {
    external.append(unavailableNote('Unavailable: repository consumers were not recorded.'));
  } else if (consumerIds.length === 0) {
    external.append(unavailableNote('No repository consumers recorded'));
  } else {
    const list = document.createElement('ul');
    for (const id of consumerIds.slice(0, 30)) {
      const entry = document.createElement('li');
      entry.textContent = id;
      list.append(entry);
    }
    external.append(list);
  }
  right.append(external);
  row.append(right);

  section.append(row);

  const caveat = document.createElement('p');
  caveat.className = 'caveat';
  caveat.textContent = flow.caveat ?? '';
  section.append(caveat);

  return section;
}

function buildHealth(report, metrics) {
  const section = document.createElement('section');
  section.className = 'member-health';
  section.dataset.role = 'health';

  const title = document.createElement('h4');
  title.textContent = 'Architecture health';
  if (report?.score !== undefined && report?.score !== null) {
    const score = document.createElement('span');
    score.className = 'health-score';
    score.textContent = `${report.score}/100`;
    title.append(score);
  }
  section.append(title);

  if (metrics) {
    const line = document.createElement('p');
    line.className = 'health-metrics';
    line.dataset.role = 'health-metrics';
    line.textContent = `${metrics.directImporters} importer(s) · ${metrics.blastRadius} blast radius · ${metrics.directImports} direct import(s)`;
    section.append(line);
  }

  if (!report || !Array.isArray(report.axes) || report.axes.length === 0) {
    section.append(unavailableNote('Health was not computed for this repository.'));
    return section;
  }

  const svg = svgElement('svg', { viewBox: '0 0 144 144', class: 'radar' });
  const frame = svgElement('polygon', {
    points: polygonPoints(radarFrame(report.axes)),
    class: 'radar-frame',
  });
  svg.append(frame);
  const area = svgElement('polygon', {
    points: polygonPoints(radarPoints(report.axes)),
    class: 'radar-area',
  });
  svg.append(area);
  for (const point of radarPoints(report.axes)) {
    svg.append(svgElement('circle', { cx: point.x, cy: point.y, r: '2.5', class: 'radar-dot' }));
  }
  section.append(svg);

  const list = document.createElement('ul');
  list.className = 'health-axes';
  for (const axis of report.axes) {
    const item = document.createElement('li');
    item.textContent =
      axis.value === null
        ? `${axis.label} unavailable`
        : `${axis.label} ${axis.value}%`;
    list.append(item);
  }
  section.append(list);
  return section;
}

function buildConstellation(memberMap, consumerIds) {
  const section = document.createElement('section');
  section.className = 'member-constellation';
  section.dataset.role = 'constellation';

  const title = document.createElement('h4');
  title.textContent = 'Dependency constellation';
  section.append(title);

  const placed = constellationLayout(
    constellationPoints(memberMap, consumerIds ? consumerIds.length : 0),
  );
  const svg = svgElement('svg', { viewBox: '0 0 280 180', class: 'constellation' });
  for (const point of placed) {
    svg.append(
      svgElement('circle', {
        cx: point.x.toFixed(1),
        cy: point.y.toFixed(1),
        r: point.kind === 'consumer' ? '4' : '5',
        class: `constellation-dot ${point.kind}`,
      }),
    );
  }
  section.append(svg);

  const caption = document.createElement('p');
  caption.className = 'caveat';
  caption.textContent = 'Fields, methods, and repository consumers are shown when current scan data provides them.';
  section.append(caption);
  return section;
}

/* --------------------------------------------------------------- File viewer */

/** The most rendered lines before the viewer says it is truncating. */
const SOURCE_LINE_CAP = 2000;

/**
 * The in-page file viewer: a file's lines, or a change's hunks, each with its numbers.
 *
 * `view` is the controller's own state — `{ file, ref, mode, loading, error, content, diff,
 * status, line, hasDiff }`. It renders exactly what the server returned; a missing side is
 * named rather than shown as an empty file, so an empty view is never mistaken for "no lines".
 */
export function renderSource(container, view, handlers = {}) {
  container.replaceChildren();
  const data = view ?? {};

  const head = document.createElement('div');
  head.className = 'source-head';

  const path = document.createElement('span');
  path.className = 'source-path';
  path.textContent = data.file ?? 'No file selected';
  head.append(path);

  if (data.ref) {
    const ref = document.createElement('span');
    ref.className = 'source-ref';
    ref.textContent = `at ${data.ref}`;
    head.append(ref);
  }
  if (data.status) {
    const status = document.createElement('span');
    status.className = 'review-status';
    status.textContent = data.status;
    head.append(status);
  }
  if (data.mode === 'diff' && data.diff && !data.loading) {
    const counts = document.createElement('span');
    counts.className = 'source-counts';
    counts.textContent = `+${data.diff.added} −${data.diff.removed}`;
    head.append(counts);
  }

  if (data.hasDiff) {
    const modes = document.createElement('span');
    modes.className = 'source-modes';
    if (handlers.onShowFile) modes.append(sourceModeButton('File', 'content', handlers.onShowFile));
    if (handlers.onShowDiff) modes.append(sourceModeButton('Changes', 'diff', handlers.onShowDiff));
    if (modes.childElementCount > 0) head.append(modes);
  }

  if (handlers.onClose) {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'panel-dismiss';
    close.setAttribute('aria-label', 'Close source');
    close.textContent = '×';
    close.addEventListener('click', () => handlers.onClose());
    head.append(close);
  }
  container.append(head);

  if (data.loading) {
    container.append(sourceNote('Loading…', 'source-loading', 'source-loading'));
    return;
  }
  if (data.error) {
    container.append(sourceNote(`Unavailable: ${data.error}`, 'source-note', 'source-unavailable'));
    return;
  }

  const body = document.createElement('div');
  body.className = 'source-body';
  if (data.mode === 'diff') {
    renderDiffBody(body, data);
  } else {
    renderContentBody(body, data);
  }
  container.append(body);
}

function sourceModeButton(label, mode, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'source-mode';
  button.dataset.mode = mode;
  button.textContent = label;
  button.addEventListener('click', () => handler());
  return button;
}

function sourceNote(text, className, role) {
  const note = document.createElement('p');
  note.className = className;
  if (role) note.dataset.role = role;
  note.textContent = text;
  return note;
}

/**
 * One numbered line. `gutters` is `[old, new]` for a diff and `[line]` for a file; `tokens`
 * is the line's highlight tokens, or absent to show it plain.
 */
function sourceLine(kind, gutters, text, mark, tokens) {
  const row = document.createElement('div');
  row.className = `src-line src-${kind}`;
  if (mark) row.classList.add('src-mark');
  for (const gutter of gutters) {
    const number = document.createElement('span');
    number.className = 'src-no';
    number.textContent = gutter === null || gutter === undefined ? '' : String(gutter);
    row.append(number);
  }
  const code = document.createElement('span');
  code.className = 'src-code';
  code.textContent = text === '' ? '\u00a0' : text;
  row.append(code);
  return row;
}

function renderContentBody(body, data) {
  const content = typeof data.content === 'string' ? data.content : null;
  if (content === null || content === '') {
    body.append(sourceNote('This file is empty.', 'source-note', 'source-empty'));
    return;
  }
  const lines = content.replace(/\n$/, '').split('\n');
  const shown = lines.slice(0, SOURCE_LINE_CAP);
  const tokens = highlightLines(shown, languageForFile(data.file));
  shown.forEach((line, index) => {
    body.append(sourceLine('context', [index + 1], line, data.line === index + 1, tokens?.[index]));
  });
  if (lines.length > shown.length) {
    body.append(sourceNote(`Showing the first ${SOURCE_LINE_CAP} of ${lines.length} lines.`, 'source-note'));
  }
}

function renderDiffBody(body, data) {
  const diff = data.diff;
  if (!diff) {
    body.append(sourceNote('No change to show.', 'source-note'));
    return;
  }
  if (diff.binary) {
    body.append(sourceNote('Binary file — Git reports no textual diff.', 'source-note', 'source-binary'));
    return;
  }
  if (diff.hunks.length === 0) {
    body.append(sourceNote('No change between the two sides.', 'source-note', 'source-empty'));
    return;
  }
  const language = languageForFile(data.file);
  let budget = SOURCE_LINE_CAP;
  let truncated = false;
  for (const hunk of diff.hunks) {
    body.append(sourceNote(hunk.header, 'src-hunk'));
    // Diff lines are not consecutive source, so each is highlighted on its own.
    const tokens = highlightIsolated(
      hunk.lines.map((line) => line.text),
      language,
    );
    for (const [index, line] of hunk.lines.entries()) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      budget -= 1;
      const marked =
        data.line !== null &&
        data.line !== undefined &&
        (line.newLine === data.line || line.oldLine === data.line);
      body.append(sourceLine(line.kind, [line.oldLine, line.newLine], line.text, marked, tokens?.[index]));
    }
    if (truncated) break;
  }
  if (truncated) {
    body.append(sourceNote(`Showing the first ${SOURCE_LINE_CAP} lines of this change.`, 'source-note'));
  }
}

function svgElement(name, attributes) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }
  return element;
}
