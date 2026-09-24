/**
 * The Blocks panel: the current map drawn as a Lego-style brick assembly.
 *
 * Bricks are the recorded nodes and snaps are the recorded edges, stacked on the pure model
 * in `strabo-lego.js`. This module only turns that model into DOM/SVG; it reads no graph and
 * invents no fact, so the drawing is exactly what `buildBrickAssembly` returned.
 *
 * No colour is defined here. Every status is a class (`brick`, `tangled`, `detached`,
 * `keystone`) resolved against `styles.css` tokens, and status never rides on hue alone — the
 * outline style differs per status as well.
 */

import { assemblySummary, layoutAssembly } from './strabo-lego.js';
import { svgElement, unavailableNote } from './strabo-panel-kit.js';

/** The status key, drawn under the assembly, and the outline shape that carries it. */
const LEGEND = [
  ['plain', 'plain brick'],
  ['keystone', 'load-bearing (double ring)'],
  ['tangled', 'dependency cycle (dashed)'],
  ['detached', 'no recorded import (dotted)'],
];

/** Trim a brick label to the width its face can hold, keeping the head. */
function fitLabel(label, width) {
  const max = Math.max(3, Math.floor((width - 8) / 6.2));
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

function brickGroup(brick, options) {
  const selected = options.selected === brick.id;
  const group = svgElement('g', {
    class: `brick ${brick.status}${selected ? ' is-selected' : ''}`,
    transform: `translate(${brick.x},${brick.y})`,
    tabindex: '0',
    role: 'button',
    'aria-label': `${brick.label}: ${brick.status}, ${brick.studs} stud(s), rests on ${brick.restsOn} brick(s)`,
  });
  group.dataset.brick = brick.id;

  const studs = Math.max(1, Math.min(brick.studs, Math.max(1, Math.round(brick.w / 10))));
  for (let index = 1; index <= studs; index += 1) {
    group.append(
      svgElement('circle', {
        class: 'brick-stud',
        cx: ((brick.w * index) / (studs + 1)).toFixed(1),
        cy: '-1',
        r: '3',
      }),
    );
  }

  group.append(svgElement('rect', { class: 'brick-rect', width: brick.w, height: brick.h, rx: '5' }));

  const text = svgElement('text', {
    class: 'brick-label',
    x: (brick.w / 2).toFixed(1),
    y: String(brick.h - 5),
    'text-anchor': 'middle',
  });
  text.textContent = fitLabel(brick.label, brick.w);
  group.append(text);

  const title = svgElement('title', {});
  title.textContent = `${brick.label} (${brick.kind}) · layer ${brick.layer} · studs ${brick.studs} · rests on ${brick.restsOn} · topples ${brick.topples}`;
  group.append(title);

  if (typeof options.onOpen === 'function') {
    group.addEventListener('click', (event) => {
      event.stopPropagation();
      options.onOpen(brick.id);
    });
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        options.onOpen(brick.id);
      }
    });
  }
  return group;
}

function assemblySvg(layout, options) {
  const svg = svgElement('svg', {
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    class: 'blocks-svg',
    role: 'img',
    'aria-label': `Brick assembly: ${layout.bricks.length} bricks, ${layout.snaps.length} recorded snaps`,
  });
  svg.dataset.role = 'blocks-svg';

  const snapLayer = svgElement('g', { class: 'blocks-snaps' });
  for (const snap of layout.snaps) {
    const path = svgElement('path', {
      class: 'blocks-snap',
      d: `M ${snap.x1.toFixed(1)} ${snap.y1.toFixed(1)} C ${snap.x1.toFixed(1)} ${(snap.y1 + 8).toFixed(1)}, ${snap.x2.toFixed(1)} ${(snap.y2 - 8).toFixed(1)}, ${snap.x2.toFixed(1)} ${snap.y2.toFixed(1)}`,
    });
    snapLayer.append(path);
  }
  svg.append(snapLayer);

  const brickLayer = svgElement('g', { class: 'blocks-bricks' });
  for (const brick of layout.bricks) {
    brickLayer.append(brickGroup(brick, options));
  }
  svg.append(brickLayer);

  if (typeof options.onClear === 'function') {
    svg.addEventListener('click', () => options.onClear());
  }
  return svg;
}

/**
 * Render the Blocks panel into `container`.
 *
 * `assembly` is a `buildBrickAssembly` result; `options.selected` highlights one brick id and
 * `options.onOpen(id)` fires when a brick is activated. An empty map says so rather than
 * drawing an empty stage.
 */
export function renderBlocks(container, assembly, options = {}) {
  container.replaceChildren();
  container.dataset.role = 'blocks';

  const head = document.createElement('header');
  head.className = 'blocks-head';
  const summary = document.createElement('p');
  summary.className = 'blocks-summary';
  summary.dataset.role = 'blocks-summary';
  summary.textContent = assemblySummary(assembly);
  head.append(summary);
  container.append(head);

  if (!assembly?.available) {
    container.append(unavailableNote('No map is drawn yet, so there are no bricks to assemble.'));
    return;
  }

  const stage = document.createElement('div');
  stage.className = 'blocks-stage';
  stage.append(assemblySvg(layoutAssembly(assembly), options));
  container.append(stage);

  const legend = document.createElement('ul');
  legend.className = 'blocks-legend';
  for (const [status, label] of LEGEND) {
    const item = document.createElement('li');
    item.className = `blocks-legend-row ${status}`;
    const swatch = document.createElement('span');
    swatch.className = `blocks-swatch ${status}`;
    swatch.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = label;
    item.append(swatch, text);
    legend.append(item);
  }
  container.append(legend);

  const notes = document.createElement('section');
  notes.className = 'blocks-notes';
  const title = document.createElement('h4');
  title.textContent = 'Assembly notes';
  notes.append(title);
  if ((assembly.suggestions ?? []).length === 0) {
    const clear = document.createElement('p');
    clear.className = 'blocks-clear';
    clear.textContent = 'Every brick connects to the stack, and no cycle was recorded.';
    notes.append(clear);
  } else {
    const list = document.createElement('ul');
    for (const suggestion of assembly.suggestions) {
      const item = document.createElement('li');
      item.className = `blocks-note ${suggestion.kind}`;
      item.dataset.kind = suggestion.kind;
      const strong = document.createElement('strong');
      strong.textContent = suggestion.title;
      const detail = document.createElement('p');
      detail.textContent = suggestion.detail;
      item.append(strong, detail);
      list.append(item);
    }
    notes.append(list);
  }
  container.append(notes);
}
