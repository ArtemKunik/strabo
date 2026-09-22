import type { Graph } from '../types.ts';
import type { SystemLayer } from './system-types.ts';
import type { SystemUnit, SystemUnitEcosystem } from './units.ts';

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
export function assignLayers(unit: SystemUnit, members: readonly string[], graph: Graph): SystemLayer[] {
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
