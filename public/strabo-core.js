/**
 * Framework-free core for the Strabo browser app.
 *
 * Pure functions only: no DOM, no Cytoscape, no fetch. This keeps the user-visible
 * logic testable from Node while the DOM modules (strabo.js, strabo-view.js,
 * strabo-panels.js) stay thin.
 */

export const API_PATH = '/api/strabo';

export const MIN_DIAMETER = 22;
export const MAX_DIAMETER = 62;

export const PALETTE = [
  '#4c9aff',
  '#56d4b1',
  '#f2b25c',
  '#c98bf0',
  '#6fb1ff',
  '#ff8f8f',
  '#9ad46a',
];

export const SHAPES = {
  module: 'round-rectangle',
  test: 'diamond',
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

/** Resolve a server-assigned palette index, falling back to a stable id hash. */
export function paletteColor(paletteIndex, id) {
  const index = Number.isInteger(paletteIndex) ? paletteIndex : hash(String(id));
  return PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length];
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
 * evidence edges. `functions` stays null until symbol extraction records them, so the UI
 * can report "not recorded" instead of implying there are none.
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

  return {
    id: node.id,
    kind: node.kind,
    metrics: [
      { label: 'Direct importers', value: usedBy.length },
      { label: 'Blast radius', value: node.transitiveDependents ?? 0 },
      { label: 'Direct imports', value: imports.length },
      { label: 'Depends on (all)', value: node.transitiveDependencies ?? 0 },
    ],
    imports,
    usedBy,
    functions: null,
  };
}

