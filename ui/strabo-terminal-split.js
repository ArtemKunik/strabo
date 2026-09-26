/**
 * The split-pane layout model for the terminal screen.
 *
 * A binary tree: leaves are panes, splits carry a direction and a ratio. The tree is pure
 * data and every operation returns a new tree, so the DOM layer only renders what the model
 * says and unit tests can exercise the geometry without a browser. A `row` split puts its two
 * children side by side (a vertical divider); a `column` split stacks them (a horizontal
 * divider). `horizontal`/`vertical` are accepted as aliases so callers can use either name.
 *
 * A leaf's `sessionId` is null until a tab is bound to that pane, so a freshly split pane is
 * an empty slot the orchestrator can fill without inventing a session.
 *
 * Pure functions only: no DOM, no xterm, no fetch.
 */

const MIN_RATIO = 0.05;
const MAX_RATIO = 0.95;
const DEFAULT_RATIO = 0.5;
const DEFAULT_SPLITTER = 6;

/** Normalise the two accepted spellings onto the internal `row`/`column` pair. */
export function normalizeDirection(direction) {
  return direction === 'column' || direction === 'vertical' ? 'column' : 'row';
}

/** A layout with a single empty pane. */
export function createLayout(paneId = 'pane-1') {
  return { type: 'leaf', paneId };
}

export function isLeaf(node) {
  return Boolean(node) && node.type === 'leaf';
}

/** Map every node through `fn`, rebuilding the tree. `fn` must return a node. */
export function mapTree(node, fn) {
  if (!node) {
    return node;
  }
  const mapped = fn(node);
  if (mapped.type !== 'split') {
    return mapped;
  }
  return { ...mapped, a: mapTree(mapped.a, fn), b: mapTree(mapped.b, fn) };
}

/** Replace exactly one leaf, reporting whether it was found. */
function replaceLeaf(node, paneId, build) {
  if (!node) {
    return { node: null, found: false };
  }
  if (node.type === 'leaf') {
    return node.paneId === paneId ? { node: build(node), found: true } : { node, found: false };
  }
  const a = replaceLeaf(node.a, paneId, build);
  const b = replaceLeaf(node.b, paneId, build);
  if (!a.found && !b.found) {
    return { node, found: false };
  }
  return { node: { ...node, a: a.node, b: b.node }, found: true };
}

/** Every leaf, depth-first and left-to-right, so render order matches keyboard order. */
export function panes(root) {
  const out = [];
  const walk = (node) => {
    if (!node) {
      return;
    }
    if (node.type === 'leaf') {
      out.push(node);
      return;
    }
    walk(node.a);
    walk(node.b);
  };
  walk(root);
  return out;
}

export function paneIds(root) {
  return panes(root).map((leaf) => leaf.paneId);
}

export function countPanes(root) {
  return panes(root).length;
}

export function findPane(root, paneId) {
  return panes(root).find((leaf) => leaf.paneId === paneId) ?? null;
}

export function paneForSession(root, sessionId) {
  return panes(root).find((leaf) => leaf.sessionId === sessionId) ?? null;
}

export function firstEmptyPane(root) {
  return panes(root).find((leaf) => !leaf.sessionId) ?? null;
}

/** The ids of every pane that holds no session — the empty "No session" slots. */
export function emptyPaneIds(root) {
  return panes(root)
    .filter((leaf) => !leaf.sessionId)
    .map((leaf) => leaf.paneId);
}

/** Split `paneId` in two, returning the new tree or null when the pane is not present. */
export function splitPane(root, paneId, direction, newPaneId) {
  const result = replaceLeaf(root, paneId, (leaf) => ({
    type: 'split',
    id: `split-${newPaneId}`,
    direction: normalizeDirection(direction),
    ratio: DEFAULT_RATIO,
    a: leaf,
    b: { type: 'leaf', paneId: newPaneId, sessionId: null },
  }));
  return result.found ? result.node : null;
}

/** Bind (or clear, with a null `sessionId`) the session shown by one pane. */
export function setPaneSession(root, paneId, sessionId) {
  const result = replaceLeaf(root, paneId, (leaf) => ({ ...leaf, sessionId: sessionId ?? null }));
  return result.found ? result.node : root;
}

/** Clear a session from every pane it is shown in; used when a session is killed. */
export function detachSession(root, sessionId) {
  return mapTree(root, (node) =>
    node.type === 'leaf' && node.sessionId === sessionId ? { ...node, sessionId: null } : node,
  );
}

/**
 * Close a pane. The parent split collapses into its surviving child, so no empty split is
 * left behind. Returns the new tree, or null when the closed pane was the last one.
 */
