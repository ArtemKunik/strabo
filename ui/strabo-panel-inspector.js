/**
 * The Module Passport (inspector) and its "Changes with" / outside-links sections.
 *
 * Split out of strabo-panels.js.
 */

import {
  passportFor,
  rovingIndex,
} from './strabo-core.js';

import { backButton, button } from './strabo-panel-kit.js';

import { appendNarratorBlock } from './strabo-panel-narrative.js';

let inspectorSeq = 0;

/** What each passport tab holds, as a hover hint. */
const TAB_HINTS = {
  deps: 'Files this one imports, with the line that names each',
  dependents: 'Files that import this one',
  members: 'Types, fields, and methods this file declares',
  functions: 'Every function with its size, complexity, and recorded calls',
  impact: 'What depends on this file transitively, and the tests that reach it',
  coverage: 'Measured line coverage, or whether a test reaches the file',
};


function baseName(path) {
  return path.slice(path.lastIndexOf('/') + 1) || path;
}


/** Above this many folders the crumb keeps the first and the last few, eliding the middle. */
const CRUMB_KEEP_TAIL = 3;

/**
 * The file's folders as a breadcrumb. A folder the current map draws is a link to it; the
 * rest are plain text. The full path is the hover hint and what Copy path copies.
 */
function passportCrumb(model, path, handlers) {
  const crumb = document.createElement('p');
  crumb.className = 'passport-path';
  crumb.title = path;
  const folders = path.split('/').slice(0, -1);
  if (folders.length === 0) {
    crumb.textContent = path;
    return crumb;
  }
  const drawn = new Set((model.nodes ?? []).map((candidate) => candidate.id));
  const shown = folders.map((name, index) => ({ name, id: folders.slice(0, index + 1).join('/') }));
  const visible = shown.length > CRUMB_KEEP_TAIL + 1
    ? [shown[0], { name: '…', id: null, hint: folders.slice(1, -CRUMB_KEEP_TAIL).join('/') }, ...shown.slice(-CRUMB_KEEP_TAIL)]
    : shown;
  visible.forEach((segment, index) => {
    if (index > 0) {
      const separator = document.createElement('span');
      separator.className = 'crumb-sep';
      separator.textContent = ' › ';
      separator.setAttribute('aria-hidden', 'true');
      crumb.append(separator);
    }
    if (segment.id && drawn.has(segment.id) && handlers.onSelect) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'crumb-link';
      link.textContent = segment.name;
      link.title = segment.id;
      link.addEventListener('click', () => handlers.onSelect(segment.id));
      crumb.append(link);
    } else {
      const text = document.createElement('span');
      text.className = 'crumb-part';
      text.textContent = segment.name;
      if (segment.hint) text.title = segment.hint;
      crumb.append(text);
    }
  });
  return crumb;
}


function factChip(text, className = '', title = '') {
  const chip = document.createElement('span');
  chip.className = `fact-chip ${className}`.trim();
  chip.textContent = text;
  if (title) chip.title = title;
  return chip;
}


/** A coverage figure as `62%` with the basis as its hint, or null when there is none. */
function coverageFact(coverage) {
  if (!coverage || coverage.value === null || coverage.value === undefined) {
    return null;
  }
  const measured = coverage.basis !== 'reachable';
  const text = measured ? `${Math.round(coverage.value)}% covered` : coverage.value > 0 ? 'reached by tests' : 'no test reaches it';
  return {
    text,
    tone: coverage.value >= 70 ? 'good' : coverage.value > 0 ? 'warning' : 'critical',
    title: measured ? `Measured line coverage${coverage.stale ? ' (report older than the file)' : ''}` : coverage.detail ?? 'Static reach from test files',
  };
}


/**
 * Fill the passport's facts strip and tab counts from the file read (`/symbols`) and the
 * impact passport. Each figure comes from that payload; one that is missing stays off the
 * strip, and its tab keeps no count rather than showing 0.
 */
