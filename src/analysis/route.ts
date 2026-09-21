import { detectEntryPoints, type EntryPoint } from '../scan/entry-points.ts';
import type { Graph } from '../types.ts';
import { buildAdjacency, computeGraphMetrics } from './analysis.ts';
import {
  MAX_TIER_FILES,
  classifyTiers,
  propagateTiers,
  readDeclaredTiers,
  unitRole,
  type Tier,
  type UnitRole,
} from './tiers.ts';
import {
  applyDeclaredGroups,
  assignUnits,
  detectUnits,
  readDeclaredGroups,
  type SystemUnitEcosystem,
} from './units.ts';

/**
 * A file's tier when it was read, or `unavailable` when the classification ceiling left it
 * unread. `unclassified` stays a read file with no evidence; the two are not the same fact.
 */
export type RouteTier = Tier | 'unavailable';

/** One recorded entry point, joined to the unit that owns it. */
export interface RouteEntryPoint {
  file: string;
  reason: string;
  source: string;
  unit: string;
}

/** One file in the outward route, with the recorded evidence for why it is here. */
export interface RouteStep {
  file: string;
  /** Shortest use-edge distance from the entry point that reached it; the entry itself is 0. */
  depth: number;
  /** The file that first reached this one along a use edge, or null for an entry point. */
  from: string | null;
  /** The entry point whose walk reached this file. */
  entry: string;
  /** True when this file is itself a declared entry point. */
  entryPoint: boolean;
  /** Distinct files that require this one over recorded use edges. */
  fanIn: number;
  tier: RouteTier;
  unit: string;
}

/** A file no entry point reaches, kept out of the order rather than appended to it. */
export interface RouteUnreached {
  file: string;
  unit: string;
  fanIn: number;
  tier: RouteTier;
}

/** The unit-level summary that precedes a unit's ordered files. */
export interface RouteUnitSummary {
  id: string;
  name: string;
  ecosystem: SystemUnitEcosystem;
  why: string;
  role: UnitRole;
  roleEvidence: string;
  /** Files assigned to the unit, from the same detection the System view uses. */
  files: number;
  routed: number;
  unreached: number;
  /** Declared entry points inside this unit. */
  entryPoints: number;
}

/** One unit's route: the summary, then its ordered files, then what the walk missed. */
export interface RouteUnit {
  summary: RouteUnitSummary;
  files: RouteStep[];
  unreached: RouteUnreached[];
}

export interface ReadingRoute {
  repository: string;
  entryPoints: RouteEntryPoint[];
  /** The merged outward order across every entry point. */
  order: RouteStep[];
  /** Files no entry point reaches, in a separate list. */
  unreached: RouteUnreached[];
  /** One route per unit, each with its summary before its files (Phase 22, W2). */
  units: RouteUnit[];
  summary: {
    entryPoints: number;
    routed: number;
    unreached: number;
    units: number;
    /** Files a per-layer breadth cap left unwalked, so the route is explicitly partial. */
    skipped: number;
  };
  /** Set when the walk was breadth-limited at a depth layer. */
  truncated?: string;
}

export interface ReadingRouteOptions {
  /** Replacement entry points; by default they are detected from the repository's manifests. */
  entryPoints?: readonly EntryPoint[];
  /** Most files admitted into one depth layer during the walk. */
  layerLimit?: number;
}

/** Default breadth of one depth layer; a wider layer is capped and reported as truncated. */
export const DEFAULT_ROUTE_LAYER_LIMIT = 25;

/**
 * Assemble the reading route: an outward walk from the recorded entry points.
 *
 * The walk follows recorded `use` import edges only — `declare` edges describe the module
 * tree and call edges parallel an import — so every ordering claim is a recorded dependency.
 * Breadth is capped per depth layer, and a truncated walk says so rather than pretending it
 * is complete. A file no entry point reaches is returned in the `unreached` list; it is never
 * forced into the order. Unit grouping reuses `detectUnits`/`applyDeclaredGroups`, the same
 * detection the System view draws.
 */
