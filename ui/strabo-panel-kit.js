/**
 * Shared DOM primitives for the panel modules: a button, an "unavailable" note, an SVG element factory, and the small wiring/fact helpers reused across panels.
 *
 * Split out of strabo-panels.js.
 */


/**
 * The in-panel Back control: a drill-in view steps down to the view it was opened from.
 *
 * `handlers.canGoBack === false` renders it disabled, for a view with nothing behind it;
 * `handlers.backTitle` names the destination in the tooltip and for screen readers.
 */
export function backButton(handlers, fallbackTitle) {
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'panel-back';
  back.dataset.role = 'panel-back';
  back.textContent = '← Back';
  back.disabled = handlers.canGoBack === false;
  const title = handlers.backTitle ?? fallbackTitle;
  back.title = title;
  back.setAttribute('aria-label', title);
  back.addEventListener('click', () => handlers.onBack?.());
  return back;
}


export function appendFact(list, term, value) {
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = value;
  list.append(dt, dd);
}


export function wiring(text) {
  const span = document.createElement('span');
  span.className = 'wiring';
  span.textContent = ` · ${text}`;
  return span;
}


export function unavailableNote(text) {
  const note = document.createElement('p');
  note.className = 'unavailable';
  note.textContent = text;
  return note;
}


export function button(id, text, handler, className = '') {
  const element = document.createElement('button');
  element.type = 'button';
  element.id = id;
  element.className = className || undefined;
  element.textContent = text;
  if (handler) {
    element.addEventListener('click', handler);
  }
  return element;
}


export function matches(name, needle) {
  return !needle || name.toLowerCase().includes(needle);
}


export function svgElement(name, attributes) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }
  return element;
}
