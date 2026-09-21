import type { Graph } from '../types.ts';
import {
  assignUnits,
  classifyPeriphery,
  detectUnits,
  type Periphery,
  type SystemUnit,
  type SystemUnitEcosystem,
} from './units.ts';

/** A unit as the System view draws it, with the evidence for its grouping. */
export interface SystemNode {
  id: string;
  name: string;
  ecosystem: SystemUnitEcosystem;
  manifest: string | null;
  parent: string | null;
  /** The "why grouped" caption: which manifest named it. */
  why: string;
  files: number;
  /** Files folded into the support shelf for this unit. */
  periphery: number;
}

/** One recorded relationship between units. */
export interface SystemEdge {
  source: string;
  target: string;
  kind: 'import';
  /** Number of file-to-file edges rolled into this unit pair. */
  weight: number;
  /** Example specifiers, for evidence. */
  samples: string[];
}

/** A file's layer inside its unit: direction orders it, a path token names it. */
export interface SystemLayer {
  unit: string;
  name: string;
  order: number;
  files: string[];
  why: string;
}

/** A connected region inside one layer, detected on the import graph. */
export interface SystemCommunity {
  id: string;
  unit: string;
  layer: string;
  members: string[];
  /** Share of member edges that stay inside the community, as a signal. */
  internalRatio: number;
  why: string;
}

/** A support file, with the unit whose shelf it folds into. */
export interface SystemPeriphery extends Periphery {
  unit: string;
}

export interface SystemReport {
  units: SystemNode[];
  edges: SystemEdge[];
  layers: SystemLayer[];
  communities: SystemCommunity[];
  periphery: SystemPeriphery[];
  summary: {
    units: number;
    edges: number;
    layers: number;
    communities: number;
    periphery: number;
  };
}

/**
 * Roll a file graph up into build units and the layers inside them.
 *
 * Nothing here is inferred from names or proximity: a unit exists because a manifest
 * declared one, a layer because the recorded imports point one way, and a community because
 * the recorded edges are denser inside it than across it. Files the scanner marked as
 * support (tests, scripts, generated, fixtures) fold into a shelf instead of becoming
 * components.
 */
export function buildSystemReport(root: string, repositoryName: string, graph: Graph): SystemReport {
  const files = graph.nodes.map((node) => node.id);
  const units = detectUnits(root, files, repositoryName);
  const assignment = assignUnits(files, units);
  const kindOf = new Map(graph.nodes.map((node) => [node.id, node.kind]));

  const periphery: SystemPeriphery[] = [];
  const componentFiles = new Map<string, string[]>(units.map((unit) => [unit.id, []]));
  for (const file of files) {
    const unit = assignment.get(file) ?? '.';
    const classified = classifyPeriphery(file, kindOf.get(file) ?? 'module');
    if (classified) {
      periphery.push({ ...classified, unit });
      continue;
    }
    componentFiles.get(unit)?.push(file);
  }

  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const nodes: SystemNode[] = units.map((unit) => ({
    id: unit.id,
    name: unit.name,
    ecosystem: unit.ecosystem,
    manifest: unit.manifest,
    parent: unit.parent,
    why: unit.why,
    files: componentFiles.get(unit.id)?.length ?? 0,
    periphery: periphery.filter((entry) => assignment.get(entry.file) === unit.id).length,
  }));

  const edges = aggregateEdges(graph, assignment, unitById, componentFiles);

  const layers: SystemLayer[] = [];
  const communities: SystemCommunity[] = [];
  for (const unit of units) {
    const members = componentFiles.get(unit.id) ?? [];
    if (members.length === 0) {
      continue;
    }
    const unitLayers = assignLayers(unit, members, graph);
    layers.push(...unitLayers);
    for (const layer of unitLayers) {
      communities.push(...detectCommunities(unit.id, layer, graph));
    }
  }

  return {
    units: nodes,
    edges,
    layers: layers.sort((a, b) => a.unit.localeCompare(b.unit) || a.order - b.order || a.name.localeCompare(b.name)),
    communities,
    periphery: periphery.sort((a, b) => a.file.localeCompare(b.file)),
    summary: {
      units: nodes.length,
      edges: edges.length,
      layers: layers.length,
      communities: communities.length,
      periphery: periphery.length,
    },
  };
}