export function renderPassportFacts(container, result, impact) {
  const facts = container.querySelector('[data-role="passport-facts"]');
  if (facts) {
    facts.querySelector('.fact-pending')?.remove();
    if (result?.available === false) {
      facts.append(factChip(result.detail ?? 'File facts unavailable', 'fact-muted'));
    } else if (result) {
      const types = result.memberMap?.types ?? [];
      const members = types.reduce((sum, type) => sum + type.fields.length + type.methods.length, 0);
      if (result.language) facts.append(factChip(result.language, 'fact-language'));
      if (Number.isFinite(result.lines)) facts.append(factChip(`${result.lines} lines`));
      if (types.length > 0) facts.append(factChip(`${types.length} type(s)`));
      if (members > 0) facts.append(factChip(`${members} member(s)`));
      const coverage = coverageFact(result.coverage);
      if (coverage) facts.append(factChip(coverage.text, `fact-${coverage.tone}`, coverage.title));
    }
  }

  const types = result?.memberMap?.types;
  if (types) {
    setTabCount(container, 'members', types.reduce((sum, type) => sum + type.fields.length + type.methods.length, 0));
  }
  if (Array.isArray(result?.functions?.functions)) {
    setTabCount(container, 'functions', result.functions.functions.length);
  }
  const blast = impact?.snapshot?.blastRadius;
  if (Number.isFinite(blast)) {
    setTabCount(container, 'impact', blast, `${blast} file(s) depend on this one transitively`);
  }
  const coverage = coverageFact(result?.coverage);
  if (coverage) {
    const measured = result.coverage.basis !== 'reachable';
    setTabCount(container, 'coverage', measured ? `${Math.round(result.coverage.value)}%` : result.coverage.value > 0 ? '✓' : '✗', coverage.title, coverage.tone);
  }
}


/** Put a count badge on a passport tab; a zero count is drawn dimmed so an empty tab reads as such. */
function setTabCount(container, key, value, title = '', tone = '') {
  const tab = container.querySelector(`.inspector-tab[data-tab="${key}"]`);
  if (!tab) {
    return;
  }
  tab.querySelector('.tab-count')?.remove();
  const badge = document.createElement('span');
  badge.className = `tab-count${value === 0 ? ' is-zero' : ''}${tone ? ` tone-${tone}` : ''}`;
  badge.textContent = String(value);
  if (title) badge.title = title;
  tab.append(badge);
}


