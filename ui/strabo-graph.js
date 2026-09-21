/**
 * Graph model for the Strabo browser app: API path, node shapes, Cytoscape element
 * building, traversal (adjacency, neighbourhood, path), drill-down, and the per-node and
 * per-edge facts the inspector shows.
 *
 * Pure functions only: no DOM, no Cytoscape, no fetch.
 */

export const API_PATH = '/api/strabo';

export const MIN_DIAMETER = 22;
export const MAX_DIAMETER = 62;

export const SHAPES = {
  module: 'round-rectangle',
  test: 'diamond',
  entry: 'star',
  service: 'hexagon',
  topic: 'ellipse',
  queue: 'rectangle',
  table: 'barrel',
  entity: 'round-tag',
  schema: 'round-diamond',
};

export function hash(value) {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(result);
}

/** The first path segment, or `.` for a file at the repository root. */
export function topLevelDirectory(id) {
  const value = String(id ?? '');
  const slash = value.indexOf('/');
  return slash === -1 ? '.' : value.slice(0, slash);
}

/**
 * Everything the Module Passport shows for a node.
 *
 * Metrics come from the server-computed view model; imports and used-by come from the
 * evidence edges. Per-function detail is loaded separately from `/symbols` (see
 * `renderFunctions`), because it is extracted on demand rather than during the scan.
 */
export function passportFor(model, id) {
  const node = (model.nodes ?? []).find((candidate) => candidate.id === id);
  if (!node) {
    return null;
  }
  const edges = model.edges ?? [];
  const imports = edges
    .filter((edge) => edge.source === id)
    .map((edge) => ({ id: edge.target, line: edge.evidence?.line, specifier: edge.evidence?.specifier }));
  const usedBy = edges
    .filter((edge) => edge.target === id)
    .map((edge) => ({ id: edge.source, line: edge.evidence?.line, specifier: edge.evidence?.specifier }));

  const metrics = [
    { label: 'Direct importers', value: usedBy.length },
    { label: 'Blast radius', value: node.transitiveDependents ?? 0 },
    { label: 'Direct imports', value: imports.length },
    { label: 'Depends on (all)', value: node.transitiveDependencies ?? 0 },
  ];
  // A System-view unit carries its component and shelf counts where a file carries none.
  if (typeof node.files === 'number') {
    metrics.push({ label: 'Files', value: node.files });
  }
  if (typeof node.periphery === 'number' && node.periphery > 0) {
    metrics.push({ label: 'Support files', value: node.periphery });
  }

  return {
    id: node.id,
    kind: node.kind,
    // The "why grouped" caption a System-view unit carries; absent on file nodes.
    why: node.why,
    metrics,
    imports,
    usedBy,
  };
}

/** Counts for the tests / components strip, in file, block, or system mode. */
export function mapCounts(model) {
  const isBlock = model.prefixLength !== undefined || model.system === true;
  const byKey = new Map();
  let tests = 0;
  let modules = 0;

  for (const node of model.nodes ?? []) {
    if (node.kind === 'test') {
      tests += 1;
    } else {
      modules += 1;
    }
    const key = isBlock ? String(node.id) : topLevelDirectory(node.id);
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }

  const entries = [...byKey.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({
      label: key,
      count,
      // Block ids are whole directories; file ids filter by their directory prefix.
      filter: key === '.' ? '' : isBlock ? key : `${key}/`,
    }));

  return { tests, modules, entries };
}

/**
 * Text for the "Reading the map" visual key.
 *
 * Keyboard gestures moved to the shortcut sheet (`?`), so this box states only what the
 * drawing encodes and how to read it.
 */
export function readingLegend(model) {
  if (model?.system) {
    return ['box = build unit', 'size = files', 'edge = import between units'];
  }
  return ['size = dependents', 'island = directory', 'diamond = test', 'star = entry'];
}

/** The shortcut sheet shown on `?`: gestures, not encodings. */
export function shortcutSheet() {
  return [
    { keys: 'F', action: 'Focus the selection' },
    { keys: 'I', action: 'Trace change impact' },
    { keys: 'P', action: 'Start a path between two nodes' },
    { keys: 'B', action: 'Toggle directories / files' },
    { keys: 'T', action: 'Timeline' },
    { keys: 'R', action: 'Review working-tree changes' },
    { keys: 'V', action: 'Dependency risk' },
    { keys: 'G', action: 'Delegate a selected group' },
    { keys: '⌘K / ctrl-K', action: 'Filter paths' },
    { keys: 'Esc', action: 'Clear the selection or close a panel' },
    { keys: '?', action: 'Show this sheet' },
    { keys: 'hover a node', action: 'Report its blast radius' },
    { keys: '⌘/ctrl-click, shift-drag', action: 'Select a group' },
  ];
}

