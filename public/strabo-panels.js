/**
 * Inspector, diagnostics, legend, breadcrumb, folder, overlay, and tests-strip panels.
 *
 * Exposes file metrics and source evidence so a connection can be explained, and reports
 * unrecorded detail as unavailable rather than implying there is none.
 */

import {
  SHAPES,
  breadcrumb,
  constellationLayout,
  constellationPoints,
  explainClass,
  fieldCard,
  graphSummary,
  isWiredField,
  isWiredMethod,
  memberClusters,
  memberMapSteps,
  methodCard,
  orderMembers,
  passportFor,
  polygonPoints,
  radarFrame,
  radarPoints,
  readingLegend,
  summarizeDiagnostics,
} from './strabo-core.js';

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
  title.textContent = node?.label ?? id;
  container.append(title);

  const path = document.createElement('p');
  path.className = 'passport-path';
  path.textContent = node?.workspacePath ?? id;
  container.append(path);

  if (handlers.onOpenWorkspace) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'primary';
    open.textContent = 'Open in Workspace';
    open.addEventListener('click', () => handlers.onOpenWorkspace(id));
    container.append(open);
  }

  if (handlers.onOpenMemberMap) {
    const memberMap = document.createElement('button');
    memberMap.type = 'button';
    memberMap.className = 'member-open';
    memberMap.id = 'open-member-map';
    memberMap.textContent = 'Member map';
    memberMap.addEventListener('click', () => handlers.onOpenMemberMap(id));
    container.append(memberMap);
  }

  const metrics = document.createElement('dl');
  metrics.className = 'passport-metrics';
  for (const metric of passport.metrics) {
    appendFact(metrics, metric.label, String(metric.value));
  }
  container.append(metrics);

  const members = document.createElement('section');
  members.dataset.role = 'members';
  const membersTitle = document.createElement('h3');
  membersTitle.textContent = 'Members';
  members.append(membersTitle);
  const membersBody = document.createElement('p');
  membersBody.className = 'unavailable';
  membersBody.textContent = 'Loading members…';
  members.append(membersBody);
  container.append(members);

  container.append(listSection('Dependencies', id, passport.imports, handlers));
  container.append(listSection('Dependents', id, passport.usedBy, handlers));

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

export function renderDiagnostics(container, model) {
  const summary = summarizeDiagnostics(model);
  container.replaceChildren();

  const title = document.createElement('h3');
  title.textContent = `Diagnostics · ${summary.diagnostics}`;
  container.append(title);

  const counts = document.createElement('p');
  counts.textContent = `excluded: ${summary.excluded} · ${Object.entries(summary.byKind)
    .map(([kind, count]) => `${kind}: ${count}`)
    .join(', ') || 'none'}`;
  container.append(counts);

  if (summary.samples.length > 0) {
    const list = document.createElement('ul');
    for (const diagnostic of summary.samples) {
      const item = document.createElement('li');
      item.textContent = `${diagnostic.file}:${diagnostic.line} ${diagnostic.message}`;
      list.append(item);
    }
    container.append(list);
  }
  return summary;
}

export function renderLegend(container, model) {
  container.replaceChildren();

  const guide = document.createElement('div');
  guide.className = 'legend-guide';
  for (const text of readingLegend()) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    item.textContent = text;
    guide.append(item);
  }
  container.append(guide);

  const kinds = [...new Set((model.nodes ?? []).map((node) => node.kind))].sort();
  for (const kind of kinds) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    item.textContent = `${kind} (${SHAPES[kind] ?? 'round-rectangle'})`;
    container.append(item);
  }
}

