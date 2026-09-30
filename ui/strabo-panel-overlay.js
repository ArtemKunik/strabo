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

  // The overlay's own legend (Phase 34 U1): the states it draws, named. The map carries the
  // shapes; naming them here is what stops a reader guessing what a ring means.
  if (Array.isArray(overlay.legend) && overlay.legend.length > 0) {
    const legend = document.createElement('ul');
    legend.className = 'overlay-legend';
    legend.dataset.role = 'overlay-legend';
    for (const entry of overlay.legend) {
      const item = document.createElement('li');
      item.className = 'overlay-legend-item';
      item.dataset.swatch = entry.cls;
      item.textContent = entry.label;
      legend.append(item);
    }
    container.append(legend);
  }

  if (typeof overlay.note === 'string' && overlay.note) {
    const note = document.createElement('p');
    note.className = 'overlay-note';
    note.textContent = overlay.note;
    container.append(note);
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
 * The imports behind a Structure edge, one row each: `source:line → target`, type-only ones
 * tagged and listed last, since they are the likely false positives. A row opens the source
 * at the import. The report keeps a capped sample, so a longer roll-up says how many are unlisted.
 */
function renderTierImports(imports, weight, handlers) {
  const section = document.createElement('div');
  section.className = 'tier-imports';
  section.dataset.role = 'tier-imports';
  const heading = document.createElement('h4');
  heading.textContent = 'Imports';
  section.append(heading);
  const ordered = [...imports].sort((a, b) => Number(a.typeOnly === true) - Number(b.typeOnly === true));
  const list = document.createElement('ul');
  for (const entry of ordered) {
    const item = document.createElement('li');
    item.dataset.role = 'tier-import';
    if (entry.typeOnly) item.classList.add('is-type-only');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'tier-import-open';
    open.title = `${entry.specifier} — open the source at this import`;
    open.textContent = `${entry.source}:${entry.line}`;
    if (handlers.onViewSource) {
      open.addEventListener('click', () => handlers.onViewSource(entry.source, entry.line));
    } else {
      open.disabled = true;
    }
    item.append(open, document.createTextNode(` → ${entry.target}`));
    if (entry.typeOnly) {
      const tag = document.createElement('span');
      tag.className = 'tier-import-tag';
      tag.textContent = 'type';
      item.append(tag);
    }
    list.append(item);
  }
  section.append(list);
  if (typeof weight === 'number' && weight > imports.length) {
    const more = document.createElement('p');
    more.className = 'overlay-note';
    more.textContent = `${weight - imports.length} more not listed.`;
    section.append(more);
  }
  return section;
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
  const headingDetail =
    evidence.tierKind === 'upward'
      ? ' · Upward (Architecture Violation)'
      : evidence.tierKind === 'skip-layer'
        ? evidence.intended
          ? ' · Skip-layer (allowed by a declared rule)'
          : evidence.allowedCount > 0
            ? ` · Skip-layer (${evidence.allowedCount} of ${evidence.weight} imports allowed by a declared rule)`
            : ' · Skip-layer'
        : evidence.violation
          ? ' · Architecture Violation'
          : ` · ${evidence.kind}`;
  heading.textContent = `Edge${headingDetail}`;
  container.append(heading);

  const route = document.createElement('p');
  route.className = 'edge-route';
  route.append(edgeEndpoint(evidence.source, handlers.onSelect));
  route.append(document.createTextNode(' → '));
  route.append(edgeEndpoint(evidence.target, handlers.onSelect));
  container.append(route);

  const facts = document.createElement('dl');
  facts.className = 'passport-metrics';
  if (evidence.tierKind) {
    appendFact(
      facts,
      'Flow direction',
      evidence.tierKind === 'upward'
        ? 'Upward (against stack order)'
        : evidence.tierKind === 'skip-layer'
          ? 'Skip-layer'
          : 'Down (follows stack order)',
    );
  }
  if (evidence.allowedRules?.length > 1) {
    appendFact(facts, 'Allowed by', evidence.allowedRules.join(', '));
  } else if (evidence.ruleId) {
    appendFact(facts, 'Rule', evidence.ruleId);
  }
  if (typeof evidence.weight === 'number') {
    appendFact(facts, 'Recorded imports', String(evidence.weight));
  }
  const tierImports = evidence.tierImports;
  if (tierImports) {
    // A Structure edge is a roll-up: its evidence is the list of imports below, not one line.
    if (typeof evidence.typeOnlyCount === 'number' && evidence.typeOnlyCount > 0) {
      appendFact(facts, 'Type-only', `${evidence.typeOnlyCount} of ${evidence.weight} (erased at compile time)`);
    }
    container.append(facts);
    container.append(renderTierImports(tierImports, evidence.weight, handlers));
  } else {
    appendFact(facts, 'Specifier', evidence.specifier ?? 'not recorded');
    appendFact(facts, 'Line', evidence.line === null ? 'not recorded' : String(evidence.line));
    appendFact(facts, 'Resolution', evidence.resolutionLabel);
    container.append(facts);
  }

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

  if (handlers.onViewSource && !tierImports) {
    const source = document.createElement('button');
    source.type = 'button';
    source.className = 'source-open';
    source.textContent = 'View source';
    source.addEventListener('click', () => handlers.onViewSource(evidence.source, evidence.line ?? null));
    container.append(source);
  }

  // Phase 36 K3: the governing contract behind this edge, when the contracts lens
  // recorded one. Name, format, schema fields, access role, and conformance results;
  // an uncontracted crossing says so instead of showing an empty contract.
  if (evidence.contract) {
    appendFact(facts, 'Contract', `${evidence.contract} (${evidence.contractFormat ?? 'contract'})`);
  }
  if (Array.isArray(evidence.contractFields) && evidence.contractFields.length > 0) {
    appendFact(facts, 'Schema fields', evidence.contractFields.map((field) => field.name ?? field).join(', '));
  }
  if (Array.isArray(evidence.contractAccess) && evidence.contractAccess.length > 0) {
    appendFact(facts, 'Access', [...new Set(evidence.contractAccess)].join(', '));
  }
  if (Array.isArray(evidence.contractConformance) && evidence.contractConformance.length > 0) {
    appendFact(
      facts,
      'Conformance',
      evidence.contractConformance.map((finding) => `${finding.kind} on ${finding.field}`).join('; '),
    );
  } else if (evidence.contract) {
    appendFact(facts, 'Conformance', 'conforming: no recorded deviation');
  }
  if (evidence.uncontracted === true) {
    appendFact(facts, 'Contract', 'uncontracted: crosses units with no agreed contract');
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


const DRIFT_WIDTH = 320;
const DRIFT_HEIGHT = 140;
const DRIFT_PAD_X = 12;
const DRIFT_PAD_TOP = 14;
const DRIFT_PAD_BOTTOM = 18;

/** Unique per chart, so a floating panel and the screen can share a document safely. */
let driftChartSeq = 0;


/** A Catmull-Rom path relaxed into cubic beziers, so a measure reads as a curve, not corners. */
function driftSmoothPath(points) {
  if (points.length === 0) return '';
  const first = points[0];
  if (points.length === 1) return `M ${first.x.toFixed(1)} ${first.y.toFixed(1)}`;
  let d = `M ${first.x.toFixed(1)} ${first.y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    // Keep each control's height inside its segment's endpoints, so a cubic (a convex
    // combination of its controls) can never overshoot above a peak or below a trough.
    const low = Math.min(p1.y, p2.y);
    const high = Math.max(p1.y, p2.y);
    const c1y = Math.min(high, Math.max(low, p1.y + (p2.y - p0.y) / 6));
    const c2y = Math.min(high, Math.max(low, p2.y - (p3.y - p1.y) / 6));
    d +=
      ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}` +
      ` ${c2x.toFixed(1)} ${c2y.toFixed(1)}` +
      ` ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}


/**
 * The architecture-drift chart: one line per structural measure across the newest
 * revisions. A measure the revision cache could not supply is a gap, so the line breaks
 * rather than dropping to zero, and an unavailable report says so. A crosshair and a
 * tooltip read the values at a revision, and the legend keys, dims, and toggles the lines.
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

  const plotWidth = DRIFT_WIDTH - DRIFT_PAD_X * 2;
  const plotHeight = DRIFT_HEIGHT - DRIFT_PAD_TOP - DRIFT_PAD_BOTTOM;
  const count = Math.max(1, ...series.map((entry) => (entry.points ?? []).length));
  const xFor = (index) =>
    count <= 1
      ? DRIFT_PAD_X + plotWidth / 2
      : DRIFT_PAD_X + (index * plotWidth) / (count - 1);

  const wrap = document.createElement('div');
  wrap.className = 'drift-chart-wrap';

  const svg = svgElement('svg', {
    class: 'drift-chart',
    'data-role': 'drift-chart',
    viewBox: `0 0 ${DRIFT_WIDTH} ${DRIFT_HEIGHT}`,
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': `Architecture drift over ${points.length} revisions`,
  });
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(DRIFT_HEIGHT));

  const grid = svgElement('g', { class: 'drift-grid-lines' });
  for (let step = 0; step <= 4; step += 1) {
    const y = DRIFT_PAD_TOP + (step * plotHeight) / 4;
    grid.append(
      svgElement('line', {
        class: 'drift-grid',
        x1: String(DRIFT_PAD_X),
        x2: String(DRIFT_WIDTH - DRIFT_PAD_X),
        y1: y.toFixed(1),
        y2: y.toFixed(1),
      }),
    );
  }
  svg.append(grid);

  const clipId = `drift-plot-${(driftChartSeq += 1)}`;
  const clip = svgElement('clipPath', { id: clipId });
  clip.append(
    svgElement('rect', {
      x: String(DRIFT_PAD_X - 4),
      y: String(DRIFT_PAD_TOP - 4),
      width: String(plotWidth + 8),
      height: String(plotHeight + 8),
      rx: '8',
    }),
  );
  const defs = svgElement('defs', {});
  defs.append(clip);
  svg.append(defs);
  const plot = svgElement('g', { 'clip-path': `url(#${clipId})` });
  svg.append(plot);

  const geometry = series.map((entry, index) => {
    const values = (entry.points ?? []).map((point) => point.value);
    const defined = values.filter((value) => value !== null && value !== undefined);
    const min = defined.length > 0 ? Math.min(...defined) : 0;
    const max = defined.length > 0 ? Math.max(...defined) : 0;
    const span = max - min;
    const yFor = (value) =>
      span === 0
        ? DRIFT_PAD_TOP + plotHeight / 2
        : DRIFT_PAD_TOP + (1 - (value - min) / span) * plotHeight;
    return { entry, index, values, yFor };
  });

  const groups = geometry.map(({ entry, index, values, yFor }) => {
    const seriesCls = driftSeriesClass(index);
    const group = svgElement('g', {
      class: 'drift-series',
      'data-role': 'drift-series',
      'data-series-key': entry.key ?? String(index),
    });

    let segment = [];
    const emit = () => {
      if (segment.length === 0) return;
      if (segment.length === 1) {
        group.append(
          svgElement('circle', {
            class: `drift-mark drift-node ${seriesCls}`,
            cx: segment[0].x.toFixed(1),
            cy: segment[0].y.toFixed(1),
            r: '2.6',
          }),
        );
      } else {
        const d = driftSmoothPath(segment);
        group.append(
          svgElement('path', { class: `drift-halo ${seriesCls}`, d, 'data-role': 'drift-halo' }),
        );
        group.append(svgElement('path', { class: `drift-line ${seriesCls}`, d }));
      }
      segment = [];
    };
    values.forEach((value, i) => {
      if (value === null || value === undefined) {
        emit();
        return;
      }
      segment.push({ x: xFor(i), y: yFor(value) });
    });
    emit();

    let lastIndex = -1;
    values.forEach((value, i) => {
      if (value !== null && value !== undefined) lastIndex = i;
    });
    if (lastIndex >= 0) {
      group.append(
        svgElement('circle', {
          class: `drift-mark drift-endpoint ${seriesCls}`,
          cx: xFor(lastIndex).toFixed(1),
          cy: yFor(values[lastIndex]).toFixed(1),
          r: '3',
        }),
      );
    }

    plot.append(group);
    return group;
  });

  const crosshair = svgElement('line', {
    class: 'drift-crosshair',
    x1: '0',
    x2: '0',
    y1: String(DRIFT_PAD_TOP),
    y2: String(DRIFT_PAD_TOP + plotHeight),
  });
  plot.append(crosshair);

  const cursorDots = geometry.map(({ index }) => {
    const dot = svgElement('circle', {
      class: `drift-mark drift-cursor-dot ${driftSeriesClass(index)}`,
      cx: '0',
      cy: '0',
      r: '3.4',
    });
    dot.setAttribute('opacity', '0');
    plot.append(dot);
    return dot;
  });

  const tooltip = document.createElement('div');
  tooltip.className = 'drift-tooltip';
  tooltip.hidden = true;
  const tooltipHead = document.createElement('div');
  tooltipHead.className = 'drift-tooltip-head';
  const tooltipList = document.createElement('div');
  tooltipList.className = 'drift-tooltip-list';
  tooltip.append(tooltipHead, tooltipList);

  wrap.append(svg, tooltip);
  container.append(wrap);

  const hidden = new Set();
  const showAt = (viewX) => {
    const ratio = (viewX - DRIFT_PAD_X) / plotWidth;
    const index = Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
    const x = xFor(index);
    crosshair.setAttribute('x1', x.toFixed(1));
    crosshair.setAttribute('x2', x.toFixed(1));
    crosshair.classList.add('is-on');
    const revision = points[index];
    tooltipHead.textContent = revision
      ? `${revision.short}${revision.date ? ` · ${revision.date.slice(0, 10)}` : ''}`
      : `#${index + 1}`;
    tooltipList.replaceChildren();
    geometry.forEach(({ entry, values, yFor }, seriesIndex) => {
      const dot = cursorDots[seriesIndex];
      const value = values[index];
      if (value === null || value === undefined || hidden.has(seriesIndex)) {
        dot.setAttribute('opacity', '0');
        return;
      }
      dot.setAttribute('cx', x.toFixed(1));
      dot.setAttribute('cy', yFor(value).toFixed(1));
      dot.setAttribute('opacity', '1');
      const row = document.createElement('div');
      row.className = 'drift-tooltip-row';
      const swatch = document.createElement('span');
      swatch.className = `drift-legend-swatch ${driftSeriesClass(seriesIndex)}`;
      swatch.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'drift-tooltip-label';
      label.textContent = entry.label;
      const valueSpan = document.createElement('span');
      valueSpan.className = 'drift-tooltip-value';
      valueSpan.textContent = String(value);
      row.append(swatch, label, valueSpan);
      tooltipList.append(row);
    });
    const percent = (x / DRIFT_WIDTH) * 100;
    tooltip.style.left = `${Math.max(14, Math.min(86, percent))}%`;
    tooltip.hidden = false;
  };
  const hide = () => {
    crosshair.classList.remove('is-on');
    cursorDots.forEach((dot) => dot.setAttribute('opacity', '0'));
    tooltip.hidden = true;
  };
  svg.addEventListener('pointermove', (event) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    showAt(((event.clientX - rect.left) / rect.width) * DRIFT_WIDTH);
  });
  svg.addEventListener('pointerleave', hide);

  const legend = document.createElement('div');
  legend.className = 'drift-legend';
  legend.dataset.role = 'drift-legend';
  series.forEach((entry, index) => {
    const item = document.createElement('button');
    item.type = 'button';
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
    item.title = `${entry.label}: ${values.join(' → ')} · click to hide`;
    item.append(swatch, text);
    item.addEventListener('pointerenter', () => {
      svg.classList.add('drift-focus');
      groups[index].classList.add('is-active');
    });
    item.addEventListener('pointerleave', () => {
      svg.classList.remove('drift-focus');
      groups[index].classList.remove('is-active');
    });
    item.addEventListener('click', () => {
      if (hidden.has(index)) {
        hidden.delete(index);
        groups[index].classList.remove('is-hidden');
        item.classList.remove('is-off');
        return;
      }
      hidden.add(index);
      groups[index].classList.add('is-hidden');
      item.classList.add('is-off');
    });
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

  // The drift series can take seconds to build server-side while the commit list is already
  // readable, so a pending drift shows a placeholder the chart replaces when it arrives.
  if (options.drift) {
    renderDriftChart(container, options.drift);
  } else if (options.driftPending) {
    const pending = document.createElement('p');
    pending.className = 'drift-pending';
    pending.dataset.role = 'drift-pending';
    pending.textContent = 'Building the architecture-drift timeline…';
    container.append(pending);
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
