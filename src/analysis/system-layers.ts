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

/** At most this many depth bands for the files no layer token names; more would not draw. */
const MAX_DEPTH_BANDS = 4;

/**
 * Split files into at most `MAX_DEPTH_BANDS` contiguous import-depth ranges of similar size.
 * Files at one depth always share a range, so a range boundary never splits a depth.
 */
function depthRanges(
  files: readonly string[],
  depths: ReadonlyMap<string, number>,
): Array<{ low: number; high: number; files: string[]; depths: number[] }> {
  const sorted = [...files].sort((a, b) => (depths.get(a) ?? 0) - (depths.get(b) ?? 0) || a.localeCompare(b));
  const target = sorted.length / MAX_DEPTH_BANDS;
  const ranges: Array<{ low: number; high: number; files: string[]; depths: number[] }> = [];
  let current: { low: number; high: number; files: string[]; depths: number[] } | null = null;
  for (const file of sorted) {
    const depth = depths.get(file) ?? 0;
    const full = current && current.files.length >= target && depth !== current.high;
    if (!current || (full && ranges.length < MAX_DEPTH_BANDS - 1)) {
      current = { low: depth, high: depth, files: [], depths: [] };
      ranges.push(current);
    }
    current.high = depth;
    current.files.push(file);
    current.depths.push(depth);
  }
  return ranges;
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

  const unclassified: string[] = [];
  for (let index = 0; index < members.length; index += 1) {
    if (!tokens[index]) {
      unclassified.push(members[index] as string);
    }
  }
  const whyOf = new Map<string, string>();
  for (const [name, entry] of named) whyOf.set(name, `token \`${name}\`, import depth median ${entry.median}`);

  if (unclassified.length * 2 <= members.length) {
    // Most files named their layer, so a file without a token joins the band nearest its
    // import depth: a utility beside the data layer lands with data.
    const bands = [...named.values()];
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
  } else {
    // Most files named no layer. Folding them into the few token bands would label hundreds
    // of files by a name only a handful carry (all of `src/` as `hooks` because `src/state`
    // matched), so they get bands of their own, named by the import depth that places them.
    for (const range of depthRanges(unclassified, depths)) {
      const name = range.low === range.high ? `depth ${range.low}` : `depth ${range.low}–${range.high}`;
      const median = range.depths[Math.floor(range.depths.length / 2)] ?? range.low;
      named.set(name, { order: Number.MAX_SAFE_INTEGER, median, files: range.files });
      whyOf.set(name, `no layer token in the path; import depth ${range.low === range.high ? range.low : `${range.low}–${range.high}`} inside ${unit.name}`);
    }
  }

  const bands = [...named.entries()]
    .filter(([, band]) => band.files.length > 0)
    .sort(([, a], [, b]) => a.median - b.median || a.order - b.order);
  return bands.map(([name, band], order) => ({
    unit: unit.id,
    name,
    order,
    files: band.files.slice().sort(),
    why: whyOf.get(name) ?? `import depth median ${band.median}`,
  }));
}
