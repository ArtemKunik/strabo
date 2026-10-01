/**
 * Small persistent panels: diagnostics, legend, shortcuts, tests strip, breadcrumb, and folder list.
 *
 * Split out of strabo-panels.js.
 */

import {
  SHAPES,
  breadcrumb,
  readingLegend,
  shortcutSheet,
  summarizeDiagnostics,
} from './strabo-core.js';

import {
  Fragment,
  h,
  mount,
} from './view.js';

import { button, svgElement } from './strabo-panel-kit.js';

import { TIER_LABELS, TIER_ORDER, tierColorVar } from './strabo-tiers.js';


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


/** A line in the legend is an edge cue when its symbol names a line style, not a shape. */
const LEGEND_LINE_SYMBOLS = new Set([
  'edge',
  'solid',
  'solid edge',
  'dashed',
  'dashed red',
  'dotted',
  'arc',
  'faded',
  'wrong-way',
  'cross-unit',
]);

/** What each cue means beyond its short label, shown on hover. */
const LEGEND_HINTS = {
  'size = dependents': 'Bigger nodes have more files depending on them, directly or transitively.',
  'size = lines of code': 'Bigger nodes are longer files (the large-file lens is on).',
  'size = files': 'Bigger means more files inside.',
  'island = directory': 'Files sit on one shaded island per folder.',
  'diamond = test': 'A file the scan identified as a test.',
  'star = entry': 'An entry point a manifest declares (package.json, Cargo.toml, pom.xml).',
  'hover = blast radius': 'Hover a node to light up everything that depends on it.',
  'box = build unit': 'A package, crate, or module a manifest declares.',
  'edge = import between units': 'At least one file in one unit imports a file in the other.',
  'card = tier': 'A role tier: what the code does (frontend, API, domain, data, …).',
  'band = tier': 'A role tier: what the code does (frontend, API, domain, data, …).',
  'edge = recorded imports': 'An import the scan read in source; nothing is inferred.',
  'edge = recorded import': 'An import the scan read in source; nothing is inferred.',
  'dashed red = upward': 'An import pointing up the stack, against the expected direction.',
  'wrong-way = red or dashed': 'An import pointing up the stack, against the expected direction.',
  'arc = skip-layer': 'An import that jumps over a tier in between.',
  'faded = types only': 'A type-only import: it couples shapes, not runtime.',
  'shelf = support tiers': 'Build, infra, and tests sit on a shelf below the stack.',
  'column = build unit': 'One column per package, crate, or module.',
  'row = tier': 'One row per role tier, upper layers first.',
  'cell = files': 'The files of one unit in one tier.',
  'cross-unit = heavier': 'A thicker line crosses build units.',
  'ellipse = data hub': 'A table, topic, or dataset the code reads or writes.',
  'solid = writes': 'Code writes to the hub.',
  'dashed = reads': 'Code reads from the hub.',
  'dotted = lineage': 'Data copied or derived from one hub into another.',
  'double ring = governed': 'A hub with a declared schema or contract.',
  'ring = hub': 'A file many others import.',
  'file = member': 'One file of the opened cell.',
};


/**
 * The map's reading key: each cue as `mark symbol = meaning`, grouped into shapes and lines,
 * then the tiers or node kinds the current map draws, then any limits the view names.
 *
 * The cue text comes from `readingLegend`, so the words are the tested contract; the marks
 * are drawn with the same theme tokens the map uses, and each cue carries a hover hint.
 */
export function renderLegend(container, model, options = {}) {
  container.replaceChildren();

  const shapes = [];
  const lines = [];
  const notes = [];
  for (const text of readingLegend(model, options.locLens === true)) {
    const split = text.indexOf(' = ');
    if (split === -1) {
      notes.push(text);
      continue;
    }
    const symbol = text.slice(0, split);
    (isLineSymbol(symbol) ? lines : shapes).push({ text, symbol, meaning: text.slice(split + 3) });
  }

  const guide = document.createElement('div');
  guide.className = 'legend-guide';
  if (shapes.length > 0) guide.append(legendSection('Shapes', shapes.map(legendCue)));
  if (lines.length > 0) guide.append(legendSection('Lines', lines.map(legendCue)));
  container.append(guide);

  if (model?.structure) {
    const tiers = legendTiers(model);
    if (tiers.length > 0) container.append(legendSection('Tiers', tiers));
  } else {
    // A Structure view's shapes say nothing the rows above do not (every card is a tier), so
    // the per-kind shape rows are left to the file and System maps.
    const counts = new Map();
    for (const node of model?.nodes ?? []) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    const kinds = [...counts.keys()].sort();
    if (kinds.length > 0) {
      container.append(
        legendSection(
          'Node kinds',
          kinds.map((kind) =>
            legendRow(kindMark(kind), kind, ` (${SHAPES[kind] ?? 'round-rectangle'})`, `${counts.get(kind)} on this map`),
          ),
        ),
      );
    }
  }

  if (notes.length > 0) {
    const list = document.createElement('ul');
    list.className = 'legend-notes';
    for (const text of notes) {
      const item = document.createElement('li');
      item.textContent = text;
      list.append(item);
    }
    container.append(list);
  }
}


