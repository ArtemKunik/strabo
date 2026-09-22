/**
 * The review-overlay summary, edge evidence, and the change timeline.
 *
 * Split out of strabo-panels.js.
 */

import {
  commitMetricBadge,
  createVirtualList,
} from './strabo-core.js';

import { appendFact, button } from './strabo-panel-kit.js';

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
        items = items.filter((item) => String(item).toLowerCase().includes(filter));
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
