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

/** A System-view unit is a card, not a file dot: bigger floor and ceiling, square-root size. */
export const MIN_UNIT_DIAMETER = 48;
export const MAX_UNIT_DIAMETER = 130;
export const MIN_SHELF_DIAMETER = 26;
export const MAX_SHELF_DIAMETER = 64;

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
  // System-view roll-ups: a build unit is a card, its folded support shelf a footer strip.
  unit: 'round-rectangle',
  shelf: 'rectangle',
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
  // One row per file, not per recorded edge: a call edge sits beside its import, and a file
  // may be imported on several lines. Counting edges would report references as importers,
  // so a count could outrun the distinct-file blast radius it is meant to sit under. A
  // `declare` edge (a barrel re-export) is left out, matching the server's use-edge metrics.
  const imports = distinctByFile(
    edges.filter((edge) => edge.source === id).map((edge) => edgeEntry(edge.target, edge)),
  );
  const usedBy = distinctByFile(
    edges.filter((edge) => edge.target === id).map((edge) => edgeEntry(edge.source, edge)),
  );

  const metrics = [{ label: 'Direct importers', value: usedBy.length, unit: 'files' }];
  if (typeof node.systemUnit === 'string' && !node.id.endsWith('#support')) {
    // L17: at L1 the blast radius reports the in-unit count first, the outside count apart.
    metrics.push(
      { label: 'Blast radius in unit', value: node.inUnitDependents ?? 0 },
      { label: 'Blast radius outside', value: node.outsideDependents ?? 0 },
    );
  } else {
    metrics.push({ label: 'Blast radius', value: node.transitiveDependents ?? 0, unit: 'files' });
  }
  metrics.push(
    { label: 'Direct imports', value: imports.length, unit: 'files' },
    { label: 'Depends on (all)', value: node.transitiveDependencies ?? 0, unit: 'files' },
  );
  if (typeof node.lines === 'number') {
    metrics.push({ label: 'Lines', value: node.lines });
  }
  // A System-view unit carries its component and shelf counts where a file carries none.
  if (typeof node.files === 'number') {
    metrics.push({ label: 'Files', value: node.files });
  }
  if (typeof node.periphery === 'number' && node.periphery > 0) {
    metrics.push({ label: 'Support files', value: node.periphery });
  }
  // A unit card carries facts a file does not: its size, layers, reach, and coupling (L22).
  const card = node.kind === 'unit' ? (model.unitCards ?? []).find((entry) => entry.id === node.id) : undefined;
  if (card) {
    metrics.push(
      { label: 'Lines', value: card.loc },
      { label: 'Layers', value: card.layers.length },
      { label: 'Test reach', value: `${card.testReach.reached}/${card.testReach.total}` },
      { label: 'Depends on units', value: card.dependsOn },
      { label: 'Used by units', value: card.usedBy },
    );
    if (card.hotspots !== null) {
      metrics.push({ label: 'Hotspots', value: card.hotspots });
    }
  }
  if (node.shelf) {
    metrics.push({ label: 'Tests', value: node.shelf.test }, { label: 'Scripts', value: node.shelf.script });
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

/** One dependency row: the neighbour file plus the edge's recorded evidence. */
function edgeEntry(id, edge) {
  return {
    id,
    line: edge.evidence?.line,
    specifier: edge.evidence?.specifier,
    role: edge.role,
  };
}

/**
 * Collapse dependency rows to one per file, over use edges only.
 *
 * `declare` edges (a barrel re-export) describe the module tree rather than a dependency,
 * so they are left out to keep the rows and the counts on the same footing as blast radius.
 */
function distinctByFile(entries) {
  const byFile = new Map();
  for (const entry of entries) {
    if (entry.role === 'declare' || byFile.has(entry.id)) {
      continue;
    }
    byFile.set(entry.id, entry);
  }
  return [...byFile.values()];
}

/**
 * The "Changes with" partners for one file, from an `/analysis/co-change` report.
 *
 * Only edges with a listable commit are returned, heavy pairs first, and every partner
 * carries the exact commits behind it. A pair outside the report yields an empty list, so
 * the passport can say so rather than showing an invented relationship.
 */
export function coChangePartnersFor(report, file, limit = 20) {
  const edges = (report?.edges ?? []).filter(
    (edge) =>
      (edge.source === file || edge.target === file) &&
      Array.isArray(edge.commits) &&
      edge.commits.length > 0,
  );
  return edges
    .sort(
      (a, b) =>
        (b.commitsShared ?? 0) - (a.commitsShared ?? 0) ||
        (a.source === file ? a.target : a.source).localeCompare(
          b.source === file ? b.target : b.source,
        ),
    )
    .slice(0, limit)
    .map((edge) => ({
      file: edge.source === file ? edge.target : edge.source,
      hidden: edge.hidden === true,
      ratio: edge.ratio,
      commitsShared: edge.commitsShared ?? edge.commits.length,
      commits: edge.commits,
    }));
}

/** Counts for the tests / components strip, in file, block, or system mode. */
export function mapCounts(model) {  const isBlock = model.prefixLength !== undefined || model.system === true;
  const byKey = new Map();
  let tests = 0;
  let modules = 0;

  for (const node of model.nodes ?? []) {
    if (node.kind === 'test') {
      tests += 1;
    } else {
      modules += 1;
    }
    // A System drill-down lists the open unit's layers, not one chip per file.
    const key = model.systemUnit
      ? node.collapsed
        ? 'outside units'
        : node.systemLayer ?? 'unit'
      : isBlock
        ? String(node.id)
        : topLevelDirectory(node.id);
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }

  const entries = [...byKey.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({
      label: key,
      count,
      // Block ids are whole directories; file ids filter by their directory prefix.
      filter: key === '.' ? '' : isBlock && !model.systemUnit ? key : `${key}/`,
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
  if (model?.systemUnit) {
    return [
      'box = unit frame',
      'lane = layer',
      'edge = selected file import',
      'badge = files in another unit',
      'tag = support shelf',
    ];
  }
  if (model?.system) {
    return [
      'box = build unit',
      'size = files',
      'edge = import between units',
      'support = unit footer',
    ];
  }
  return ['size = dependents', 'island = directory', 'diamond = test', 'star = entry'];
}

/** The shortcut sheet shown on `?`: gestures, not encodings. */
export function shortcutSheet() {
  return [
    { keys: 'F', action: 'Center the selection' },
    { keys: 'I', action: 'Show change impact' },
    { keys: 'O', action: 'Show the selected file’s links to other units' },
    { keys: 'P', action: 'Trace a path between two nodes' },
    { keys: 'B', action: 'Toggle directories / files' },
    { keys: 'L', action: 'Show a file name under every file' },
    { keys: 'C', action: 'Show recorded function calls instead of imports' },
    { keys: 'H', action: 'Show co-change coupling (commits that changed files together)' },
    { keys: 'S', action: 'View the selected file’s source' },
    { keys: 'T', action: 'Timeline' },
    { keys: 'N', action: 'Branches' },
    { keys: 'R', action: 'Review working-tree changes' },
    { keys: 'V', action: 'Dependency risk' },
    { keys: 'G', action: 'Delegate the selected files' },
    { keys: '⌘K / ctrl-K', action: 'Filter paths' },
    { keys: 'Esc', action: 'Clear the selection or close a panel' },
    { keys: '?', action: 'Show this sheet' },
    { keys: 'hover a node', action: 'Report its blast radius' },
    { keys: '⌘/ctrl-click, shift-drag', action: 'Select a group' },
  ];
}

/** Text for a unit's hover card: unit vocabulary, no blast radius, no `#` ids (L20). */
export function unitHoverFacts(model, id) {
  const card = (model?.unitCards ?? []).find((entry) => entry.id === id);
  if (!card) {
    return null;
  }
  return {
    title: `${card.ecosystem} package \`${card.name}\``,
    rows: [
      `${card.files} files`,
      `depends on ${card.dependsOn} unit${card.dependsOn === 1 ? '' : 's'}`,
      `used by ${card.usedBy} unit${card.usedBy === 1 ? '' : 's'}`,
      `why: ${card.manifest ?? card.why}`,
    ],
  };
}

/** A shelf's hover card: "74 test files, 6 scripts: folded support" (L20). */
export function shelfHoverText(shelf) {
  if (!shelf) {
    return 'support files';
  }
  const tests = `${shelf.test} test file${shelf.test === 1 ? '' : 's'}`;
  const scripts = `${shelf.script} script${shelf.script === 1 ? '' : 's'}`;
  return `${tests}, ${scripts}: folded support`;
}

/** The shelf footer strip caption; empty when the unit folds no support (L21). */
export function shelfStripText(shelf) {
  if (!shelf || shelf.total === 0) {
    return '';
  }
  const parts = [];
  if (shelf.test) parts.push(`${shelf.test} test${shelf.test === 1 ? '' : 's'}`);
  if (shelf.script) parts.push(`${shelf.script} script${shelf.script === 1 ? '' : 's'}`);
  if (shelf.generated) parts.push(`${shelf.generated} generated`);
  if (shelf.fixture) parts.push(`${shelf.fixture} fixture${shelf.fixture === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/**
 * Fill each card's hotspot count from the function hotspot report (L22).
 *
 * Hotspots need the function analysis, so the server leaves them null; the browser joins
 * the report it already fetches for the hotspot overlay. A hotspot belongs to the longest
 * unit id that prefixes its file (the root unit `.` is the fallback).
 */
export function withUnitHotspots(cards, report) {
  const list = cards ?? [];
  const byPrefix = list.map((card) => card.id).sort((a, b) => b.length - a.length);
  const counts = new Map(list.map((card) => [card.id, 0]));
  for (const spot of report?.hotspots ?? []) {
    const owner = byPrefix.find(
      (id) => id === '.' || spot.file === id || spot.file.startsWith(`${id}/`),
    );
    if (owner !== undefined) {
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
  }
  return list.map((card) => ({ ...card, hotspots: counts.get(card.id) ?? 0 }));
}

/** Square-root transform keeps leaf nodes visible without one hub consuming the map. */
export function diameter(transitiveDependents) {
  const scaled = Math.sqrt(Math.max(0, transitiveDependents ?? 0)) * 6 + MIN_DIAMETER;
  return Math.max(MIN_DIAMETER, Math.min(MAX_DIAMETER, Math.round(scaled)));
}

/**
 * Stroke width for an edge, widening with the recorded import count.
 *
 * A System-view edge rolls many file imports into one unit pair, so the count is the
 * weight: one import is the base hairline and each doubling adds a step, capped so a
 * heavily-coupled pair cannot draw a bar across the map. A file edge has no weight and
 * stays the base hairline.
 */
export function edgeStrokeWidth(weight) {
  const count = Number.isFinite(weight) && weight > 0 ? weight : 1;
  return Math.min(4, 1.2 + Math.log2(count) * 0.9);
}

/** A unit's area grows with its file count on a square-root scale, with a floor (L18). */
export function unitDiameter(files) {
  const scaled = Math.sqrt(Math.max(0, files ?? 0)) * 7 + MIN_UNIT_DIAMETER;
  return Math.max(MIN_UNIT_DIAMETER, Math.min(MAX_UNIT_DIAMETER, Math.round(scaled)));
}

/** A shelf tag is deliberately smaller than its unit: it is a footnote, not a component. */
export function shelfDiameter(files) {
  const scaled = Math.sqrt(Math.max(0, files ?? 0)) * 8 + MIN_SHELF_DIAMETER;
  return Math.max(MIN_SHELF_DIAMETER, Math.min(MAX_SHELF_DIAMETER, Math.round(scaled)));
}

/** The diameter a node draws at: a unit/shelf by file count, a file by blast radius. */
export function nodeDiameter(node) {
  if (node?.kind === 'unit') return unitDiameter(node.files ?? node.size);
  if (node?.kind === 'shelf') return shelfDiameter(node.files);
  return diameter(node?.size ?? node?.files ?? node?.transitiveDependents);
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
    if (state.systemUnit) {
      params.set('systemUnit', state.systemUnit);
      if (state.showOutside) {
        params.set('outside', '1');
        if (state.unitFile) {
          params.set('selected', state.unitFile);
        }
        if (state.expandedUnits?.length) {
          params.set('expanded', state.expandedUnits.join(','));
        }
      }
    }
  } else if (state.mode === 'block') {
    params.set('blockDepth', String(state.depth ?? 1));
    if (state.prefix) {
      params.set('blockPrefix', state.prefix);
    }
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * Ids whose bare file name is shared with another file node.
 *
 * `mod.rs` or `types.rs` says nothing when a dozen directories hold one, so those labels
 * carry their parent directory. Only plain path ids qualify: a block or unit node already
 * has a server-supplied label, and a `#support` roll-up is not a file.
 */
function ambiguousFileIds(model) {
  const byName = new Map();
  for (const node of model.nodes ?? []) {
    if (node.label || model.directoryLabels?.[node.id] || node.kind === 'unit' || node.kind === 'shelf') {
      continue;
    }
    const segments = node.id.split('/');
    if (segments.length < 2) {
      continue;
    }
    const name = segments[segments.length - 1];
    const ids = byName.get(name);
    if (ids) ids.push(node.id);
    else byName.set(name, [node.id]);
  }
  return new Set([...byName.values()].filter((ids) => ids.length > 1).flat());
}

/** `parent/name` for a path id: enough to tell `portfolio/types.rs` from `market/types.rs`. */
function qualifiedName(id) {
  return id.split('/').slice(-2).join('/');
}

/** Join API nodes to metrics and positions. */
export function buildElements(model) {
  const positions = new Map((model.positions ?? []).map((position) => [position.id, position]));
  const hubs = new Set(model.hubs ?? []);
  const ambiguous = ambiguousFileIds(model);

  const nodes = (model.nodes ?? []).map((node) => ({
    group: 'nodes',
    classes: `kind-${node.kind}`,
    data: {
      id: node.id,
      // A block node has no path tail to fall back on, so the server's compressed,
      // unit-anchored label is preferred before the bare last segment.
      label:
        node.label ??
        model.directoryLabels?.[node.id] ??
        (ambiguous.has(node.id) ? qualifiedName(node.id) : node.id.split('/').pop()),
      path: node.id,
      kind: node.kind,
      // Fill is one neutral surface for every node; directory is carried by position
      // (the island plates), never by hue. See Phase 13 M1. A System-view unit sizes by
      // its component count instead of blast radius; the hub ring is reserved for files,
      // so a unit's only outline is selection (L18).
      diameter: nodeDiameter(node),
      hub: hubs.has(node.id) && node.kind !== 'unit' && node.kind !== 'shelf',
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
      // A System-view unit edge rolls up a file count; the stroke widens with it.
      weight: edge.weight ?? 1,
      edgeWidth: edgeStrokeWidth(edge.weight),
      evidenceLine: edge.evidence?.line,
      evidenceSpecifier: edge.evidence?.specifier,
      // In a System drill-down, `unit` edges are hidden until their file is selected;
      // `outside` edges are the L17 links and stay visible.
      scope: edge.scope,
      // A co-change edge is drawn only in the off-by-default coupling lens, as a dashed
      // relationship; the true value keeps the lens able to hide it without dropping it.
      coChange: edge.coChange === true,
    },
  }));

  return { nodes, edges };
}

/**
 * Build the `{ nodes, edges }` pair for the co-change lens from an `/analysis/co-change`
 * report. Edges run between files already in the graph; a report naming a file outside it
 * is skipped rather than inventing a node. The commit count rides on the stroke and the
 * evidence rides on the data, so an edge is never drawn without a listable commit.
 */
export function buildCoChangeElements(model, report, startIndex = 0) {
  const ids = new Set((model.nodes ?? []).map((node) => node.id));
  const edges = [];
  (report?.edges ?? []).forEach((edge, offset) => {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      return;
    }
    if (!Array.isArray(edge.commits) || edge.commits.length === 0) {
      return;
    }
    edges.push({
      group: 'edges',
      data: {
        id: `coh${startIndex + offset}`,
        source: edge.source,
        target: edge.target,
        semanticSource: edge.source,
        semanticTarget: edge.target,
        kind: 'co-change',
        weight: edge.commitsShared ?? edge.commits.length,
        edgeWidth: edgeStrokeWidth(edge.commitsShared ?? edge.commits.length),
        evidenceLine: null,
        evidenceSpecifier: `${edge.commitsShared} shared commit(s)`,
        scope: undefined,
        coChange: true,
        hidden: edge.hidden === true,
        ratio: edge.ratio,
        commitsShared: edge.commitsShared,
        commits: edge.commits,
      },
    });
  });
  return edges;
}

/**
 * Build the hidden-coupling-only edge set for the K3 lens.
 *
 * Only pairs the co-change report flagged `hidden` (no import path in either direction) and
 * that carry a listable commit are drawn, with a distinct `kind` so the stylesheet can draw
 * them differently from the general co-change lens. Off by default: it is applied only when
 * the hidden-coupling review overlay is the active lens.
 */
export function buildHiddenCouplingElements(model, report, startIndex = 0) {
  const ids = new Set((model.nodes ?? []).map((node) => node.id));
  const edges = [];
  (report?.edges ?? []).forEach((edge, offset) => {
    if (edge.hidden !== true) {
      return;
    }
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      return;
    }
    if (!Array.isArray(edge.commits) || edge.commits.length === 0) {
      return;
    }
    edges.push({
      group: 'edges',
      data: {
        id: `hid${startIndex + offset}`,
        source: edge.source,
        target: edge.target,
        semanticSource: edge.source,
        semanticTarget: edge.target,
        kind: 'hidden-coupling',
        weight: edge.commitsShared ?? edge.commits.length,
        edgeWidth: edgeStrokeWidth(edge.commitsShared ?? edge.commits.length),
        evidenceLine: null,
        evidenceSpecifier: `${edge.commitsShared} shared commit(s), no import path`,
        scope: undefined,
        coChange: true,
        hiddenCoupling: true,
        hidden: true,
        ratio: edge.ratio,
        commitsShared: edge.commitsShared,
        commits: edge.commits,
      },
    });
  });
  return edges;
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

/**
 * Breadcrumb segments for the current drill-down, root last.
 *
 * Block mode walks the path prefix; System mode is `System › unit` when a unit is open,
 * and a single `System` crumb at L0. File mode has no drill-down.
 */
export function breadcrumb(state) {
  if (state.mode === 'system') {
    const crumbs = [{ label: 'System', prefix: '' }];
    if (state.systemUnit) {
      crumbs.push({ label: state.systemUnitLabel ?? state.systemUnit, prefix: state.systemUnit });
    }
    return crumbs;
  }
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
    provenance: graphProvenanceFromModel(model),
  };
}

/**
 * The fingerprint and scan time behind a served graph, read from the model's cache metadata.
 *
 * The graph route carries `cache.fingerprint`, `cache.generatedAt`, and `cache.stale`; an
 * absent fingerprint yields null rather than an invented revision (T6).
 */
export function graphProvenanceFromModel(model) {
  const cache = model?.cache;
  if (!cache || !cache.fingerprint) {
    return null;
  }
  return {
    fingerprint: cache.fingerprint,
    revision: String(cache.fingerprint).split(':')[0] || null,
    scannedAt: cache.generatedAt ?? null,
    currentFingerprint: null,
    behind: null,
    stale: cache.stale === true,
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
  const nodes = (model?.nodes ?? []).length;
  const edges = (model?.edges ?? []).length;
  // A System L0 map is units, not files; the drill-down and the file map are nodes. Naming
  // the unit is what stops "45 nodes" reading as if the shelves were still peers.
  const nodeWord =
    model?.system && !model?.systemUnit
      ? nodes === 1
        ? 'unit'
        : 'units'
      : nodes === 1
        ? 'node'
        : 'nodes';
  const edgeWord = edges === 1 ? 'edge' : 'edges';
  return `${nodes} ${nodeWord} · ${edges} ${edgeWord}`;
}