/** Square-root transform keeps leaf nodes visible without one hub consuming the map. */
export function diameter(transitiveDependents) {
  const scaled = Math.sqrt(Math.max(0, transitiveDependents ?? 0)) * 6 + MIN_DIAMETER;
  return Math.max(MIN_DIAMETER, Math.min(MAX_DIAMETER, Math.round(scaled)));
}

/**
 * Build the `/graph` query string for the current view state.
 *
 * Refresh is a server cache bypass (`refresh=1`), not a repaint. Block mode sends the
 * drill-down prefix so the server rolls up relative to it.
 */
export function buildGraphQuery(state, options = {}) {
  const params = new URLSearchParams();
  if (state.repository) {
    params.set('repository', state.repository);
  }
  if (options.refresh) {
    params.set('refresh', '1');
  }
  if (state.mode === 'system') {
    params.set('system', '1');
  } else if (state.mode === 'block') {
    params.set('blockDepth', String(state.depth ?? 1));
    if (state.prefix) {
      params.set('blockPrefix', state.prefix);
    }
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Join API nodes to metrics and positions. */
export function buildElements(model) {
  const positions = new Map((model.positions ?? []).map((position) => [position.id, position]));
  const hubs = new Set(model.hubs ?? []);

  const nodes = (model.nodes ?? []).map((node) => ({
    group: 'nodes',
    classes: `kind-${node.kind}`,
    data: {
      id: node.id,
      // A block node has no path tail to fall back on, so the server's compressed,
      // unit-anchored label is preferred before the bare last segment.
      label: node.label ?? model.directoryLabels?.[node.id] ?? node.id.split('/').pop(),
      path: node.id,
      kind: node.kind,
      // Fill is one neutral surface for every node; directory is carried by position
      // (the island plates), never by hue. See Phase 13 M1. A System-view unit sizes by
      // its component count instead of blast radius.
      diameter: diameter(node.size ?? node.files ?? node.transitiveDependents),
      hub: hubs.has(node.id),
    },
    position: positionOf(positions.get(node.id)),
  }));

  const edges = (model.edges ?? []).map((edge, index) => ({
    group: 'edges',
    data: {
      id: `e${index}`,
      source: edge.source,
      target: edge.target,
      semanticSource: edge.semanticSource ?? edge.source,
      semanticTarget: edge.semanticTarget ?? edge.target,
      kind: edge.kind,
      evidenceLine: edge.evidence?.line,
      evidenceSpecifier: edge.evidence?.specifier,
    },
  }));

  return { nodes, edges };
}

/** Cytoscape positions are `{ x, y }`; never leak the `id` field from the API. */
function positionOf(position) {
  return position ? { x: position.x, y: position.y } : { x: 0, y: 0 };
}

/**
 * Diff two element lists by their data id so a re-render touches only what changed.
 *
 * `added` carries the new definitions, `updated` carries `{ before, after }` pairs (the
 * caller needs `before` to swap the old classes without dropping the ones applied since the
 * last render), and `removed` is the list of ids that are gone. Two elements are "equal"
 * when their builder output matches: classes, data, and position.
 */
export function diffElements(previous = [], next = []) {
  const before = new Map(previous.map((element) => [element.data.id, element]));
  const added = [];
  const updated = [];
  for (const element of next) {
    const id = element.data.id;
    const prior = before.get(id);
    if (!prior) {
      added.push(element);
      continue;
    }
    before.delete(id);
    if (elementSignature(prior) !== elementSignature(element)) {
      updated.push({ before: prior, after: element });
    }
  }
  return { added, removed: [...before.keys()], updated };
}

/** Diff a `{ nodes, edges }` pair from {@link buildElements}. */
export function diffGraph(previous = { nodes: [], edges: [] }, next = { nodes: [], edges: [] }) {
  return {
    nodes: diffElements(previous.nodes, next.nodes),
    edges: diffElements(previous.edges, next.edges),
  };
}

function elementSignature(element) {
  return JSON.stringify({
    classes: element.classes ?? '',
    data: element.data,
    position: element.position ?? null,
  });
}

export function adjacency(model) {
  const forward = new Map();
  const backward = new Map();
  const push = (map, key, value) => {
    const list = map.get(key);
    if (list) {
      list.push(value);
    } else {
      map.set(key, [value]);
    }
  };
  for (const edge of model.edges ?? []) {
    push(forward, edge.source, edge.target);
    push(backward, edge.target, edge.source);
  }
  return { forward, backward };
}

/** The selected node plus its immediate neighbours, in either direction. */
export function neighbourhood(model, id, depth = 1) {
  const { forward, backward } = adjacency(model);
  const seen = new Set([id]);
  let frontier = [id];
  for (let step = 0; step < depth; step += 1) {
    const next = [];
    for (const current of frontier) {
      for (const neighbour of [...(forward.get(current) ?? []), ...(backward.get(current) ?? [])]) {
        if (!seen.has(neighbour)) {
          seen.add(neighbour);
          next.push(neighbour);
        }
      }
    }
    frontier = next;
  }
  return [...seen];
}

/** Directed path, breadth-first. Returns null to report no path explicitly. */
export function findPath(model, from, to, maxHops = 12) {
  const { forward } = adjacency(model);
  const queue = [{ id: from, path: [from] }];
  const visited = new Set([from]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current.id === to) {
      return current.path;
    }
    if (current.path.length > maxHops) {
      continue;
    }
    for (const neighbour of forward.get(current.id) ?? []) {
      if (visited.has(neighbour)) {
        continue;
      }
      visited.add(neighbour);
      queue.push({ id: neighbour, path: [...current.path, neighbour] });
    }
  }
  return null;
}

/** Breadcrumb segments for the current block prefix, root last. */
export function breadcrumb(state) {
  if (state.mode !== 'block') {
    return [];
  }
  const crumbs = [{ label: 'repository', prefix: '' }];
  const segments = (state.prefix ?? '').split('/').filter(Boolean);
  segments.forEach((segment, index) => {
    crumbs.push({ label: segment, prefix: segments.slice(0, index + 1).join('/') });
  });
  return crumbs;
}

/** Summarise diagnostics and exclusions for the diagnostics panel. */
export function summarizeDiagnostics(model) {
  const byKind = {};
  for (const diagnostic of model.diagnostics ?? []) {
    byKind[diagnostic.kind] = (byKind[diagnostic.kind] ?? 0) + 1;
  }
  const excludedByReason = {};
  for (const exclusion of model.excluded ?? []) {
    excludedByReason[exclusion.reason] = (excludedByReason[exclusion.reason] ?? 0) + 1;
  }
  return {
    diagnostics: (model.diagnostics ?? []).length,
    excluded: (model.excluded ?? []).length,
    byKind,
    excludedByReason,
    samples: (model.diagnostics ?? []).slice(0, 50),
    // Runtime vocabulary the header no longer carries; shown in the Diagnostics panel.
    cache: model.cache?.status ?? 'unknown',
    stale: Boolean(model.cache?.stale),
  };
}

/** Case-insensitive substring filter over node ids. Hidden nodes must not eat label budget. */
export function filterNodes(model, text) {
  const needle = text.trim().toLowerCase();
  if (!needle) {
    return model.nodes.map((node) => node.id);
  }
  return model.nodes.filter((node) => node.id.toLowerCase().includes(needle)).map((node) => node.id);
}

/**
 * Why an edge exists, from the evidence the scanner recorded.
 *
 * Returns null for an unknown id so the caller can stay silent instead of inventing an
 * explanation. `resolution` is rendered as a human label, never re-derived.
 */
export function edgeEvidenceFor(model, edgeId) {
  const edge = (model.edges ?? []).find((candidate, index) => `e${index}` === edgeId);
  if (!edge) {
    return null;
  }
  const evidence = edge.evidence ?? {};
  return {
    id: edgeId,
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    line: evidence.line ?? null,
    specifier: evidence.specifier ?? null,
    resolution: evidence.resolution ?? null,
    resolutionLabel: RESOLUTION_LABELS[evidence.resolution] ?? 'not recorded',
  };
}

const RESOLUTION_LABELS = {
  exact: 'exact match',
  extension: 'extension added',
  index: 'index file',
  'index-of-package': 'package member',
  'module-tree': 'module tree',
  'index-packed': 'packed index',
  alias: 'path alias',
  root: 'repo root',
  'subpath-import': 'package subpath',
};

/**
 * Counts for the header.
 *
 * Internal vocabulary (`cache: miss`, renderer, excluded/diagnostic counts) lives in the
 * Diagnostics panel; the header states what the map holds and stops there.
 */
export function graphSummary(model) {
  const nodes = (model.nodes ?? []).length;
  const edges = (model.edges ?? []).length;
  return `${nodes} nodes · ${edges} edges`;
}