function isLineSymbol(symbol) {
  return LEGEND_LINE_SYMBOLS.has(symbol) || symbol.startsWith('edge');
}


function legendSection(title, rows) {
  const section = document.createElement('section');
  section.className = 'legend-section';
  const heading = document.createElement('h4');
  heading.className = 'legend-heading';
  heading.textContent = title;
  section.append(heading, ...rows);
  return section;
}


function legendCue(cue) {
  return legendRow(cueMark(cue.symbol, cue.text), cue.symbol, ` = ${cue.meaning}`, LEGEND_HINTS[cue.text] ?? '');
}


/** One legend row: the mark, the symbol in full ink, the meaning muted. */
function legendRow(mark, symbol, meaning, hint) {
  const item = document.createElement('span');
  item.className = 'legend-item';
  if (hint) item.title = hint;
  const term = document.createElement('span');
  term.className = 'legend-term';
  const name = document.createElement('span');
  name.className = 'legend-symbol';
  name.textContent = symbol;
  const rest = document.createElement('span');
  rest.className = 'legend-meaning';
  rest.textContent = meaning;
  term.append(name, rest);
  item.append(mark, term);
  return item;
}


/** The role tiers the Structure view draws, each with its colour and file count. */
function legendTiers(model) {
  const files = new Map();
  for (const node of model.nodes ?? []) {
    if (!node.tier || node.kind === 'axis') continue;
    files.set(node.tier, (files.get(node.tier) ?? 0) + (Number(node.files) || 0));
  }
  return TIER_ORDER.filter((tier) => files.has(tier)).map((tier) => {
    const label = TIER_LABELS[tier] ?? tier;
    const mark = legendSvg();
    mark.append(svgElement('rect', { x: '3', y: '2', width: '18', height: '10', rx: '3', class: 'lm-tier' }));
    mark.style.setProperty('--lm-tier', tierColorVar(tier));
    const count = files.get(tier);
    return legendRow(mark, label, count > 0 ? ` · ${count} file(s)` : '', `Files the tier lens placed in ${label}`);
  });
}


function legendSvg() {
  return svgElement('svg', { class: 'legend-mark', viewBox: '0 0 24 14', 'aria-hidden': 'true' });
}


const STAR_POINTS = '12,1 13.8,5.2 18.3,5.4 14.8,8.2 16,12.6 12,10.1 8,12.6 9.2,8.2 5.7,5.4 10.2,5.2';
const DIAMOND_POINTS = '12,1 18,7 12,13 6,7';


