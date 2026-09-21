/**
 * The System-view unit card (L21, L22).
 *
 * A unit is a card with facts, not an empty box: a header (name, ecosystem, role), stats
 * (files, lines, languages), layer bars, a hotspot/test-reach line, and a muted, dashed
 * shelf footer strip that expands in place. The card is DOM, positioned over its node by
 * `strabo-view.js`; this module only builds the element, so it is testable without
 * Cytoscape.
 *
 * No colours are defined here: `styles.css` owns every token, and the bar width is the
 * only inline style (a data value, not a hue).
 */

/** Compact file/line counts: 1200 reads as `1.2k`. */
export function formatCount(value) {
  const number = Math.max(0, Math.round(Number(value) || 0));
  if (number < 1000) {
    return String(number);
  }
  const thousands = number / 1000;
  return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, '')}k`;
}

/** Layer bars scale to the largest layer, so the tallest always fills the track. */
export function layerBars(layers) {
  const max = Math.max(1, ...(layers ?? []).map((layer) => layer.files));
  return (layers ?? []).map((layer) => ({
    name: layer.name,
    files: layer.files,
    ratio: layer.files / max,
  }));
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function shelfCategories(shelf) {
  return [
    ['test', 'tests'],
    ['script', 'scripts'],
    ['generated', 'generated'],
    ['fixture', 'fixtures'],
  ].filter(([key]) => shelf[key] > 0);
}

/**
 * Build one unit card.
 *
 * `options.expanded` opens the shelf strip on first paint; a click toggles it in place.
 */
export function unitCardElement(card, options = {}) {
  const root = element('article', 'unit-card');
  root.dataset.unit = card.id;

  const head = element('header', 'unit-card-head');
  head.append(element('span', 'unit-card-name', card.name));
  if (card.role) {
    head.append(element('span', 'unit-card-role', card.role));
  }
  head.append(element('span', 'unit-card-eco', card.ecosystem));
  root.append(head);

  if (card.manifest) {
    root.append(element('div', 'unit-card-why', `why: ${card.manifest}`));
  }

  const stats = element('div', 'unit-card-stats');
  stats.append(element('span', 'unit-stat', `${formatCount(card.files)} files`));
  stats.append(element('span', 'unit-stat', `${formatCount(card.loc)} lines`));
  const languages = Object.keys(card.languages ?? {}).length;
  stats.append(element('span', 'unit-stat', `${languages} lang${languages === 1 ? '' : 's'}`));
  root.append(stats);

  const layers = element('div', 'unit-card-layers');
  for (const bar of layerBars(card.layers)) {
    const row = element('div', 'unit-layer');
    row.append(element('span', 'unit-layer-name', bar.name));
    const track = element('span', 'unit-layer-track');
    const fill = element('span', 'unit-layer-bar');
    fill.style.width = `${Math.round(bar.ratio * 100)}%`;
    track.append(fill);
    row.append(track, element('span', 'unit-layer-count', String(bar.files)));
    layers.append(row);
  }
  if (card.layers?.length) {
    root.append(layers);
  }

  const reach = element('div', 'unit-card-reach');
  const hotspots = card.hotspots === null || card.hotspots === undefined ? '—' : String(card.hotspots);
  const share = card.testReach?.total
    ? `${Math.round((card.testReach.reached / card.testReach.total) * 100)}%`
    : '0%';
  reach.append(
    element('span', 'unit-stat', `hotspots ${hotspots}`),
    element('span', 'unit-stat', `test reach ${share}`),
  );
  root.append(reach);

  if (card.shelf?.total > 0) {
    const strip = element('button', 'unit-shelf');
    strip.type = 'button';
    const parts = [];
    if (card.shelf.test) parts.push(`${card.shelf.test} test${card.shelf.test === 1 ? '' : 's'}`);
    if (card.shelf.script) parts.push(`${card.shelf.script} script${card.shelf.script === 1 ? '' : 's'}`);
    strip.textContent = `support: ${parts.length ? parts.join(' · ') : `${card.shelf.total} files`}`;
    strip.setAttribute('aria-expanded', String(Boolean(options.expanded)));
    const more = element('div', 'unit-shelf-more');
    more.hidden = !options.expanded;
    for (const [key, label] of shelfCategories(card.shelf)) {
      more.append(element('div', 'unit-shelf-row', `${card.shelf[key]} ${label}`));
    }
    strip.addEventListener('click', (event) => {
      event.stopPropagation();
      more.hidden = !more.hidden;
      strip.setAttribute('aria-expanded', String(!more.hidden));
    });
    root.append(strip, more);
  }

  return root;
}
