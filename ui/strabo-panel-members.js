/**
 * The member list and the full-screen Member map, including data-flow, health, and constellation views.
 *
 * Split out of strabo-panels.js.
 */

import {
  constellationLayout,
  clusterSeriesClass,
  constellationPoints,
  explainClass,
  fieldCard,
  flowGraph,
  layoutFlowGraph,
  isWiredField,
  isWiredMethod,
  memberClusters,
  memberMapSteps,
  methodCard,
  orderMembers,
  polygonPoints,
  radarFrame,
  radarPoints,
} from './strabo-core.js';

import {
  Fragment,
  h,
  host,
  mount,
} from './view.js';

import { button, matches, svgElement, unavailableNote, wiring } from './strabo-panel-kit.js';

import { appendNarratorBlock } from './strabo-panel-narrative.js';


/** `extends Base, Mixin · implements Drawable` for a type's recorded supertypes. */
function describeSuperTypes(superTypes) {
  const extendsNames = superTypes.filter((entry) => entry.relation === 'extends').map((entry) => entry.name);
  const implementsNames = superTypes
    .filter((entry) => entry.relation === 'implements')
    .map((entry) => entry.name);
  const parts = [];
  if (extendsNames.length > 0) parts.push(`extends ${extendsNames.join(', ')}`);
  if (implementsNames.length > 0) parts.push(`implements ${implementsNames.join(', ')}`);
  return parts.join(' · ');
}

/** The supertype line for a type, or null when it records none. */
function buildSuperTypeLine(type) {
  const superTypes = type.superTypes ?? [];
  if (superTypes.length === 0) {
    return null;
  }
  const line = document.createElement('p');
  line.className = 'member-supertypes';
  line.textContent = describeSuperTypes(superTypes);
  return line;
}


/**
 * The visibility a language gives a member that names none. Showing it on every row is noise,
 * so only a visibility that differs from it is drawn; the tooltip still names it.
 */
const DEFAULT_VISIBILITY = {
  kotlin: 'public',
  typescript: 'public',
  javascript: 'public',
  python: 'public',
  java: 'package',
  csharp: 'private',
  rust: 'private',
};

/** Above this many types the blocks start collapsed, so the outline reads first. */
const COLLAPSE_ABOVE_TYPES = 3;

/** Above this many members the tab offers a find box. */
const FIND_ABOVE_MEMBERS = 12;

const TYPE_REF_BASIS = {
  'this-file': 'declared in this file',
  import: 'imported',
  'same-folder': 'same folder',
};


/**
 * Render the passport's Members tab: one collapsible block per type, its fields and methods
 * as aligned, token-coloured signatures, then the data-flow panels.
 *
 * Wiring is shown only where the scan recorded field references in this file. When none were
 * recorded a single note says so instead of a "reads 0 · writes 0" on every row, which would
 * read as "unused". A type name the scan tied to its declaring file is a link to it.
 */