/** A small drawing of the mark a cue names, in the map's own tokens. */
function cueMark(symbol, text) {
  const svg = legendSvg();
  const add = (name, attributes) => svg.append(svgElement(name, attributes));
  const arrow = (className, extra = {}) => {
    add('line', { x1: '2', y1: '7', x2: '18', y2: '7', class: className, ...extra });
    add('path', { d: 'M 17 4 L 22 7 L 17 10 z', class: `${className} lm-head` });
  };
  switch (symbol) {
    case 'size':
      add('circle', { cx: '5', cy: '9', r: '2.5', class: 'lm-node' });
      add('circle', { cx: '16', cy: '7', r: '5.5', class: 'lm-node lm-accent' });
      break;
    case 'island':
      add('rect', { x: '1.5', y: '1.5', width: '21', height: '11', rx: '3', class: 'lm-island' });
      add('rect', { x: '5', y: '5', width: '5', height: '4', rx: '1', class: 'lm-node' });
      add('rect', { x: '13', y: '5', width: '5', height: '4', rx: '1', class: 'lm-node' });
      break;
    case 'diamond':
      add('polygon', { points: DIAMOND_POINTS, class: 'lm-node lm-accent' });
      break;
    case 'star':
      add('polygon', { points: STAR_POINTS, class: 'lm-node lm-accent' });
      break;
    case 'column':
      add('rect', { x: '8', y: '1', width: '8', height: '12', rx: '2', class: 'lm-node' });
      break;
    case 'row':
      add('rect', { x: '1', y: '4', width: '22', height: '6', rx: '2', class: 'lm-node' });
      break;
    case 'shelf':
    case 'support':
    case 'tag':
      add('rect', { x: '2', y: '2', width: '20', height: '6', rx: '2', class: 'lm-node' });
      add('rect', { x: '2', y: '9.5', width: '20', height: '3', rx: '1', class: 'lm-shelf' });
      break;
    case 'ellipse':
      add('ellipse', { cx: '12', cy: '7', rx: '9', ry: '5', class: 'lm-node lm-hub' });
      break;
    case 'double ring':
      add('circle', { cx: '12', cy: '7', r: '5.5', class: 'lm-ring' });
      add('circle', { cx: '12', cy: '7', r: '3', class: 'lm-ring' });
      break;
    case 'ring':
      add('circle', { cx: '12', cy: '7', r: '4.5', class: 'lm-node lm-ring-thick' });
      break;
    case 'ports':
      add('rect', { x: '4', y: '2', width: '16', height: '10', rx: '2', class: 'lm-node' });
      add('circle', { cx: '4', cy: '7', r: '2', class: 'lm-port-read' });
      add('circle', { cx: '20', cy: '7', r: '2', class: 'lm-port-write' });
      break;
    case 'badge':
      add('rect', { x: '5', y: '3.5', width: '14', height: '7', rx: '3.5', class: 'lm-badge' });
      break;
    case 'hover':
      add('circle', { cx: '12', cy: '7', r: '6', class: 'lm-halo' });
      add('circle', { cx: '12', cy: '7', r: '3', class: 'lm-node lm-accent' });
      break;
    case 'dashed red':
    case 'wrong-way':
      arrow('lm-edge lm-bad', { 'stroke-dasharray': '3 2' });
      break;
    case 'dashed':
      arrow('lm-edge', { 'stroke-dasharray': '3 2' });
      break;
    case 'dotted':
      arrow('lm-edge', { 'stroke-dasharray': '1 2' });
      break;
    case 'arc':
      add('path', { d: 'M 2 12 Q 12 -4 22 12', class: 'lm-edge lm-warn lm-open' });
      break;
    case 'faded':
      arrow('lm-edge lm-faded');
      break;
    case 'cross-unit':
      arrow('lm-edge lm-heavy');
      break;
    default:
      if (isLineSymbol(symbol)) {
        arrow('lm-edge');
      } else if (text.startsWith('dotted = gone since')) {
        arrow('lm-edge', { 'stroke-dasharray': '1 2' });
      } else {
        // card, box, band, cell, file, lane: a node card.
        add('rect', { x: '3', y: '2', width: '18', height: '10', rx: '3', class: 'lm-node' });
      }
  }
  return svg;
}


/** The glyph for a node kind, matching the shape the map draws it with. */
function kindMark(kind) {
  const shape = SHAPES[kind] ?? 'round-rectangle';
  const svg = legendSvg();
  const add = (name, attributes) => svg.append(svgElement(name, attributes));
  const className = kind === 'test' || kind === 'entry' ? 'lm-node lm-accent' : 'lm-node';
  if (shape === 'diamond' || shape === 'round-diamond') {
    add('polygon', { points: DIAMOND_POINTS, class: className });
  } else if (shape === 'star') {
    add('polygon', { points: STAR_POINTS, class: className });
  } else if (shape === 'hexagon') {
    add('polygon', { points: '7,2 17,2 21,7 17,12 7,12 3,7', class: className });
  } else if (shape === 'ellipse') {
    add('ellipse', { cx: '12', cy: '7', rx: '8', ry: '5', class: className });
  } else {
    add('rect', { x: '5', y: '2', width: '14', height: '10', rx: shape === 'rectangle' ? '0' : '3', class: className });
  }
  return svg;
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
      // The root directory's filter is '' too, which is the whole map: "modules" already
      // offers that, and a second chip with the same key would replace it on re-render.
      ...counts.entries
        .filter((entry) => entry.filter !== '')
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