/** Counts for the tests / components strip, in either file or block mode. */
export function mapCounts(model) {
  const isBlock = model.prefixLength !== undefined;
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

/** Text for the "Reading the map" guide. */
export function readingLegend() {
  return [
    'size = dependents',
    'colour = directory',
    'diamond = test',
    'hover = blast radius',
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
  if (state.mode === 'block') {
    params.set('blockDepth', String(state.depth ?? 1));
    if (state.prefix) {
      params.set('blockPrefix', state.prefix);
    }
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Join API nodes to metrics and positions, and resolve palette indexes. */
export function buildElements(model) {
  const positions = new Map((model.positions ?? []).map((position) => [position.id, position]));
  const hubs = new Set(model.hubs ?? []);

  const nodes = (model.nodes ?? []).map((node) => ({
    group: 'nodes',
    classes: `kind-${node.kind}`,
    data: {
      id: node.id,
      label: node.label ?? node.id.split('/').pop(),
      path: node.id,
      kind: node.kind,
      // Colour by top-level directory so a module reads as one region on the map.
      color: paletteColor(node.paletteIndex, topLevelDirectory(node.id)),
      diameter: diameter(node.transitiveDependents),
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
 * What a double-click means.
 *
 * In block mode, drill one path segment deeper by using the block id as the prefix.
 * In file mode, there is nothing to roll up: the caller opens the file.
 */
export function drillTarget(state, id) {
  if (state.mode === 'block') {
    return { ...state, prefix: id, refresh: false };
  }
  return { ...state, file: id };
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

/** Normalise a Git remote into a browsable HTTPS base, or null when unrecognised. */
export function normalizeGitUrl(url) {
  if (!url) {
    return null;
  }
  let value = url.trim().replace(/\.git$/, '');
  const scp = /^(?:ssh:\/\/)?git@([^:/]+):(.+)$/.exec(value);
  if (scp) {
    value = `https://${scp[1]}/${scp[2]}`;
  } else if (value.startsWith('ssh://')) {
    value = `https://${value.slice('ssh://'.length).replace(/^[^@/]+@/, '')}`;
  }
  if (!/^https?:\/\//.test(value)) {
    return null;
  }
  return value.replace(/\/+$/, '');
}

/** Repository web URL fallback when no host `openWorkspaceFile` adapter exists. */
export function fileWebUrl(repository, path) {
  const base = normalizeGitUrl(repository?.gitUrl);
  if (!base || !path) {
    return null;
  }
  return `${base}/blob/HEAD/${path}`;
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

/** Counts used by the status line. */
export function graphSummary(model) {
  const nodes = (model.nodes ?? []).length;
  const edges = (model.edges ?? []).length;
  const cache = model.cache?.status ?? 'unknown';
  const stale = model.cache?.stale ? ' (stale)' : '';
  return `${nodes} nodes · ${edges} edges · cache: ${cache}${stale}`;
}

/**
 * Map a review analysis result onto node classes and a panel summary.
 *
 * Overlays never invent edges or facts; they only annotate nodes the server already
 * reported. Returns `{ classes, summary, items }`.
 */
export function overlayFor(kind, data) {
  switch (kind) {
    case 'impact':
      return impactOverlay(data);
    case 'cycles':
      return cyclesOverlay(data);
    case 'test-reach':
      return testReachOverlay(data);
    case 'architecture':
      return architectureOverlay(data);
    default:
      return { classes: new Map(), summary: '', items: [] };
  }
}

function impactOverlay(data) {
  const classes = new Map();
  for (const change of data?.changed ?? []) {
    classes.set(change.path, 'ov-changed');
  }
  for (const entry of data?.affected ?? []) {
    if (!classes.has(entry.id) && entry.distance > 0) {
      classes.set(entry.id, 'ov-affected');
    }
  }
  const changed = (data?.changed ?? []).length;
  const affected = (data?.affected ?? []).filter((entry) => entry.distance > 0).length;
  return {
    classes,
    summary: `${changed} changed · ${affected} affected`,
    items: (data?.affected ?? [])
      .slice(0, 50)
      .map((entry) => `${entry.id} · distance ${entry.distance}`),
  };
}

function cyclesOverlay(groups) {
  const classes = new Map();
  for (const group of groups ?? []) {
    for (const member of group.members ?? []) {
      classes.set(member, 'ov-cycle');
    }
  }
  return {
    classes,
    summary: `${(groups ?? []).length} cycle(s)`,
    items: (groups ?? []).map((group) => (group.members ?? []).join(' ↔ ')),
  };
}

function testReachOverlay(data) {
  const unreached = data?.unreachedWithDependents ?? [];
  const classes = new Map();
  for (const id of unreached) {
    classes.set(id, 'ov-unreached');
  }
  return {
    classes,
    summary: `${unreached.length} unreached with dependents`,
    items: unreached.slice(0, 50),
  };
}

/** Architecture health is repository-level, so it annotates no nodes. */
function architectureOverlay(report) {
  const axes = report?.axes ?? [];
  return {
    classes: new Map(),
    summary: `score ${report?.score ?? 'n/a'}/100`,
    items: axes.map((axis) =>
      axis.value === null
        ? `${axis.label}: unavailable (${axis.detail})`
        : `${axis.label}: ${axis.value}/100 (${axis.detail})`,
    ),
  };
}

/* ------------------------------------------------------------------ Member map */

function totalMembers(memberMap, key) {
  return (memberMap?.types ?? []).reduce((sum, type) => sum + (type[key] ?? []).length, 0);
}

/**
 * The five-step flow walkthrough for a member map.
 *
 * Each caption is derived from recorded data. Steps whose evidence is missing say so
 * rather than inventing a story, matching the "no wiring recorded" state in the design.
 * `context.consumers` is the number of repository files that import this one, or null
 * when the caller has no graph for the file.
 */
export function memberMapSteps(memberMap, context = {}) {
  const primary = (memberMap?.types ?? [])[0] ?? null;
  const fields = totalMembers(memberMap, 'fields');
  const methods = totalMembers(memberMap, 'methods');
  const flow = memberMap?.dataFlow;
  const consumers = context.consumers ?? null;

  const wiring =
    flow?.available === false
      ? 'No field-to-behavior wiring was recorded in the scan.'
      : `${(flow?.transforms ?? []).length} transform(s) read and write state across ${(flow?.resources ?? []).length} shared field(s).`;

  return [
    {
      key: 'fingerprint',
      label: 'fingerprint',
      caption: `${primary?.name ?? 'This file'} contains ${fields} field(s) and ${methods} behavior(s).`,
    },
    {
      key: 'members',
      label: 'members',
      caption: `${fields} field(s) and ${methods} method(s) recorded.`,
    },
    { key: 'wiring', label: 'wiring', caption: wiring },
    {
      key: 'data-flow',
      label: 'data flow',
      caption: `Inputs: ${(flow?.sources ?? []).length} · resources: ${(flow?.resources ?? []).length} · transforms: ${(flow?.transforms ?? []).length} · sinks: ${(flow?.sinks ?? []).length}.`,
    },
    {
      key: 'consumption',
      label: 'consumption',
      caption:
        consumers === null
          ? 'Repository consumers were not recorded for this file.'
          : `${consumers} repository consumer(s) import this file.`,
    },
  ];
}

/** The eyebrow, signature, tag, and metrics line for one field card. */
export function fieldCard(field) {
  const connected = field.reads > 0 || field.writes > 0;
  return {
    eyebrow: `FIELD · ${String(field.visibility ?? 'unknown').toUpperCase()} · ${field.mutable === false ? 'READONLY' : 'MUTABLE'}`,
    signature: `${field.name}: ${field.type ?? 'unrecorded type'}`,
    tag: connected ? `${field.reads} read · ${field.writes} write` : 'unconnected',
    metrics: `public data · local reads ${field.reads} · local writes ${field.writes}`,
  };
}

/** The line under one method card. */
export function methodCard(method) {
  const wired = method.reads.length > 0 || method.writes.length > 0;
  const params = method.parameters ?? 0;
  return {
    eyebrow: `METHOD · ${String(method.visibility ?? 'unknown').toUpperCase()}`,
    signature: `${method.name}(${params})${method.type ? `: ${method.type}` : ''}`,
    tag: wired ? 'wired' : 'unconnected',
    metrics: `reads ${method.reads.join(', ') || 'none'} · writes ${method.writes.join(', ') || 'none'}`,
  };
}

/**
 * Cluster members by the wiring the scan recorded: a method joins every field it reads or
 * writes, and each connected component is a cluster. Members with no wiring are singleton
 * clusters, which is why a type with no recorded wiring shows one cluster per member.
 */
export function memberClusters(memberMap) {
  const adjacency = new Map();
  const ensure = (name) => {
    if (!adjacency.has(name)) {
      adjacency.set(name, new Set());
    }
    return adjacency.get(name);
  };

  for (const type of memberMap?.types ?? []) {
    for (const field of type.fields) ensure(field.name);
    for (const method of type.methods) {
      ensure(method.name);
      for (const field of [...method.reads, ...method.writes]) {
        if (!adjacency.has(field)) {
          continue;
        }
        adjacency.get(field).add(method.name);
        adjacency.get(method.name).add(field);
      }
    }
  }

  const clusterOf = new Map();
  const clusters = [];
  for (const name of adjacency.keys()) {
    if (clusterOf.has(name)) {
      continue;
    }
    const index = clusters.length + 1;
    const members = [];
    const queue = [name];
    clusterOf.set(name, index);
    while (queue.length > 0) {
      const currentMember = queue.shift();
      members.push(currentMember);
      for (const neighbour of adjacency.get(currentMember) ?? []) {
        if (!clusterOf.has(neighbour)) {
          clusterOf.set(neighbour, index);
          queue.push(neighbour);
        }
      }
    }
    clusters.push({ index, members: members.sort() });
  }

  return { clusters, clusterOf };
}

/** A one-sentence explanation of the class, from recorded members and wiring only. */
export function explainClass(memberMap) {
  const type = (memberMap?.types ?? [])[0];
  if (!type) {
    return 'No type was recorded for this file.';
  }
  const flow = memberMap.dataFlow;
  const wiring =
    flow?.available === false
      ? 'No field-to-behavior wiring was recorded in the scan.'
      : `${flow.transforms.length} method(s) read and write state across ${flow.resources.length} shared field(s).`;
  return `${type.name} declares ${type.fields.length} field(s) and ${type.methods.length} method(s). ${wiring}`;
}

/**
 * Points for the Architecture Health radar, one per axis.
 *
 * A null axis (unavailable) collapses to the centre so the gap in evidence is visible
 * instead of being drawn as a zero score.
 */
export function radarPoints(axes, { radius = 54, center = 72 } = {}) {
  const count = Math.max(1, axes.length);
  return axes.map((axis, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / count;
    const ratio = axis.value === null ? 0 : Math.max(0, Math.min(100, axis.value)) / 100;
    return {
      label: axis.label,
      value: axis.value,
      x: center + Math.cos(angle) * radius * ratio,
      y: center + Math.sin(angle) * radius * ratio,
    };
  });
}

/** The outline of the radar frame, at full radius, for the grid rings. */
export function radarFrame(axes, { radius = 54, center = 72 } = {}) {
  return radarPoints(
    axes.map(() => ({ value: 100, label: '' })),
    { radius, center },
  );
}

export function polygonPoints(points) {
  return points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
}

/**
 * Points for the Dependency constellation: fields, methods, and repository consumers.
 * Positions are seeded from the member key so the layout is stable across renders.
 */
export function constellationLayout(points, { width = 280, height = 180 } = {}) {
  return points.map((point) => {
    const seed = hash(point.key);
    const angle = (seed % 360) * (Math.PI / 180);
    const ring =
      point.kind === 'consumer' ? 0.42 : 0.3 + (((seed >> 3) % 40) / 100) * 0.7;
    const radius = Math.min(width, height) / 2;
    return {
      ...point,
      x: width / 2 + Math.cos(angle) * radius * ring,
      y: height / 2 + Math.sin(angle) * radius * ring,
    };
  });
}

export function constellationPoints(memberMap, consumers) {
  const points = [];
  for (const type of memberMap?.types ?? []) {
    for (const field of type.fields) {
      points.push({ key: `field:${type.name}.${field.name}`, kind: 'field', label: field.name });
    }
    for (const method of type.methods) {
      points.push({ key: `method:${type.name}.${method.name}`, kind: 'method', label: method.name });
    }
  }
  const count = Math.max(0, consumers ?? 0);
  for (let index = 0; index < count; index += 1) {
    points.push({ key: `consumer:${index}`, kind: 'consumer', label: '' });
  }
  return points;
}

/** Sort a member list for the Order control. Returns a new array. */
export function orderMembers(members, order) {
  const copy = [...members];
  if (order === 'name') {
    return copy.sort((a, b) => a.name.localeCompare(b.name));
  }
  if (order === 'visibility') {
    return copy.sort(
      (a, b) => String(a.visibility).localeCompare(String(b.visibility)) || a.name.localeCompare(b.name),
    );
  }
  return copy.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

/** A member is "wired" when the scan recorded it touching state. */
export function isWiredField(field) {
  return field.reads > 0 || field.writes > 0;
}

export function isWiredMethod(method) {
  return method.reads.length > 0 || method.writes.length > 0;
}
