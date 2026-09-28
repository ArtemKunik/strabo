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
    ['deps', `Dependencies (${passport.imports.length} file(s))`, depsSection],
    ['dependents', `Dependents (${passport.usedBy.length} file(s))`, dependentsSection],
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

    hopsContainer.append(hopCard);
  }

  view.append(hopsContainer);
  container.prepend(view);
}