/** Counts by directory and kind; clicking a chip filters the map. */
export function renderTestsStrip(container, counts, onFilter) {
  container.replaceChildren();

  const chip = (label, filter, className = 'strip-chip') => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.dataset.filter = filter;
    button.addEventListener('click', () => onFilter(filter));
    return button;
  };

  container.append(chip(`tests ${counts.tests}`, '.test'));
  container.append(chip(`modules ${counts.modules}`, ''));
  for (const entry of counts.entries.slice(0, 12)) {
    container.append(chip(`${entry.label} ${entry.count}`, entry.filter, 'strip-chip strip-dir'));
  }
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
export function renderOverlayPanel(container, title, overlay) {
  if (!overlay || !overlay.summary) {
    container.hidden = true;
    container.replaceChildren();
    return;
  }
  container.hidden = false;
  container.replaceChildren();

  const heading = document.createElement('h3');
  heading.textContent = `${title} · ${overlay.summary}`;
  heading.className = 'overlay-summary';
  container.append(heading);

  if (overlay.items.length > 0) {
    const list = document.createElement('ul');
    for (const item of overlay.items.slice(0, 50)) {
      const entry = document.createElement('li');
      entry.textContent = item;
      list.append(entry);
    }
    container.append(list);
  }
}

/** Render recorded changes, newest first; selecting one compares it with the working tree. */
export function renderTimeline(container, result, onSelect) {
  container.replaceChildren();

  const title = document.createElement('h3');
  title.textContent = 'Timeline';
  container.append(title);

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

function controlRow(label, control) {
  const wrap = document.createElement('label');
  wrap.className = 'member-control';
  wrap.append(label);
  wrap.append(control);
  return wrap;
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
  container.replaceChildren();

  const header = document.createElement('header');
  header.className = 'member-header';
  const crumb = document.createElement('p');
  crumb.className = 'member-crumb';
  crumb.textContent = `${data?.repository ?? 'repository'} / ${data?.file ?? ''}`;
  header.append(crumb);
  const title = document.createElement('h2');
  title.textContent = 'Member map';
  header.append(title);
  container.append(header);

  container.append(buildMemberToolbar(view, handlers));
  container.append(buildStepLine(steps, stepIndex));
  if (view.explain) {
    const explain = document.createElement('p');
    explain.className = 'member-explain';
    explain.dataset.role = 'explain';
    explain.textContent = explainClass(memberMap);
    container.append(explain);
  }

  const body = document.createElement('div');
  body.className = 'member-body';

  const main = document.createElement('section');
  main.className = 'member-main';
  const clusters = memberClusters(memberMap);
  for (const type of memberMap?.types ?? []) {
    main.append(buildTypeSection(type, view, clusters, handlers));
  }
  if ((memberMap?.types ?? []).length === 0) {
    main.append(unavailableNote(memberMap?.detail ?? 'No members declared for this file.'));
  }
  if (view.dataFlow !== false) {
    main.append(buildDataFlow(memberMap, data?.consumerIds ?? null));
  }
  body.append(main);

  const insights = document.createElement('aside');
  insights.className = 'member-insights';
  insights.append(buildHealth(data?.health, data?.metrics));
  insights.append(buildConstellation(memberMap, data?.consumerIds ?? null));
  body.append(insights);

  container.append(body);
}

function buildMemberToolbar(view, handlers) {
  const toolbar = document.createElement('div');
  toolbar.className = 'member-toolbar';
  toolbar.setAttribute('role', 'toolbar');

  const find = document.createElement('input');
  find.type = 'search';
  find.id = 'member-find';
  find.placeholder = 'Method or field name';
  find.value = view.find ?? '';
  find.addEventListener('input', () => handlers.onFind?.(find.value));
  toolbar.append(controlRow('Find member', find));

  const order = document.createElement('select');
  order.id = 'member-order';
  for (const [value, label] of MEMBER_ORDER_OPTIONS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    order.append(option);
  }
  order.value = view.order ?? 'source';
  order.addEventListener('change', () => handlers.onOrder?.(order.value));
  toolbar.append(controlRow('Order', order));

  const wiring = document.createElement('input');
  wiring.type = 'checkbox';
  wiring.id = 'member-wiring';
  wiring.checked = view.showWiring !== false;
  wiring.addEventListener('change', () => handlers.onWiring?.(wiring.checked));
  toolbar.append(controlRow('Show wiring', wiring));

  const zoom = document.createElement('span');
  zoom.className = 'member-zoom';
  zoom.setAttribute('role', 'group');
  zoom.setAttribute('aria-label', 'Zoom');
  const zoomLabel = document.createElement('span');
  zoomLabel.textContent = 'Zoom';
  zoom.append(zoomLabel);
  for (const [value, label] of ZOOM_LEVELS) {
    const active = (view.zoom ?? 'medium') === value;
    const zoomButton = button(`member-zoom-${value}`, label, () => handlers.onZoom?.(value), active ? 'active' : '');
    zoomButton.dataset.zoom = value;
    zoom.append(zoomButton);
  }
  toolbar.append(zoom);

  toolbar.append(button('member-explain', 'Explain this class', () => handlers.onExplain?.()));
  toolbar.append(button('member-night', 'Night vision', () => handlers.onNight?.()));
  toolbar.append(button('member-compare', 'Compare versions', () => handlers.onCompare?.()));
  toolbar.append(button('member-only-flow', 'Show only this flow', () => handlers.onOnlyFlow?.()));
  toolbar.append(button('member-reset', 'Reset layout', () => handlers.onReset?.()));

  const dataFlow = document.createElement('input');
  dataFlow.type = 'checkbox';
  dataFlow.id = 'member-dataflow';
  dataFlow.checked = view.dataFlow !== false;
  dataFlow.addEventListener('change', () => handlers.onDataFlow?.(dataFlow.checked));
  toolbar.append(controlRow('Data flow', dataFlow));

  const steps = document.createElement('span');
  steps.className = 'member-steps';
  steps.append(button('member-prev', 'Prev', () => handlers.onStep?.(-1)));
  steps.append(button('member-play', 'Play', () => handlers.onPlay?.()));
  steps.append(button('member-next', 'Step', () => handlers.onStep?.(1)));
  toolbar.append(steps);

  toolbar.append(button('member-close', 'Close', () => handlers.onClose?.()));

  return toolbar;
}

function buildStepLine(steps, index) {
  const line = document.createElement('p');
  line.className = 'member-step';
  line.dataset.role = 'member-step';
  const step = steps[index];
  line.textContent = `Step ${index + 1} of ${steps.length} (${step?.label ?? ''}): ${step?.caption ?? ''}`;
  return line;
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

  const fieldHeading = document.createElement('h4');
  fieldHeading.textContent = `Fields / data (${fields.length})`;
  section.append(fieldHeading);
  const fieldList = document.createElement('div');
  fieldList.className = 'member-cards';
  fieldList.dataset.role = 'fields';
  for (const field of fields) {
    fieldList.append(buildFieldCard(field, clusters.clusterOf.get(field.name)));
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
    methodList.append(buildMethodCard(method, clusters.clusterOf.get(method.name)));
  }
  if (methods.length === 0) {
    methodList.append(unavailableNote('No methods recorded.'));
  }
  section.append(methodList);

  return section;
}

function matches(name, needle) {
  return !needle || name.toLowerCase().includes(needle);
}

function buildFieldCard(field, clusterIndex) {
  const card = fieldCard(field);
  const element = document.createElement('article');
  element.className = 'member-card field-card';
  element.dataset.member = field.name;
  element.dataset.cluster = String(clusterIndex ?? 0);
  element.append(cardLine('card-eyebrow', `${card.eyebrow} · CLUSTER ${clusterIndex ?? '—'}`));
  element.append(cardLine('card-signature', card.signature));
  element.append(cardLine('card-tag', card.tag));
  element.append(cardLine('card-metrics', card.metrics));
  return element;
}

function buildMethodCard(method, clusterIndex) {
  const card = methodCard(method);
  const element = document.createElement('article');
  element.className = 'member-card method-card';
  element.dataset.member = method.name;
  element.dataset.cluster = String(clusterIndex ?? 0);
  element.append(cardLine('card-eyebrow', `${card.eyebrow} · CLUSTER ${clusterIndex ?? '—'}`));
  element.append(cardLine('card-signature', card.signature));
  element.append(cardLine('card-tag', card.tag));
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
  divider.append(dividerLabel, dividerAxis);
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