function aggregateEdges(
  graph: Graph,
  assignment: Map<string, string>,
  unitById: Map<string, SystemUnit>,
  componentFiles: Map<string, string[]>,
): SystemEdge[] {
  const components = new Set<string>();
  for (const files of componentFiles.values()) {
    for (const file of files) {
      components.add(file);
    }
  }
  const byPair = new Map<string, SystemEdge>();
  for (const edge of graph.edges) {
    if (!components.has(edge.source) || !components.has(edge.target)) {
      continue;
    }
    const source = assignment.get(edge.source) ?? '.';
    const target = assignment.get(edge.target) ?? '.';
    if (source === target || !unitById.has(source) || !unitById.has(target)) {
      continue;
    }
    const key = `${source}\u0000${target}`;
    const existing = byPair.get(key);
    if (existing) {
      existing.weight += 1;
      if (existing.samples.length < 3) {
        existing.samples.push(edge.evidence.specifier);
      }
    } else {
      byPair.set(key, {
        source,
        target,
        kind: 'import',
        weight: 1,
        samples: [edge.evidence.specifier],
      });
    }
  }
  return [...byPair.values()].sort(
    (a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
  );
}

interface LayerToken {
  name: string;
  tokens: string[];
}

/** Dependency order, foundation first; the token table doubles as the lane order. */
const LAYER_TABLES: Partial<Record<SystemUnitEcosystem, LayerToken[]>> = {
  gradle: [
    { name: 'data', tokens: ['data', 'repository', 'dao', 'network', 'remote', 'local', 'database', 'db'] },
    { name: 'domain', tokens: ['domain', 'usecase', 'interactor', 'service'] },
    { name: 'viewmodel', tokens: ['viewmodel', 'vm', 'presenter', 'controller'] },
    { name: 'ui', tokens: ['ui', 'screen', 'activity', 'fragment', 'compose', 'view', 'widget', 'presentation'] },
  ],
  cargo: [
    { name: 'data', tokens: ['db', 'database', 'repo', 'repository', 'store', 'storage', 'model', 'models', 'entity'] },
    { name: 'service', tokens: ['service', 'services', 'usecase', 'domain', 'logic'] },
    { name: 'http', tokens: ['route', 'routes', 'handler', 'handlers', 'http', 'api', 'controller', 'endpoint'] },
  ],
  npm: [
    { name: 'api', tokens: ['api', 'client', 'fetch', 'http', 'services', 'service'] },
    { name: 'hooks', tokens: ['hooks', 'hook', 'state', 'store', 'context'] },
    { name: 'ui', tokens: ['components', 'component', 'pages', 'views', 'view', 'screens', 'ui'] },
  ],
  maven: [
    { name: 'data', tokens: ['dao', 'repository', 'entity', 'model', 'persistence'] },
    { name: 'service', tokens: ['service', 'usecase', 'domain', 'logic'] },
    { name: 'web', tokens: ['controller', 'endpoint', 'resource', 'api', 'web', 'rest'] },
  ],
  dotnet: [
    { name: 'data', tokens: ['data', 'repository', 'entity', 'model', 'persistence'] },
    { name: 'service', tokens: ['service', 'domain', 'logic', 'business'] },
    { name: 'web', tokens: ['controller', 'endpoint', 'api', 'web', 'controllers'] },
  ],
  python: [
    { name: 'data', tokens: ['models', 'model', 'db', 'repository', 'dao', 'schemas'] },
    { name: 'service', tokens: ['services', 'service', 'domain', 'logic', 'usecases'] },
    { name: 'api', tokens: ['api', 'routes', 'views', 'handlers', 'controllers'] },
  ],
  go: [
    { name: 'data', tokens: ['db', 'store', 'repository', 'model'] },
    { name: 'service', tokens: ['service', 'domain', 'logic'] },
    { name: 'http', tokens: ['http', 'handler', 'handlers', 'api', 'router', 'routes'] },
  ],
};

/** Depth from the foundation: a sink is 0, and a node is one above its highest dependency. */
function directionDepths(
  members: readonly string[],
  forward: Map<string, string[]>,
): Map<string, number> {
  const memberSet = new Set(members);
  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  const visit = (file: string): number => {
    const known = depth.get(file);
    if (known !== undefined) {
      return known;
    }
    if (visiting.has(file)) {
      return 0;
    }
    visiting.add(file);
    let value = 0;
    for (const next of forward.get(file) ?? []) {
      if (!memberSet.has(next)) {
        continue;
      }
      value = Math.max(value, visit(next) + 1);
    }
    visiting.delete(file);
    depth.set(file, value);
    return value;
  };

  for (const file of members) {
    visit(file);
  }
  return depth;
}

function forwardAdjacency(graph: Graph): Map<string, string[]> {
  const forward = new Map<string, string[]>();
  for (const node of graph.nodes) {
    forward.set(node.id, []);
  }
  for (const edge of graph.edges) {
    forward.get(edge.source)?.push(edge.target);
  }
  return forward;
}

function tokenLayer(
  ecosystem: SystemUnitEcosystem,
  file: string,
): { name: string; order: number } | null {
  const table = LAYER_TABLES[ecosystem];
  if (!table) {
    return null;
  }
  const segments = file.split('/').slice(0, -1).map((segment) => segment.toLowerCase());
  for (let order = 0; order < table.length; order += 1) {
    const layer = table[order] as LayerToken;
    if (layer.tokens.some((token) => segments.includes(token))) {
      return { name: layer.name, order };
    }
  }
  return null;
}

/**
 * Assign each file in a unit to a layer.
 *
 * A path token names the layer when one matches. Files without a token are placed by import
 * direction: their depth in the unit's internal graph is matched to the median depth of the
 * named layers, so a utility next to the data layer lands with data. When no file in the
 * unit has a token, layers are named by depth alone.
 */
function assignLayers(unit: SystemUnit, members: readonly string[], graph: Graph): SystemLayer[] {
  const forward = forwardAdjacency(graph);
  const depths = directionDepths(members, forward);
  const named = new Map<string, { order: number; median: number; files: string[] }>();
  let hasTokens = false;

  const tokens = members.map((file) => tokenLayer(unit.ecosystem, file));
  hasTokens = tokens.some((token) => token !== null);

  if (!hasTokens) {
    const byDepth = new Map<number, string[]>();
    for (const file of members) {
      const depth = depths.get(file) ?? 0;
      byDepth.set(depth, [...(byDepth.get(depth) ?? []), file]);
    }
    return [...byDepth.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([depth, files]) => ({
        unit: unit.id,
        name: `layer ${depth}`,
        order: depth,
        files: files.sort(),
        why: `import depth ${depth} inside ${unit.name}`,
      }));
  }

  for (let index = 0; index < members.length; index += 1) {
    const file = members[index] as string;
    const token = tokens[index];
    if (!token) {
      continue;
    }
    const entry = named.get(token.name) ?? { order: token.order, median: 0, files: [] };
    entry.files.push(file);
    named.set(token.name, entry);
  }
  for (const entry of named.values()) {
    const values = entry.files.map((file) => depths.get(file) ?? 0).sort((a, b) => a - b);
    entry.median = values[Math.floor(values.length / 2)] ?? 0;
  }

  const bands = [...named.values()].sort((a, b) => a.median - b.median || a.order - b.order);
  const unclassified: string[] = [];
  for (let index = 0; index < members.length; index += 1) {
    if (!tokens[index]) {
      unclassified.push(members[index] as string);
    }
  }
  for (const file of unclassified) {
    const depth = depths.get(file) ?? 0;
    let closest = bands[0];
    for (const band of bands) {
      if (!closest || Math.abs(band.median - depth) < Math.abs(closest.median - depth)) {
        closest = band;
      }
    }
    closest?.files.push(file);
  }

  return bands
    .filter((band) => band.files.length > 0)
    .map((band) => {
      const name = [...named.entries()].find(([, entry]) => entry === band)?.[0] ?? `layer ${band.order}`;
      return {
        unit: unit.id,
        name,
        order: bands.indexOf(band),
        files: band.files.slice().sort(),
        why: `token \`${name}\`, import depth median ${band.median}`,
      };
    });
}

/** Edges inside one layer, undirected, as an adjacency map. */
function layerAdjacency(layer: SystemLayer, graph: Graph): Map<string, Set<string>> {
  const members = new Set(layer.files);
  const adjacency = new Map<string, Set<string>>(layer.files.map((file) => [file, new Set<string>()]));
  for (const edge of graph.edges) {
    if (edge.source === edge.target || !members.has(edge.source) || !members.has(edge.target)) {
      continue;
    }
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  return adjacency;
}

/**
 * Communities inside a layer, by one greedy modularity pass (the Louvain first phase).
 *
 * The pass is deterministic — members are visited in sorted order and a tie keeps the
 * current community — so the same graph yields the same communities without a cache. A
 * community is snapped to its layer: it never crosses a unit or a layer boundary.
 */
function detectCommunities(unit: string, layer: SystemLayer, graph: Graph): SystemCommunity[] {
  const adjacency = layerAdjacency(layer, graph);
  const members = layer.files.slice().sort();
  if (members.length < 2) {
    return [];
  }
  const degree = new Map(members.map((file) => [file, adjacency.get(file)?.size ?? 0]));
  const totalEdges = [...degree.values()].reduce((sum, value) => sum + value, 0) / 2;
  if (totalEdges === 0) {
    return [];
  }
  // Each node starts in its own community; a move is taken only when it raises modularity,
  // so a node with no edge to anyone stays a singleton and is not reported.
  const community = new Map<string, number>(members.map((file, index) => [file, index]));
  const communityDegree = new Map<number, number>(
    members.map((file, index) => [index, degree.get(file) ?? 0]),
  );
  const scale = 2 * totalEdges * totalEdges;

  for (let pass = 0; pass < 10; pass += 1) {
    let moved = false;
    for (const file of members) {
      const neighbours = adjacency.get(file) ?? new Set<string>();
      if (neighbours.size === 0) {
        continue;
      }
      const current = community.get(file) as number;
      const ki = degree.get(file) ?? 0;
      const links = new Map<number, number>();
      let selfWeight = 0;
      for (const neighbour of neighbours) {
        const target = community.get(neighbour) as number;
        if (target === current) {
          selfWeight += 1;
        } else {
          links.set(target, (links.get(target) ?? 0) + 1);
        }
      }
      communityDegree.set(current, (communityDegree.get(current) ?? 0) - ki);
      const gain = (target: number, weight: number): number =>
        weight / totalEdges -
        ((communityDegree.get(target) ?? 0) * ki) / scale;
      let best = current;
      let bestGain = gain(current, selfWeight);
      for (const [candidate, weight] of [...links.entries()].sort((a, b) => a[0] - b[0])) {
        const candidateGain = gain(candidate, weight);
        if (candidateGain > bestGain) {
          best = candidate;
          bestGain = candidateGain;
        }
      }
      community.set(file, best);
      communityDegree.set(best, (communityDegree.get(best) ?? 0) + ki);
      if (best !== current) {
        moved = true;
      }
    }
    if (!moved) {
      break;
    }
  }

  const groups = new Map<number, string[]>();
  for (const file of members) {
    const id = community.get(file) as number;
    groups.set(id, [...(groups.get(id) ?? []), file]);
  }

  return [...groups.entries()]
    .filter(([, files]) => files.length > 1)
    .sort((a, b) => a[0] - b[0])
    .map(([id, files]) => {
      let inside = 0;
      let total = 0;
      const set = new Set(files);
      for (const file of files) {
        for (const neighbour of adjacency.get(file) ?? []) {
          total += 1;
          if (set.has(neighbour)) {
            inside += 1;
          }
        }
      }
      const ratio = total === 0 ? 1 : inside / total;
      return {
        id: `${unit}:${layer.name}:${id}`,
        unit,
        layer: layer.name,
        members: files,
        internalRatio: Number(ratio.toFixed(3)),
        why: `community: ${files.length} files, ${Math.round(ratio * 100)}% of edges internal`,
      };
    });
}
