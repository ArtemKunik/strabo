/**
 * The review-overlay summary, edge evidence, and the change timeline.
 *
 * Split out of strabo-panels.js.
 */

import {
  commitMetricBadge,
  createVirtualList,
} from './strabo-core.js';

import { appendFact, button, svgElement } from './strabo-panel-kit.js';

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
  }

  if (Array.isArray(overlay.items) && overlay.items.length > 0) {
    const needsSearch = overlay.items.length > 8;
    const changedItems = overlay.changedItems instanceof Set ? overlay.changedItems : null;
    const affectedItems = overlay.affectedItems instanceof Set ? overlay.affectedItems : null;
    const showChangedOnly = changedItems !== null && changedItems.size > 0 && changedItems.size < overlay.items.length;
    let filter = '';
    let changedOnly = false;

    const itemText = (item) =>
      typeof item === 'string' ? item : String(item?.label ?? item?.id ?? '');

    const rowFor = (item) => {
      const entry = document.createElement('div');
      entry.className = 'overlay-list-row';
      entry.setAttribute('role', 'listitem');
      if (affectedItems && affectedItems.has(item)) {
        entry.classList.add('overlay-row-affected');
      }
      if (typeof item === 'string') {
        entry.dataset.delegateOverlayItem = item;
      }
      // A richer overlay may contribute a `{ id, label, detail }` row; the label is the
      // selectable text and the detail rides beside it as evidence.
      if (item !== null && typeof item === 'object') {
        const id = item.id ?? itemText(item);
        entry.dataset.delegateOverlayItem = id;
        if (options.onSelect && id) {
          const jump = document.createElement('button');
          jump.type = 'button';
          jump.textContent = item.label ?? id;
          jump.title = item.detail ? `Select ${id} — ${item.detail}` : `Select ${id}`;
          jump.addEventListener('click', () => options.onSelect(id));
          entry.append(jump);
        } else {
          entry.textContent = item.label ?? id;
        }
        if (item.detail) {
          const detail = document.createElement('span');
          detail.className = 'evidence';
          detail.textContent = ` · ${item.detail}`;
          entry.append(detail);
        }
        return entry;
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

    const matchingItems = () => {
      let items = overlay.items;
      if (changedOnly && changedItems) {
        items = items.filter((item) => changedItems.has(item));
      }
      if (filter) {
        items = items.filter((item) => itemText(item).toLowerCase().includes(filter));
      }
      return items;
    };

    const empty = document.createElement('p');
    empty.className = 'overlay-empty';
    empty.hidden = true;

    const renderList = () => {
      const matching = matchingItems();
      empty.textContent = changedOnly && !filter
        ? 'No changed modules.'
        : 'No modules match this filter.';
      empty.hidden = matching.length > 0;
      list.setItems(matching);
    };

    const controls = document.createElement('div');
    controls.className = 'overlay-controls';

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
      controls.append(search);
    }

    if (showChangedOnly) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'overlay-toggle-changed';
      toggle.setAttribute('aria-pressed', 'false');
      toggle.textContent = 'Changed only';
      toggle.title = 'Hide the potentially affected dependents';
      toggle.addEventListener('click', () => {
        changedOnly = !changedOnly;
        toggle.setAttribute('aria-pressed', String(changedOnly));
        renderList();
      });
      controls.append(toggle);
    }

    if (controls.childElementCount > 0) {
      container.append(controls);
    }
    container.append(list.element);
    container.append(empty);
    renderList();
    list.refresh();
  }

  // Buttons an overlay contributes, e.g. committing the working tree the impact list shows.
  if (Array.isArray(options.actions) && options.actions.length > 0) {
    const actions = document.createElement('div');
    actions.className = 'overlay-actions';
    for (const action of options.actions) {
      const actionButton = document.createElement('button');
      actionButton.type = 'button';
      actionButton.className = 'overlay-action';
      actionButton.textContent = action.label;
      if (action.title) {
        actionButton.title = action.title;
      }
      if (action.disabled) {
        actionButton.disabled = true;
      }
      actionButton.addEventListener('click', () => action.onClick?.());
      actions.append(actionButton);
    }
    container.append(actions);
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

  // T6: the graph fingerprint and scan time behind the evidence, labelled stale when the
  // served graph is older than the working tree.
  const provenance = evidence.provenance ?? handlers.provenance ?? null;
  if (provenance && provenance.fingerprint) {
    const line = document.createElement('p');
    line.className = provenance.stale === true ? 'evidence is-stale' : 'evidence';
    line.dataset.role = 'edge-provenance';
    line.textContent = evidenceProvenanceText(provenance);
    container.append(line);
  }

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


/**
 * The graph fingerprint and scan time behind an edge's evidence, with a stale label when the
 * served graph is older than the working tree (T6). Absent a fingerprint, no line is shown.
 */
export function evidenceProvenanceText(provenance) {
  if (!provenance || !provenance.fingerprint) {
    return '';
  }
  const short = String(provenance.fingerprint).split(':')[0]?.slice(0, 7) || provenance.fingerprint;
  const scanned = provenance.scannedAt
    ? ` · scanned ${String(provenance.scannedAt).slice(0, 19).replace('T', ' ')}`
    : '';
  return provenance.stale === true
    ? `graph ${short}${scanned} · stale: the working tree has moved on`
    : `graph ${short}${scanned}`;
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


/**
 * The bounded categorical class for a drift series: three hues plus the neutral, per the
 * colour budget (R8). The colour lives in `styles.css`, never as a literal here.
 */
function driftSeriesClass(index) {
  return `drift-series-${index < 3 ? index + 1 : 'other'}`;
}


/**
 * The architecture-drift chart: one line per structural measure across the newest
 * revisions. A measure the revision cache could not supply is a gap, so the line breaks
 * rather than dropping to zero, and an unavailable report says so.
 */
function renderDriftChart(container, drift) {
  if (!drift) {
    return;
  }
  if (drift.available === false) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.dataset.role = 'drift-unavailable';
    note.textContent = `Architecture drift unavailable: ${drift.reason ?? 'not recorded'}`;
    container.append(note);
    return;
  }
  const points = drift.points ?? [];
  const series = drift.series ?? [];
  if (points.length === 0 || series.length === 0) {
    return;
  }

  const width = 320;
  const height = 120;
  const padding = 8;
  const svg = svgElement('svg', {
    class: 'drift-chart',
    'data-role': 'drift-chart',
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none',
  });
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '120');

  series.forEach((entry, index) => {
    const values = (entry.points ?? []).map((point) => point.value);
    const defined = values.filter((value) => value !== null && value !== undefined);
    const min = defined.length > 0 ? Math.min(...defined) : 0;
    const max = defined.length > 0 ? Math.max(...defined) : 0;
    const span = max - min;
    const xFor = (i) =>
      values.length <= 1 ? width / 2 : padding + (i * (width - padding * 2)) / (values.length - 1);
    const yFor = (value) =>
      span === 0 ? height / 2 : height - padding - ((value - min) / span) * (height - padding * 2);

    let segment = [];
    const flush = () => {
      if (segment.length === 0) return;
      svg.append(
        svgElement('polyline', {
          class: driftSeriesClass(index),
          points: segment.join(' '),
          fill: 'none',
          'stroke-width': '2',
          'vector-effect': 'non-scaling-stroke',
        }),
      );
      segment = [];
    };
    values.forEach((value, i) => {
      if (value === null || value === undefined) {
        flush();
        return;
      }
      segment.push(`${xFor(i).toFixed(1)},${yFor(value).toFixed(1)}`);
    });
    flush();
  });
  container.append(svg);

  const legend = document.createElement('div');
  legend.className = 'drift-legend';
  legend.dataset.role = 'drift-legend';
  series.forEach((entry, index) => {
    const item = document.createElement('span');
    item.className = 'drift-legend-item';
    const values = (entry.points ?? []).map((point) =>
      point.value === null || point.value === undefined ? '—' : String(point.value),
    );
    // The chart already draws the shape, so the legend names the line and shows its ends.
    // Printing every value made each item thousands of pixels wide and unreadable; the ends
    // are enough to key the line, and the full series stays in the tooltip.
    const shown =
      values.length <= 2
        ? values.join(' → ')
        : `${values[0]} → … → ${values[values.length - 1]}`;
    const swatch = document.createElement('span');
    swatch.className = `drift-legend-swatch ${driftSeriesClass(index)}`;
    swatch.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'drift-legend-text';
    text.textContent = `${entry.label}: ${shown}`;
    item.title = `${entry.label}: ${values.join(' → ')}`;
    item.append(swatch, text);
    legend.append(item);
  });
  container.append(legend);
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

  renderDriftChart(container, options.drift);

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