export function computeReadingRoute(
  root: string,
  repositoryName: string,
  graph: Graph,
  options: ReadingRouteOptions = {},
): ReadingRoute {
  const files = graph.nodes.map((node) => node.id).sort();
  const nodeSet = new Set(files);

  // Only recorded imports order the route: a `declare` edge is the module tree, and a call
  // edge always parallels an import, so counting either would draw a link the code did not.
  const importGraph: Graph = {
    ...graph,
    edges: graph.edges.filter((edge) => edge.role !== 'declare' && edge.kind !== 'call'),
  };
  const adjacency = buildAdjacency(importGraph);
  const metrics = computeGraphMetrics(importGraph, adjacency);

  const declared = options.entryPoints ?? detectEntryPoints(root, files);
  const entryPoints = uniqueEntryPoints(declared, nodeSet);

  const tierOf = classifyRouteTiers(root, files, graph);

  const derived = detectUnits(root, files, repositoryName);
  const { units, assignment } = applyDeclaredGroups(derived, files, readDeclaredGroups(root));
  const unitOf = (file: string): string => assignment.get(file) ?? '.';

  const walk = walkOutward(entryPoints, nodeSet, adjacency, metrics.fanIn, options.layerLimit);

  const orderMap = topoOrder(walk.reached, adjacency, walk.depth, entryPoints);
  const order: RouteStep[] = orderMap.map((file) => {
    const step: RouteStep = {
      file,
      depth: walk.depth.get(file) ?? 0,
      from: walk.from.get(file) ?? null,
      entry: walk.entryOf.get(file) ?? file,
      entryPoint: walk.entrySet.has(file),
      fanIn: metrics.fanIn.get(file) ?? 0,
      tier: tierOf(file),
      unit: unitOf(file),
    };
    return step;
  });

  const unreached: RouteUnreached[] = files
    .filter((file) => !walk.reached.has(file))
    .map((file) => ({
      file,
      unit: unitOf(file),
      fanIn: metrics.fanIn.get(file) ?? 0,
      tier: tierOf(file),
    }));

  const entryByUnit = new Map<string, RouteEntryPoint[]>();
  for (const entry of entryPoints) {
    const withUnit: RouteEntryPoint = { ...entry, unit: unitOf(entry.file) };
    entryByUnit.set(withUnit.unit, [...(entryByUnit.get(withUnit.unit) ?? []), withUnit]);
  }

  const reachedInUnit = new Map<string, number>();
  const unreachedInUnit = new Map<string, number>();
  for (const step of order) {
    reachedInUnit.set(step.unit, (reachedInUnit.get(step.unit) ?? 0) + 1);
  }
  for (const file of unreached) {
    unreachedInUnit.set(file.unit, (unreachedInUnit.get(file.unit) ?? 0) + 1);
  }

  const unitsOut: RouteUnit[] = units
    .map((unit) => {
      const members = files.filter((file) => unitOf(file) === unit.id);
      if (members.length === 0) {
        return null;
      }
      const role = unitRole(unit, members, (file) => {
        const tier = tierOf(file);
        return tier === 'unavailable' ? 'unclassified' : tier;
      });
      const entries = entryByUnit.get(unit.id) ?? [];
      return {
        summary: {
          id: unit.id,
          name: unit.name,
          ecosystem: unit.ecosystem,
          why: unit.why,
          role: role.role,
          roleEvidence: role.evidence,
          files: members.length,
          routed: reachedInUnit.get(unit.id) ?? 0,
          unreached: unreachedInUnit.get(unit.id) ?? 0,
          entryPoints: entries.length,
        },
        files: order.filter((step) => step.unit === unit.id),
        unreached: unreached.filter((file) => file.unit === unit.id),
      } satisfies RouteUnit;
    })
    .filter((unit): unit is RouteUnit => unit !== null);

  return {
    repository: repositoryName,
    entryPoints: entryPoints.map((entry) => ({ ...entry, unit: unitOf(entry.file) })),
    order,
    unreached,
    units: unitsOut,
    summary: {
      entryPoints: entryPoints.length,
      routed: order.length,
      unreached: unreached.length,
      units: unitsOut.length,
      skipped: walk.skipped,
    },
    ...(walk.skipped > 0
      ? { truncated: `${walk.skipped} file(s) beyond the ${walk.layerLimit}-per-layer cap were not walked` }
      : {}),
  };
}

/** Deduplicate by file, keep the first reason in sorted order, and drop unknown files. */
function uniqueEntryPoints(
  entryPoints: readonly EntryPoint[],
  nodeSet: Set<string>,
): EntryPoint[] {
  const byFile = new Map<string, EntryPoint>();
  for (const entry of [...entryPoints].sort(
    (a, b) => a.file.localeCompare(b.file) || a.reason.localeCompare(b.reason) || a.source.localeCompare(b.source),
  )) {
    if (!nodeSet.has(entry.file) || byFile.has(entry.file)) {
      continue;
    }
    byFile.set(entry.file, entry);
  }
  return [...byFile.values()];
}

interface OutwardWalk {
  reached: Set<string>;
  depth: Map<string, number>;
  from: Map<string, string | null>;
  entryOf: Map<string, string>;
  entrySet: Set<string>;
  skipped: number;
  layerLimit: number;
}

/**
 * Breadth-first outward walk, capped per depth layer.
 *
 * A layer's candidates are ranked by recorded fan-in (most-required first) then path, so the
 * cap drops the least-depended-on files and the same graph always admits the same set. The
 * parent recorded for a file is the first reached importer that named it, sorted for
 * determinism, so "reached from X" is a recorded edge rather than a guess.
 */