export function renderMembers(container, result, handlers = {}) {
  container.replaceChildren();
  const symbols = result?.symbols ?? [];
  const memberMap = result?.memberMap;
  const reExports = memberMap?.reExports ?? [];
  const types = memberMap?.types ?? [];
  const memberCount = types.reduce((sum, type) => sum + type.fields.length + type.methods.length, 0)
    || symbols.filter((symbol) => symbol.kind !== 'type').length;

  const header = document.createElement('div');
  header.className = 'members-header';
  const title = document.createElement('h3');
  const parts = [`Members (${memberCount})`];
  if (types.length > 0) parts.push(`${types.length} type(s)`);
  if (reExports.length > 0) parts.push(`${reExports.length} re-export(s)`);
  title.textContent = parts.join(' · ');
  header.append(title);
  container.append(header);

  if (!result || result.available === false) {
    container.append(unavailableNote(result?.detail ?? 'Not recorded by the scan.'));
    return;
  }

  if (memberCount === 0 && reExports.length === 0) {
    container.append(unavailableNote('No members declared.'));
    return;
  }

  const wired = memberMap?.dataFlow?.available === true;
  if (types.length > 0 && !wired) {
    const note = unavailableNote(
      'Read/write counts are hidden: no method in this file references a field. Use from other files is not tracked.',
    );
    note.dataset.role = 'wiring-note';
    container.append(note);
  }

  const context = {
    wired,
    defaultVisibility: DEFAULT_VISIBILITY[result.language] ?? null,
    typeRefs: result.typeRefs ?? {},
    file: result.file ?? memberMap?.file ?? '',
    container,
    handlers,
  };

  if (types.length > 0) {
    const open = types.length <= COLLAPSE_ABOVE_TYPES;
    types.forEach((type, index) => {
      container.append(renderMemberType(type, context, open || index === 0));
    });
    if (memberCount > FIND_ABOVE_MEMBERS) {
      header.append(memberFind(container));
    }
  } else if (symbols.length > 0) {
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

  // A barrel declares no members, so its re-exports are the whole surface.
  if (reExports.length > 0) {
    container.append(buildReExportSection(reExports));
  }

  container.append(renderDataFlow(memberMap?.dataFlow));
}


/** A find box that hides member rows (and whole types) whose name does not match. */
function memberFind(container) {
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'members-find';
  input.placeholder = 'Find member';
  input.setAttribute('aria-label', 'Find member');
  input.addEventListener('input', () => {
    const query = input.value.trim().toLowerCase();
    for (const block of container.querySelectorAll('details.member-type')) {
      let hits = 0;
      for (const row of block.querySelectorAll('.member-row')) {
        const hit = !query || row.dataset.member.toLowerCase().includes(query);
        row.hidden = !hit;
        if (hit) hits += 1;
      }
      block.hidden = Boolean(query) && hits === 0;
      if (query && hits > 0) block.open = true;
    }
  });
  return input;
}


function renderMemberType(type, context, open) {
  const section = document.createElement('details');
  section.className = 'member-type';
  section.dataset.type = type.name;
  section.open = open;

  const summary = document.createElement('summary');
  const name = document.createElement('span');
  name.className = 'member-type-name';
  name.textContent = type.name;
  summary.append(name);
  if (type.declaration) {
    const chip = document.createElement('span');
    chip.className = `decl-chip decl-${type.declaration.split(' ').at(-1).replace(/\W/g, '')}`;
    chip.textContent = type.declaration;
    summary.append(chip);
  }
  const visibility = visibilityBadge(type.visibility, context.defaultVisibility);
  if (visibility) summary.append(visibility);
  const count = document.createElement('span');
  count.className = 'member-count';
  const countParts = [];
  if (type.fields.length > 0) countParts.push(`${type.fields.length} field(s)`);
  if (type.methods.length > 0) countParts.push(`${type.methods.length} method(s)`);
  count.textContent = countParts.join(' · ') || 'no members';
  summary.append(count);
  if (Number.isFinite(type.line)) {
    summary.title = `${type.name}, line ${type.line}`;
  }
  section.append(summary);

  const superTypes = type.superTypes ?? [];
  if (superTypes.length > 0) {
    const line = document.createElement('p');
    line.className = 'member-supertypes';
    for (const relation of ['extends', 'implements']) {
      const names = superTypes.filter((entry) => entry.relation === relation);
      if (names.length === 0) continue;
      line.append(tokenSpan('tok-kw', `${relation} `));
      names.forEach((entry, index) => {
        if (index > 0) line.append(', ');
        line.append(typeToken(entry.name, context));
      });
      line.append(' ');
    }
    section.append(line);
  }

  if (type.fields.length > 0) {
    section.append(memberHeading(`Fields (${type.fields.length})`));
    const list = document.createElement('ul');
    list.className = 'member-fields member-grid';
    for (const field of type.fields) {
      list.append(fieldRow(field, context));
    }
    section.append(list);
  }

  if (type.methods.length > 0) {
    section.append(memberHeading(`Methods (${type.methods.length})`));
    const list = document.createElement('ul');
    list.className = 'member-methods member-grid';
    for (const method of type.methods) {
      list.append(methodRow(method, context));
    }
    section.append(list);
  }

  if (type.fields.length === 0 && type.methods.length === 0) {
    section.append(unavailableNote('No members declared.'));
  }

  return section;
}


function memberHeading(text) {
  const heading = document.createElement('h5');
  heading.textContent = text;
  return heading;
}


/** A field as `[visibility] val name : Type   wiring`, one grid row. */
function fieldRow(field, context) {
  const item = memberRow('member-field', field, context);
  const keyword = field.mutable === false ? 'val' : 'var';
  const head = item.querySelector('.member-head');
  head.append(tokenSpan(field.mutable === false ? 'tok-kw' : 'tok-kw tok-mutable', `${keyword} `));
  if (field.mutable !== false) {
    head.lastChild.title = 'Mutable: this field can be reassigned';
  }
  item.append(tokenSpan('tok-name', field.name));
  const type = document.createElement('span');
  type.className = 'member-sig';
  type.append(tokenSpan('tok-punct', ': '));
  type.append(field.type ? typeToken(field.type, context) : tokenSpan('tok-missing', 'unrecorded type'));
  if (field.declaredIn) {
    const from = tokenSpan('member-declared-in', ` from ${field.declaredIn}`);
    type.append(from);
  }
  type.title = `${field.name}${type.textContent}`;
  item.append(type);

  const wiring = document.createElement('span');
  wiring.className = 'member-wiring';
  if (context.wired) {
    if (field.reads === 0 && field.writes === 0) {
      const quiet = tokenSpan('wire-pill wire-none', 'untouched here');
      quiet.title = 'No method in this file reads or writes this field. Other files may.';
      wiring.append(quiet);
    } else {
      if (field.reads > 0) {
        wiring.append(wirePill('read', `R ${field.reads}`, `Read by ${field.reads} method(s) in this file`));
      }
      if (field.writes > 0) {
        wiring.append(wirePill('write', `W ${field.writes}`, `Written by ${field.writes} method(s) in this file`));
      }
    }
  }
  item.append(wiring);
  return item;
}


/** A method as `[visibility] fun name(n) : Return   reads … writes …`, one grid row. */
function methodRow(method, context) {
  const item = memberRow('member-method', method, context);
  item.querySelector('.member-head').append(tokenSpan('tok-kw', 'fun '));
  item.append(tokenSpan('tok-name tok-fn', method.name));
  const signature = document.createElement('span');
  signature.className = 'member-sig';
  const parameters = method.parameters ?? 0;
  const params = tokenSpan('tok-punct', `(${parameters})`);
  params.title = `${parameters} parameter(s)`;
  signature.append(params);
  if (method.type) {
    signature.append(tokenSpan('tok-punct', ': '));
    signature.append(typeToken(method.type, context));
  }
  signature.title = `${method.name}${signature.textContent}`;
  item.append(signature);

  const wiring = document.createElement('span');
  wiring.className = 'member-wiring';
  if (method.reads.length > 0) {
    wiring.append(wirePill('read', `reads ${method.reads.join(', ')}`, 'Fields this method reads'));
  }
  if (method.writes.length > 0) {
    wiring.append(wirePill('write', `writes ${method.writes.join(', ')}`, 'Fields this method writes'));
  }
  item.append(wiring);
  return item;
}


/** The shared row shell: a head cell holding the visibility badge, ready for the keyword. */
function memberRow(className, member, context) {
  const item = document.createElement('li');
  item.className = `${className} member-row`;
  item.dataset.member = member.name;
  if (Number.isFinite(member.line)) {
    item.title = `${member.visibility} · line ${member.line}`;
  }
  const head = document.createElement('span');
  head.className = 'member-head';
  const badge = visibilityBadge(member.visibility, context.defaultVisibility);
  if (badge) head.append(badge);
  item.append(head);
  return item;
}


/** A visibility badge, or null when the member has the language's default visibility. */
function visibilityBadge(visibility, defaultVisibility) {
  if (!visibility || visibility === 'not recorded' || visibility === defaultVisibility) {
    return null;
  }
  // `public` is drawn only where it is not the default (Java, C#, Rust), so it still stands out.
  const badge = tokenSpan(`vis-badge vis-${visibility.replace(/\W/g, '')}`, `${visibility} `);
  badge.title = `Visibility: ${visibility}`;
  return badge;
}


function wirePill(kind, text, title) {
  const pill = tokenSpan(`wire-pill wire-${kind}`, text);
  pill.title = title;
  return pill;
}


/** A type name: a link when the scan tied it to a declaring file, plain text otherwise. */
function typeToken(name, context) {
  const ref = context.typeRefs[name];
  if (!ref) {
    return tokenSpan('tok-type', name);
  }
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'tok-type type-link';
  link.textContent = name;
  link.dataset.typeFile = ref.file;
  link.title = `${ref.file} (${TYPE_REF_BASIS[ref.basis] ?? ref.basis})`;
  link.addEventListener('click', (event) => {
    event.preventDefault();
    if (ref.basis === 'this-file') {
      const block = [...context.container.querySelectorAll('details.member-type')].find(
        (candidate) => candidate.dataset.type.split('.').at(-1) === name,
      );
      if (block) {
        block.hidden = false;
        block.open = true;
        block.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
        block.classList.remove('flash');
        void block.offsetWidth;
        block.classList.add('flash');
      }
      return;
    }
    context.handlers.onOpenType?.(ref.file, name);
  });
  return link;
}


function tokenSpan(className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
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
  const types = memberMap?.types ?? [];
  const reExports = memberMap?.reExports ?? [];
  for (const type of types) {
    main.append(buildTypeSection(type, view, clusters, {}));
  }
  if (types.length === 0 && reExports.length === 0) {
    main.append(unavailableNote(memberMap?.detail ?? 'No members declared for this file.'));
  }
  // A barrel declares no members, so its re-exports are the whole public surface; showing
  // them keeps the file from reading as empty.
  if (reExports.length > 0) {
    main.append(buildReExportSection(reExports));
  }
  if (view.dataFlow !== false) {
    main.append(buildDataFlow(memberMap, data?.consumerIds ?? null));
  }
  return main;
}


/** The names a file forwards from other modules, the public surface of a barrel. */
function buildReExportSection(reExports) {
  const section = document.createElement('section');
  section.className = 'member-type member-reexports';
  section.dataset.role = 're-exports';

  const heading = document.createElement('h3');
  heading.className = 'member-type-name';
  heading.textContent = 'Public surface';
  const count = document.createElement('span');
  count.className = 'member-count';
  count.textContent = `${reExports.length} re-export(s)`;
  heading.append(count);
  section.append(heading);

  const list = document.createElement('ul');
  list.className = 'member-reexports-list';
  for (const entry of reExports) {
    const item = document.createElement('li');
    item.className = 'member-reexport';
    const kind = entry.typeOnly ? 'type ' : '';
    const name = entry.name === '*' ? `*` : `{ ${entry.name} }`;
    item.textContent = `export ${kind}${name} from '${entry.from}'`;
    list.append(item);
  }
  section.append(list);
  return section;
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

  const superTypeLine = buildSuperTypeLine(type);
  if (superTypeLine) {
    section.append(superTypeLine);
  }

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
    const parts = [
      `${metrics.directImporters} importer(s)`,
      `${metrics.blastRadius} blast radius`,
      `${metrics.directImports} direct import(s)`,
    ];
    // A barrel's re-exports are left out of the use-only import count; naming them keeps
    // "0 direct import(s)" from reading as if the file depends on nothing.
    if (metrics.reExports > 0) {
      parts.push(`${metrics.reExports} re-exported module(s)`);
    }
    line.textContent = parts.join(' · ');
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