export function closePane(root, paneId) {
  const close = (node) => {
    if (!node) {
      return { node: null, changed: false };
    }
    if (node.type === 'leaf') {
      return node.paneId === paneId ? { node: null, changed: true } : { node, changed: false };
    }
    const a = close(node.a);
    const b = close(node.b);
    if (!a.changed && !b.changed) {
      return { node, changed: false };
    }
    if (!a.node) {
      return { node: b.node, changed: true };
    }
    if (!b.node) {
      return { node: a.node, changed: true };
    }
    return { node: { ...node, a: a.node, b: b.node }, changed: true };
  };
  const result = close(root);
  return result.changed ? result.node : null;
}

/** Set a split's ratio, clamped so a pane can never be dragged to zero width. */
export function setRatio(root, splitId, ratio) {
  const value = Number(ratio);
  const clamped = Number.isFinite(value) ? Math.min(Math.max(value, MIN_RATIO), MAX_RATIO) : DEFAULT_RATIO;
  return mapTree(root, (node) => (node.type === 'split' && node.id === splitId ? { ...node, ratio: clamped } : node));
}

/**
 * Move one pane beside another, used by drag-to-split. Removing the source first means the
 * tree always collapses cleanly; if the target lived inside the removed subtree the move is
 * refused rather than resurrecting a detached pane.
 */
export function movePane(root, paneId, targetPaneId, direction, newPaneId = paneId) {
  if (!paneId || !targetPaneId || paneId === targetPaneId || !findPane(root, targetPaneId)) {
    return root;
  }
  const without = closePane(root, paneId);
  if (!without || !findPane(without, targetPaneId)) {
    return root;
  }
  return splitPane(without, targetPaneId, direction, newPaneId) ?? root;
}

/**
 * Lay a tree out inside a rectangle, in pixels.
 *
 * The splitter thickness is carved out of the split's inner span before the ratio applies,
 * so the two children plus the divider always fill the parent exactly. This is the pure
 * geometry the DOM mirrors with flex-basis; tests read it directly.
 */
export function geometry(root, rect = {}, { splitter = DEFAULT_SPLITTER } = {}) {
  const out = [];
  const visit = (node, area) => {
    if (!node) {
      return;
    }
    if (node.type === 'leaf') {
      out.push({ paneId: node.paneId, ...area });
      return;
    }
    if (node.direction === 'row') {
      const inner = Math.max(0, area.width - splitter);
      const first = Math.max(0, Math.round(inner * node.ratio));
      const second = Math.max(0, inner - first);
      visit(node.a, { x: area.x, y: area.y, width: first, height: area.height });
      visit(node.b, { x: area.x + first + splitter, y: area.y, width: second, height: area.height });
      return;
    }
    const inner = Math.max(0, area.height - splitter);
    const first = Math.max(0, Math.round(inner * node.ratio));
    const second = Math.max(0, inner - first);
    visit(node.a, { x: area.x, y: area.y, width: area.width, height: first });
    visit(node.b, { x: area.x, y: area.y + first + splitter, width: area.width, height: second });
  };
  visit(root, {
    x: Number.isFinite(rect.x) ? rect.x : 0,
    y: Number.isFinite(rect.y) ? rect.y : 0,
    width: Number.isFinite(rect.width) ? rect.width : 0,
    height: Number.isFinite(rect.height) ? rect.height : 0,
  });
  return out;
}

/**
 * Validate a layout read back from localStorage.
 *
 * Storage is untrusted: a corrupt tree, a duplicate pane id, or a stray value must never
 * reach the renderer, so anything unusable falls back to a single empty pane.
 */
export function sanitizeLayout(value, fallbackPaneId = 'pane-1') {
  const seen = new Set();
  const parse = (node) => {
    if (!node || typeof node !== 'object') {
      return null;
    }
    if (node.type === 'leaf') {
      const paneId = typeof node.paneId === 'string' && node.paneId ? node.paneId : null;
      if (!paneId || seen.has(paneId)) {
        return null;
      }
      seen.add(paneId);
      return {
        type: 'leaf',
        paneId,
        sessionId: typeof node.sessionId === 'string' ? node.sessionId : null,
      };
    }
    if (node.type === 'split') {
      const a = parse(node.a);
      const b = parse(node.b);
      if (!a || !b) {
        return null;
      }
      const ratio = Number.isFinite(node.ratio)
        ? Math.min(Math.max(node.ratio, MIN_RATIO), MAX_RATIO)
        : DEFAULT_RATIO;
      const id = typeof node.id === 'string' && node.id ? node.id : `split-${a.type === 'leaf' ? a.paneId : 'b'}`;
      return { type: 'split', id, direction: normalizeDirection(node.direction), ratio, a, b };
    }
    return null;
  };
  return parse(value) ?? createLayout(fallbackPaneId);
}
