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

import { button } from './strabo-panel-kit.js';


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
  'size = lines of code': 'linear-gradient(135deg,var(--node-fill),var(--accent))',
  'island = directory': 'linear-gradient(135deg,var(--island-fill),var(--node-fill))',
  'diamond = test': 'linear-gradient(135deg,var(--node-fill),var(--accent))',
  'hover = blast radius': 'linear-gradient(135deg,var(--ink-3),var(--accent))',
  'box = build unit': 'linear-gradient(135deg,var(--node-fill),var(--accent))',
  'size = files': 'linear-gradient(135deg,var(--node-fill),var(--accent))',
  'edge = import between units': 'linear-gradient(135deg,var(--graph-edge),var(--accent))',
  'support = unit footer': 'linear-gradient(135deg,var(--wash),var(--node-fill))',
};


export function renderLegend(container, model, options = {}) {
  container.replaceChildren();

  const guide = document.createElement('div');
  guide.className = 'legend-guide';
  for (const text of readingLegend(model, options.locLens === true)) {
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
