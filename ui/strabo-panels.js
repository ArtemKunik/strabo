/**
 * Inspector, diagnostics, legend, breadcrumb, folder, overlay, and tests-strip panels.
 *
 * Exposes file metrics and source evidence so a connection can be explained, and reports
 * unrecorded detail as unavailable rather than implying there is none.
 */

import {
  SHAPES,
  breadcrumb,
  cohesionDelta,
  constellationLayout,
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
  orderAdvisories,
  orderMembers,
  paletteKey,
  passportFor,
  polygonPoints,
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
  functionLabel,
  functionMetrics,
  functionSignature,
  functionSignals,
} from './strabo-functions.js';
import { Fragment, h, host, mount } from './view.js';

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

  const path = document.createElement('p');
  path.className = 'passport-path';
  path.textContent = node?.workspacePath ?? id;
  container.append(path);

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
  if (handlers.onOpenMemberMap) {
    const memberMap = document.createElement('button');
    memberMap.type = 'button';
    memberMap.className = 'member-open';
    memberMap.id = 'open-member-map';
    memberMap.textContent = 'Member map';
    memberMap.addEventListener('click', () => handlers.onOpenMemberMap(id));
    actions.append(memberMap);
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

  const tabDefs = [
    ['deps', `Dependencies (${passport.imports.length})`, depsSection],
    ['dependents', `Dependents (${passport.usedBy.length})`, dependentsSection],
    ['members', 'Members', members],
    ['functions', 'Functions', functions],
  ];
  const tabButtons = [];
  for (const [key, label, section] of tabDefs) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'inspector-tab';
    tab.setAttribute('role', 'tab');
    tab.dataset.tab = key;
    tab.textContent = label;
    tab.setAttribute('aria-selected', key === 'deps' ? 'true' : 'false');
    tab.addEventListener('click', () => {
      for (const other of tabButtons) other.setAttribute('aria-selected', other === tab ? 'true' : 'false');
      for (const child of panels.children) child.hidden = true;
      section.hidden = false;
    });
    tabs.append(tab);
    tabButtons.push(tab);
    section.hidden = key !== 'deps';
    panels.append(section);
  }
  container.append(tabs, panels);

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
 * Render the Member map: members grouped by type, then the data-flow panels.
 *
 * Wiring is shown only where the scan recorded field references in this file; when none
 * were recorded the panels say so instead of showing empty lists.
 */
export function renderMembers(container, result) {
  container.replaceChildren();
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
export function renderFunctions(container, result) {
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

  const list = document.createElement('ul');
  list.className = 'function-list';
  for (const entry of report.functions) {
    const item = document.createElement('li');
    item.className = 'function-entry';

    const name = document.createElement('div');
    name.className = 'function-name';
    name.textContent = functionLabel(entry);
    item.append(name);

    const signature = document.createElement('code');
    signature.className = 'function-signature';
    signature.textContent = functionSignature(entry);
    item.append(signature);

    const metrics = document.createElement('div');
    metrics.className = 'function-metrics';
    metrics.textContent = functionMetrics(entry);
    item.append(metrics);

    const calls = document.createElement('div');
    calls.className = 'function-calls';
    calls.textContent = `calls: ${functionCalls(entry)}`;
    item.append(calls);

    const callers = document.createElement('div');
    callers.className = 'function-callers';
    callers.textContent = `called by: ${functionCallers(entry)}`;
    item.append(callers);

    const signals = document.createElement('div');
    signals.className = 'function-signals';
    signals.textContent = `signals: ${functionSignals(entry)}`;
    item.append(signals);

    list.append(item);
  }
  container.append(list);
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
  'size = dependents': 'linear-gradient(135deg,#4c9aff,#c98bf0)',
  'colour = directory': 'linear-gradient(135deg,#56d4b1,#f2b25c)',
  'diamond = test': 'linear-gradient(135deg,#f2b25c,#ff8f8f)',
  'hover = blast radius': 'linear-gradient(135deg,#8da0b5,#4c9aff)',
};

export function renderLegend(container, model) {
  container.replaceChildren();

  const guide = document.createElement('div');
  guide.className = 'legend-guide';
  for (const text of readingLegend()) {
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

  // The actual directory → colour key, so the legend shows the colours the view draws
  // rather than a gradient that stands for "some colour".
  const directories = paletteKey(model);
  if (directories.length > 0) {
    const key = document.createElement('div');
    key.className = 'legend-dirs';
    for (const entry of directories) {
      const item = document.createElement('span');
      item.className = 'legend-dir';
      const swatch = document.createElement('span');
      swatch.className = 'legend-dot';
      swatch.style.background = entry.color;
      item.append(swatch);
      item.append(document.createTextNode(entry.regions.join(' · ')));
      key.append(item);
    }
    container.append(key);
  }

  const kinds = [...new Set((model.nodes ?? []).map((node) => node.kind))].sort();
  for (const kind of kinds) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const glyph = document.createElement('span');
    glyph.className = 'legend-shape';
    glyph.textContent = kind === 'test' ? '◆' : kind === 'service' ? '⬡' : '▣';
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
    const list = document.createElement('ul');
    const moreWrap = document.createElement('div');
    moreWrap.className = 'overlay-more-wrap';
    const moreButton = document.createElement('button');
    moreButton.type = 'button';
    moreButton.className = 'overlay-more';
    const PAGE = 50;
    let shown = PAGE;

    const matchingItems = () => (
      filter
        ? overlay.items.filter((item) => String(item).toLowerCase().includes(filter))
        : overlay.items
    );

    const renderList = () => {
      list.replaceChildren();
      const matching = matchingItems();
      for (const item of matching.slice(0, shown)) {
        const entry = document.createElement('li');
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
        list.append(entry);
      }
      const remaining = matching.length - Math.min(shown, matching.length);
      if (remaining > 0) {
        moreButton.hidden = false;
        moreButton.textContent = `Show ${Math.min(PAGE, remaining)} more (${remaining} remaining)`;
      } else {
        moreButton.hidden = true;
      }
      if (filter && matching.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'overlay-empty';
        empty.textContent = 'No modules match this filter.';
        list.append(empty);
      }
    };

    if (needsSearch) {
      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'overlay-filter';
      search.placeholder = 'Filter modules…';
      search.setAttribute('aria-label', 'Filter overlay modules');
      search.addEventListener('input', () => {
        filter = search.value.trim().toLowerCase();
        shown = PAGE;
        renderList();
      });
      container.append(search);
    }
    moreButton.addEventListener('click', () => {
      shown += PAGE;
      renderList();
    });
    container.append(list);
    container.append(moreWrap);
    moreWrap.append(moreButton);
    renderList();
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
    list.append(item);
  }
  container.append(list);
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
  title.textContent = result?.kind === 'commit' ? 'Commit review' : 'Working tree review';
  container.append(title);
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

  if ((result.files ?? []).length === 0) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent =
      result.kind === 'commit' ? 'This commit recorded no file changes.' : 'No pending changes.';
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
      list.append(item);
    }
    container.append(list);
  }

  renderChangePassport(container, result.cohesion);

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

const REVIEW_GROUP_LABELS = {
  commit: 'Changed',
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
        h('p', { className: 'member-crumb' }, `${data?.repository ?? 'repository'} / ${data?.file ?? ''}`),
        h('h2', null, 'Member map'),
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
    chip.className = `cluster cluster-${(cluster.index % 7) + 1}`;
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

function svgElement(name, attributes) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }
  return element;
}