function walkOutward(
  entryPoints: readonly EntryPoint[],
  nodeSet: Set<string>,
  adjacency: ReturnType<typeof buildAdjacency>,
  fanIn: Map<string, number>,
  layerLimit: number | undefined,
): OutwardWalk {
  const limit = layerLimit && layerLimit > 0 ? layerLimit : DEFAULT_ROUTE_LAYER_LIMIT;
  const reached = new Set<string>();
  const depth = new Map<string, number>();
  const from = new Map<string, string | null>();
  const entryOf = new Map<string, string>();
  const entrySet = new Set(entryPoints.map((entry) => entry.file));
  let skipped = 0;

  let frontier: string[] = [];
  for (const entry of entryPoints) {
    if (reached.has(entry.file)) {
      continue;
    }
    reached.add(entry.file);
    depth.set(entry.file, 0);
    from.set(entry.file, null);
    entryOf.set(entry.file, entry.file);
    frontier.push(entry.file);
  }

  let layer = 0;
  while (frontier.length > 0) {
    const candidate = new Map<string, string>();
    for (const file of [...frontier].sort()) {
      for (const target of adjacency.forward.get(file) ?? []) {
        if (!nodeSet.has(target) || reached.has(target) || candidate.has(target)) {
          continue;
        }
        candidate.set(target, file);
      }
    }
    const ranked = [...candidate.keys()].sort(
      (a, b) => (fanIn.get(b) ?? 0) - (fanIn.get(a) ?? 0) || a.localeCompare(b),
    );
    const admitted = ranked.slice(0, limit);
    skipped += ranked.length - admitted.length;

    const next: string[] = [];
    for (const target of admitted) {
      const parent = candidate.get(target) as string;
      reached.add(target);
      depth.set(target, layer + 1);
      from.set(target, parent);
      entryOf.set(target, entryOf.get(parent) ?? parent);
      next.push(target);
    }
    frontier = next;
    layer += 1;
  }

  return { reached, depth, from, entryOf, entrySet, skipped, layerLimit: limit };
}

/**
 * Order the reached files so an importer precedes everything it imports.
 *
 * Kahn's algorithm over the reached use edge set: a file is emitted once every reached file
 * that imports it has been. Depth breaks ties (and seeds the queue), so the order still reads
 * broadly outward layer by layer while the topological rule holds. Entry points are seeded
 * ahead of their importers because a route is asked to start at them; a cycle has no valid
 * order, so its remaining files are emitted by depth then path and the order is honestly
 * partial rather than silently wrong.
 */
function topoOrder(
  reached: Set<string>,
  adjacency: ReturnType<typeof buildAdjacency>,
  depth: Map<string, number>,
  entryPoints: readonly EntryPoint[],
): string[] {
  const importerCount = new Map<string, number>();
  const importeesInside = new Map<string, string[]>();
  for (const file of reached) {
    const importers = (adjacency.backward.get(file) ?? []).filter((source) => reached.has(source));
    importerCount.set(file, importers.length);
    for (const importer of importers) {
      importeesInside.set(importer, [...(importeesInside.get(importer) ?? []), file]);
    }
  }

  const rank = (file: string): [number, string] => [depth.get(file) ?? Number.MAX_SAFE_INTEGER, file];
  const compare = (a: string, b: string): number => {
    const [da, fa] = rank(a);
    const [db, fb] = rank(b);
    return da - db || fa.localeCompare(fb);
  };

  const available = [...reached]
    .filter((file) => (importerCount.get(file) ?? 0) === 0 || entryPoints.some((entry) => entry.file === file))
    .sort(compare);
  const emitted: string[] = [];
  const done = new Set<string>();

  while (available.length > 0) {
    const file = available.shift() as string;
    if (done.has(file)) {
      continue;
    }
    done.add(file);
    emitted.push(file);
    for (const importee of importeesInside.get(file) ?? []) {
      const remaining = (importerCount.get(importee) ?? 0) - 1;
      importerCount.set(importee, remaining);
      if (remaining <= 0 && !done.has(importee)) {
        available.push(importee);
      }
    }
    available.sort(compare);
  }

  if (emitted.length < reached.size) {
    for (const file of [...reached].filter((candidate) => !done.has(candidate)).sort(compare)) {
      emitted.push(file);
    }
  }
  return emitted;
}

/** A file's tier, or `unavailable` when it was beyond the classification ceiling. */
function classifyRouteTiers(
  root: string,
  files: readonly string[],
  graph: Graph,
): (file: string) => RouteTier {
  const selected = files.slice(0, MAX_TIER_FILES);
  const { files: classified, skipped } = classifyTiers(root, selected, readDeclaredTiers(root));
  const propagated = propagateTiers(classified, graph.edges);
  const tierOfFile = new Map(propagated.map((entry) => [entry.file, entry.tier]));
  const unread = new Set([...skipped, ...files.slice(MAX_TIER_FILES)]);
  return (file: string) => {
    if (unread.has(file)) {
      return 'unavailable';
    }
    return tierOfFile.get(file) ?? 'unavailable';
  };
}
