/**
 * A tiny, framework-free view layer: `h()` builds a virtual tree and `mount()` reconciles
 * a container against it.
 *
 * The UI previously rebuilt whole panels with `replaceChildren()`, which threw away focus,
 * scroll, and any in-progress CSS transition on every render. `mount()` diffs children by
 * `key` and reuses the existing DOM nodes, so a list that gains or loses an item updates in
 * place. It is deliberately small — enough structure to stop rebuilding, no component
 * lifecycle, no scheduler, no build-time transforms.
 *
 * A vnode is `{ type, props, key, children }`: `type` is a tag string or `#text`, children
 * are vnodes, and `key` (taken out of `props`) is the stable identity used to match a child
 * across renders. `Fragment` groups children without a wrapper element.
 */

/** Groups children without introducing an element, so a container keeps its direct kids. */
export const Fragment = Symbol('fragment');

const roots = new WeakMap();

/** Build a vnode. Text and numbers become text children; null/false/true are skipped. */
export function h(type, props, ...children) {
  const { key = null, ...rest } = props ?? {};
  return { type, props: rest, key, children: normalizeChildren(children) };
}

/**
 * Reconcile `parent` against `vnode`, reusing nodes from the previous mount.
 *
 * The previous tree is remembered per parent in a WeakMap, so callers render by describing
 * the whole panel each time and let this diff it.
 */
export function mount(parent, vnode) {
  const previous = roots.get(parent) ?? null;
  const next = patch(parent, vnode, previous);
  roots.set(parent, next);
  return next;
}

function normalizeChildren(values) {
  const out = [];
  const visit = (value) => {
    if (value === null || value === undefined || value === false || value === true) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      out.push({ type: '#text', text: String(value), props: {}, key: null, children: [] });
      return;
    }
    if (typeof value === 'object' && 'type' in value) {
      out.push(value);
    }
  };
  values.forEach(visit);
  return out;
}

function patch(parent, next, prev) {
  if (next && next.type === Fragment) {
    const prevChildren = prev?.type === Fragment ? prev.children : [];
    if (prev && prev.type !== Fragment && prev.dom && prev.dom.parentNode === parent) {
      parent.removeChild(prev.dom);
    }
    updateChildren(parent, prevChildren, next.children);
    next.dom = parent;
    return next;
  }

  if (prev?.type === Fragment) {
    for (const child of prev.children) {
      if (child.dom && child.dom.parentNode === parent) {
        parent.removeChild(child.dom);
      }
    }
    prev = null;
  }

  if (prev && next && prev.type === next.type && prev.key === next.key) {
    updateDom(prev, next);
    return next;
  }

  const dom = next ? createDom(next) : null;
  if (next) {
    next.dom = dom;
  }
  if (prev?.dom && prev.dom.parentNode === parent) {
    if (dom) {
      parent.replaceChild(dom, prev.dom);
    } else {
      parent.removeChild(prev.dom);
    }
  } else if (dom) {
    parent.appendChild(dom);
  }
  return next;
}

function createDom(vnode) {
  if (vnode.type === '#text') {
    return document.createTextNode(vnode.text);
  }
  const dom = document.createElement(vnode.type);
  patchProps(dom, vnode.props, {});
  for (const child of vnode.children) {
    const childDom = createDom(child);
    child.dom = childDom;
    dom.appendChild(childDom);
  }
  return dom;
}

function updateDom(prev, next) {
  const dom = prev.dom;
  next.dom = dom;
  if (next.type === '#text') {
    if (dom.nodeValue !== next.text) {
      dom.nodeValue = next.text;
    }
    return;
  }
  patchProps(dom, next.props, prev.props);
  updateChildren(dom, prev.children, next.children);
}

/**
 * Match next children to previous ones by `key` (else by position) and reorder the DOM to
 * match. Unmatched previous nodes are removed; new nodes are inserted where they belong.
 */
function updateChildren(parent, prevChildren, nextChildren) {
  const prevByKey = new Map();
  const prevUnkeyed = [];
  for (const child of prevChildren) {
    if (child.key !== null) {
      prevByKey.set(child.key, child);
    } else {
      prevUnkeyed.push(child);
    }
  }

  let unkeyedCursor = 0;
  const next = [];
  for (const child of nextChildren) {
    let match = null;
    if (child.key !== null) {
      match = prevByKey.get(child.key) ?? null;
    } else if (unkeyedCursor < prevUnkeyed.length) {
      match = prevUnkeyed[unkeyedCursor];
      unkeyedCursor += 1;
    }
    next.push(patchChild(parent, child, match));
  }

  for (const child of prevChildren) {
    if (child.dom && child.dom.parentNode === parent && !next.includes(child)) {
      parent.removeChild(child.dom);
    }
  }

  const desired = [];
  for (const child of next) {
    if (child.dom && child.dom !== parent) {
      desired.push(child.dom);
    }
  }
  for (let index = 0; index < desired.length; index += 1) {
    const node = desired[index];
    if (parent.childNodes[index] !== node) {
      parent.insertBefore(node, parent.childNodes[index] ?? null);
    }
  }
}

function patchChild(parent, next, prev) {
  if (prev && prev.type === next.type && prev.key === next.key && next.type !== Fragment) {
    updateDom(prev, next);
    return next;
  }
  const dom = createDom(next);
  next.dom = dom;
  return next;
}

function patchProps(dom, next = {}, prev = {}) {
  const names = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const name of names) {
    if (prev[name] === next[name]) {
      continue;
    }
    applyProp(dom, name, prev[name], next[name]);
  }
}

function applyProp(dom, name, before, after) {
  if (name === 'className') {
    dom.className = after ?? '';
    return;
  }
  if (name === 'style') {
    applyStyle(dom, before, after);
    return;
  }
  if (name === 'dataset') {
    applyDataset(dom, before, after);
    return;
  }
  if (name.length > 2 && name.startsWith('on') && name[2] === name[2].toUpperCase()) {
    applyEvent(dom, name.slice(2).toLowerCase(), after);
    return;
  }
  setAttribute(dom, name, after);
}

function applyStyle(dom, before, after) {
  const previous = before ?? {};
  const next = after ?? {};
  for (const key of Object.keys(previous)) {
    if (!(key in next)) {
      dom.style[key] = '';
    }
  }
  for (const [key, value] of Object.entries(next)) {
    dom.style[key] = value;
  }
}

function applyDataset(dom, before, after) {
  const previous = before ?? {};
  const next = after ?? {};
  for (const key of Object.keys(previous)) {
    if (!(key in next)) {
      delete dom.dataset[key];
    }
  }
  for (const [key, value] of Object.entries(next)) {
    dom.dataset[key] = String(value);
  }
}

function applyEvent(dom, event, handler) {
  const handlers = dom.__straboHandlers ?? (dom.__straboHandlers = new Map());
  const existing = handlers.get(event);
  if (existing) {
    dom.removeEventListener(event, existing);
  }
  if (typeof handler === 'function') {
    dom.addEventListener(event, handler);
    handlers.set(event, handler);
  } else {
    handlers.delete(event);
  }
}

function setAttribute(dom, name, value) {
  if (value === null || value === undefined || value === false) {
    dom.removeAttribute(name);
    return;
  }
  if (value === true) {
    dom.setAttribute(name, '');
    return;
  }
  dom.setAttribute(name, String(value));
}