/** The Module Passport for the selected node. */
export function renderInspector(container, model, id, handlers = {}) {
  // A file the map does not draw has no graph facts, only what the server reads by path.
  const offMap = !model.system && !(model.nodes ?? []).some((candidate) => candidate.id === id);
  const passport = passportFor(model, id) ?? (offMap ? { kind: 'module', metrics: [], imports: [], usedBy: [] } : null);
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
  // A label that only repeats the path reads twice with the breadcrumb below; the file name
  // is the title, the folders are the crumb.
  const label = node?.label && node.label !== id ? node.label : baseName(id);
  const titleText = document.createElement('span');
  titleText.className = 'passport-title';
  titleText.textContent = label;
  titleText.title = node?.workspacePath ?? id;
  title.append(titleText);
  container.append(title);
  if (handlers.onBack) {
    title.prepend(backButton(handlers, 'Back to the map'));
  }

  container.append(passportCrumb(model, node?.workspacePath ?? id, handlers));

  // A System-view unit says why it is grouped, so the caption is evidence, not decoration.
  if (passport.why) {
    const why = document.createElement('p');
    why.className = 'passport-why';
    why.textContent = `Grouped by: ${passport.why}`;
    container.append(why);
  }

  const actions = document.createElement('div');
  actions.className = 'inspector-actions';
  // A file this view does not draw is read here rather than navigated on the map, so the
  // Member map is its main next step; a drawn file keeps the Workspace as the primary action.
  const memberMapPrimary = offMap && Boolean(handlers.onOpenMemberMap);
  if (handlers.onOpenWorkspace) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = memberMapPrimary ? 'workspace-open' : 'primary';
    open.textContent = 'Open in Workspace';
    open.title = 'Open this file in the Workspace editor and terminal';
    open.addEventListener('click', () => handlers.onOpenWorkspace(id));
    actions.append(open);
  }
  if (handlers.onViewSource) {
    const source = document.createElement('button');
    source.type = 'button';
    source.className = 'source-open';
    source.textContent = 'View source';
    source.title = 'Read the file here without leaving the map';
    source.addEventListener('click', () => handlers.onViewSource(id));
    actions.append(source);
  }
  if (handlers.onOpenMemberMap) {
    const memberMap = document.createElement('button');
    memberMap.type = 'button';
    memberMap.className = memberMapPrimary ? 'member-open primary' : 'member-open';
    memberMap.id = 'open-member-map';
    memberMap.textContent = 'Member map';
    memberMap.title = 'Fields, methods, and their recorded read/write wiring, full screen';
    memberMap.addEventListener('click', () => handlers.onOpenMemberMap(id));
    if (memberMapPrimary) {
      actions.prepend(memberMap);
    } else {
      actions.append(memberMap);
    }
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
    if (metric.unit) {
      const unit = document.createElement('span');
      unit.className = 'stat-unit';
      unit.textContent = metric.unit;
      value.append(unit);
    }
    const label = document.createElement('div');
    label.className = 'stat-label';
    label.textContent = metric.label;
    card.append(value, label);
    cards.append(card);
  }
  container.append(cards);

  // Without graph metrics (a file this view does not draw) the passport would open on an
  // empty band; the facts the file read returns fill it once they arrive.
  if (offMap && passport.metrics.length === 0) {
    const facts = document.createElement('div');
    facts.className = 'passport-facts';
    facts.dataset.role = 'passport-facts';
    facts.append(factChip('Not drawn in this view', 'fact-offmap', 'This view does not draw this file; the passport reads it by path.'));
    facts.append(factChip('Reading file…', 'fact-pending'));
    container.append(facts);
  }

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

  // In Structure view, roll-up nodes (bands, shelves, axes, cells) have no file members or
  // function tabs. They show behavioral spines (Phase 35 Y6) connecting call sites to tables.
  if (model.structure && (node?.kind === 'tier' || node?.kind === 'shelf' || node?.kind === 'axis')) {
    appendStructureSpines(container, model, id, node, handlers);
    appendApiContracts(container, model, id, node);
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

  const coverage = document.createElement('section');
  coverage.dataset.role = 'coverage';
  const coverageTitle = document.createElement('h3');
  coverageTitle.textContent = 'Coverage';
  coverage.append(coverageTitle);
  const coverageBody = document.createElement('p');
  coverageBody.className = 'unavailable';
  coverageBody.textContent = 'Loading coverage…';
  coverage.append(coverageBody);

  const tabDefs = [
    ...(offMap
      ? []
      : [
          ['deps', `Dependencies (${passport.imports.length} file(s))`, depsSection],
          ['dependents', `Dependents (${passport.usedBy.length} file(s))`, dependentsSection],
        ]),
    ['members', 'Members', members],
    ['functions', 'Functions', functions],
    ['impact', 'Impact', impact],
    ['coverage', 'Coverage', coverage],
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
    if (TAB_HINTS[key]) {
      tab.title = TAB_HINTS[key];
    }
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

  // A file that declares an HTTP endpoint shows its request/response contract beside the
  // recorded dependencies, read from the same OpenAPI documents the tier lens classifies.
  appendApiContracts(container, model, id, node);

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
  title.textContent = `${heading} (${entries.length} file(s))`;
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
 * Render the API contract section for a selected file or structure band.
 *
 * A file that declares an OpenAPI operation shows that operation's request and response
 * schema; a band shows the operations its documents declare. Every field keeps the format
 * the parser recorded, and a missing schema says so rather than drawing an empty contract.
 */
function appendApiContracts(container, model, id, node) {
  const endpoints = model.structureEndpoints ?? [];
  if (endpoints.length === 0) {
    return;
  }
  const byFile = endpoints.filter((entry) => entry.file === id);
  const byTier = node?.tier ? endpoints.filter((entry) => entry.tier === node.tier) : [];
  const list = byFile.length > 0 ? byFile : byTier;
  if (list.length === 0) {
    return;
  }

  const section = document.createElement('section');
  section.className = 'api-contracts-section';
  section.dataset.role = 'api-contracts';

  const heading = document.createElement('h3');
  heading.textContent = 'API contract';
  section.append(heading);

  const intro = document.createElement('p');
  intro.className = 'passport-why';
  intro.textContent = 'Request and response shapes declared by the OpenAPI operation, with its source.';
  section.append(intro);

  for (const endpoint of list) {
    section.append(apiContractCard(endpoint));
  }

  container.append(section);
}

/** One declared operation: method, path, its source, and both schema sides. */
function apiContractCard(endpoint) {
  const card = document.createElement('div');
  card.className = 'api-contract';
  card.dataset.role = 'api-contract';

  const header = document.createElement('div');
  header.className = 'api-contract-header';
  const method = document.createElement('span');
  method.className = 'kind-chip kind-api';
  method.textContent = endpoint.method;
  header.append(method);
  const route = document.createElement('strong');
  route.className = 'api-contract-path';
  route.textContent = endpoint.path;
  header.append(route);
  if (endpoint.operationId) {
    const operationId = document.createElement('span');
    operationId.className = 'evidence';
    operationId.textContent = endpoint.operationId;
    header.append(operationId);
  }
  card.append(header);

  const source = document.createElement('span');
  source.className = 'evidence api-contract-source';
  source.textContent = endpoint.file;
  card.append(source);

  card.append(apiSchemaBlock('Request', endpoint.request));
  card.append(apiSchemaBlock('Response', endpoint.response));
  return card;
}

/** One side of an operation's contract: the schema name and its fields. */
function apiSchemaBlock(label, ref) {
  const block = document.createElement('div');
  block.className = `api-contract-schema api-contract-${label.toLowerCase()}`;

  const title = document.createElement('div');
  title.className = 'api-contract-schema-title';
  title.textContent = ref?.schema ? `${label}: ${ref.schema}` : label;
  block.append(title);

  const fields = ref?.fields ?? [];
  if (fields.length === 0) {
    const none = document.createElement('span');
    none.className = 'unavailable';
    none.textContent = ref ? 'No fields recorded' : `No ${label.toLowerCase()} schema declared`;
    block.append(none);
    return block;
  }

  const list = document.createElement('ul');
  list.className = 'api-contract-fields';
  for (const field of fields) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'api-contract-field-name';
    name.textContent = field.name;
    const type = document.createElement('span');
    type.className = 'api-contract-field-type';
    type.textContent = field.type;
    item.append(name, type);
    if (!field.required) {
      const optional = document.createElement('span');
      optional.className = 'api-contract-field-optional';
      optional.textContent = 'optional';
      item.append(optional);
    }
    list.append(item);
  }
  block.append(list);
  return block;
}

/**
 * Render the Behavioral Spines section for a Structure tier, cell, or shelf (Phase 35 Y6).
 *
 * Each recorded outbound call or route traces end-to-end:
 * `call site (frontend) → declared endpoint (api) → handler (domain) → table (data)`
 * Gaps stay as stubs rather than being fabricated.
 */
function appendStructureSpines(container, model, id, node, handlers) {
  const tier = node?.tier ?? id;
  const unit = node?.unit;
  const allSpines = model.structureSpines ?? [];

  const section = document.createElement('section');
  section.className = 'structure-spines-section';
  section.dataset.role = 'tier-spines';

  const heading = document.createElement('h3');
  heading.textContent = 'Behavioral spines';
  section.append(heading);

  const intro = document.createElement('p');
  intro.className = 'passport-why';
  intro.textContent = 'End-to-end behavioral trace: call site → declared endpoint → handler → table.';
  section.append(intro);

  if (handlers.activeSpine) {
    renderSpineView(section, handlers.activeSpine, handlers);
  }

  const originating = allSpines.filter(
    (s) => s.call.tier === tier || (unit && s.call.unit === unit),
  );
  const passing = allSpines.filter(
    (s) => !originating.includes(s) && (s.hops.some((h) => h.tier === tier) || (unit && s.hops.some((h) => h.unit === unit))),
  );
  const displayList = originating.length > 0 ? originating : (passing.length > 0 ? passing : allSpines);

  if (displayList.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'unavailable';
    empty.dataset.role = 'spines-empty';
    empty.textContent = 'No recorded outbound calls or behavioral spines found for this tier.';
    section.append(empty);
    container.append(section);
    return;
  }

  const list = document.createElement('div');
  list.className = 'spine-list';
  list.dataset.role = 'spine-list';

  for (const spine of displayList) {
    const card = document.createElement('div');
    card.className = 'spine-card';
    card.dataset.role = 'spine-card';

    const header = document.createElement('div');
    header.className = 'spine-card-header';

    const callLabel = document.createElement('strong');
    callLabel.textContent = `${spine.call.method ?? 'CALL'} ${spine.call.path ?? spine.call.target}`;
    header.append(callLabel);

    const fileLocation = document.createElement('span');
    fileLocation.className = 'evidence';
    fileLocation.textContent = `${spine.call.file}:${spine.call.line}`;
    header.append(fileLocation);

    card.append(header);

    const buttonRow = document.createElement('div');
    buttonRow.className = 'spine-actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'primary';
    openBtn.dataset.role = 'open-spine';
    openBtn.dataset.spineId = spine.id;
    openBtn.textContent = handlers.activeSpine?.id === spine.id ? 'Spine active' : 'View spine';
    openBtn.addEventListener('click', () => {
      renderSpineView(section, spine, handlers);
      handlers.onOpenSpine?.(spine);
    });
    buttonRow.append(openBtn);
    card.append(buttonRow);

    list.append(card);
  }

  section.append(list);
  container.append(section);
}

/**
 * Render the 4-hop end-to-end spine view (Phase 35 Y6):
 * call (frontend) → endpoint (api) → handler (domain) → table (data).
 */
function renderSpineView(container, spine, handlers = {}) {
  const existing = container.querySelector('[data-role="spine-view"]');
  if (existing) {
    existing.remove();
  }

  const view = document.createElement('div');
  view.className = 'spine-view';
  view.dataset.role = 'spine-view';

  const header = document.createElement('div');
  header.className = 'spine-view-header';
  const title = document.createElement('h4');
  title.textContent = 'End-to-End Spine';
  header.append(title);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'icon-button';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close spine view';
  closeBtn.addEventListener('click', () => {
    view.remove();
    handlers.onCloseSpine?.();
  });
  header.append(closeBtn);
  view.append(header);

  const hopsContainer = document.createElement('div');
  hopsContainer.className = 'spine-hops';

  const hopRoles = ['call', 'endpoint', 'handler', 'table'];

  for (const role of hopRoles) {
    const hop = (spine.hops ?? []).find((h) => h.role === role);
    const hopCard = document.createElement('div');
    hopCard.className = `spine-hop spine-hop-${role}`;
    hopCard.dataset.role = `spine-${role}`;

    const roleBadge = document.createElement('span');
    roleBadge.className = 'spine-role-badge';
    roleBadge.textContent = role.toUpperCase();
    hopCard.append(roleBadge);

    if (hop) {
      const tierBadge = document.createElement('span');
      tierBadge.className = `kind-chip kind-${hop.tier}`;
      tierBadge.textContent = hop.tier;
      hopCard.append(tierBadge);

      const label = document.createElement('strong');
      label.className = 'spine-hop-label';
      label.textContent = hop.label;
      hopCard.append(label);

      const detail = document.createElement('span');
      detail.className = 'spine-hop-detail';
      detail.textContent = hop.detail;
      hopCard.append(detail);
    } else {
      const stub = document.createElement('span');
      stub.className = 'spine-stub';
      stub.dataset.role = 'spine-stub';
      stub.textContent = `(no matching ${role} detected)`;
      hopCard.append(stub);
    }

    // The endpoint hop names the request/response contract it declares, and the table hop
    // lists the downstream tables recorded on the handler's path instead of one table.
    if (role === 'endpoint' && spine.endpoint) {
      const contract = document.createElement('span');
      contract.className = 'spine-hop-contract';
      contract.dataset.role = 'spine-contract';
      contract.textContent = spineContractSummary(spine.endpoint);
      hopCard.append(contract);
    }
    if (role === 'table') {
      const lineage = spine.lineage ?? [];
      if (lineage.length > 0) {
        hopCard.append(spineLineageList(lineage));
      }
    }

    hopsContainer.append(hopCard);
  }

  view.append(hopsContainer);
  container.prepend(view);
}

/** `in <Schema> (N) · out <Schema> (M)`, naming what each side declares. */
function spineContractSummary(endpoint) {
  const side = (label, ref) =>
    `${label} ${ref ? `${ref.schema ?? 'inline'} (${ref.fields.length})` : '—'}`;
  return `contract: ${side('in', endpoint.request)} · ${side('out', endpoint.response)}`;
}

/** The recorded tables downstream of the handler, matched table first. */
function spineLineageList(lineage) {
  const list = document.createElement('ul');
  list.className = 'spine-lineage';
  list.dataset.role = 'spine-lineage';
  for (const entry of lineage) {
    const item = document.createElement('li');
    item.className = entry.matched ? 'spine-lineage-item matched' : 'spine-lineage-item';
    const table = document.createElement('span');
    table.className = 'spine-lineage-table';
    table.textContent = entry.table;
    const evidence = document.createElement('span');
    evidence.className = 'evidence';
    evidence.textContent = `${entry.file}:${entry.line}`;
    item.append(table, evidence);
    list.append(item);
  }
  return list;
}
