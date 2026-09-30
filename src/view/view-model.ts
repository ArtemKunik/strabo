import { buildAdjacency, computeGraphMetrics, rankHubs } from '../analysis/analysis.ts';
import { computeTestReachByFile } from '../analysis/coverage.ts';
import { fileCoverage, type FileCoverage } from '../analysis/file-coverage.ts';
import { percent, type MeasuredCoverageSummary } from '../analysis/measured-coverage.ts';
import { buildPositions, buildSystemPositions } from '../analysis/layout.ts';
import type { SystemReport } from '../analysis/system.ts';
import type { Tier, TierReport } from '../analysis/tiers.ts';
import type { OutsideLink, UnitCard, UnitCoverageFact, UnitShelfFact } from '../types.ts';

import { toPosix } from '../boundary/repository-root.ts';
import type {
  Graph,
  GraphEdge,
  RepositoryDescriptor,
  ScanCacheMetadata,
  ScanReport,
  ViewEdge,
  ViewModel,
  ViewNode,
  ViewPosition,
} from '../types.ts';
import path from 'node:path';

/**
 * Derive presentation data without changing the evidence graph.
 *
 * Adds workspace-relative paths, deterministic positions, and a bounded hub shortlist.
 */
export function buildViewModel(
  root: string,
  scan: ScanReport,
  repository: RepositoryDescriptor,
  cache: ScanCacheMetadata,
): ViewModel {
  const graph: Graph = scan.graph;
  const metrics = computeGraphMetrics(graph, buildAdjacency(graph));
  const positions = buildPositions(graph);
  const hubs = rankHubs(metrics);

  const nodes: ViewNode[] = graph.nodes.map((node) => ({
    ...node,
    workspacePath: toPosix(path.join(path.basename(root), node.id)),
    fanIn: metrics.fanIn.get(node.id) ?? 0,
    fanOut: metrics.fanOut.get(node.id) ?? 0,
    transitiveDependencies: metrics.transitiveDependencies.get(node.id) ?? 0,
    transitiveDependents: metrics.transitiveDependents.get(node.id) ?? 0,
  }));

  const edges: ViewEdge[] = graph.edges.map((edge) => ({
    ...edge,
    semanticSource: edge.source,
    semanticTarget: edge.target,
  }));

  return {
    repository,
    nodes,
    edges,
    positions,
    hubs,
    diagnostics: graph.diagnostics,
    excluded: graph.excluded,
    cache,
  };
}

/**
 * Turn a System report into the same shape the file map renders.
 *
 * Each node is a build unit, labelled by the name its manifest declares and sized by its
 * component count, with the recorded import edges between units as the graph edges. The
 * "why grouped" caption travels on the node so the inspector can show it. The periphery is
 * a shelf, not a node, so it is carried as a count rather than drawn.
 */
export function buildSystemViewModel(
  system: SystemReport,
  repository: RepositoryDescriptor,
  cache: ScanCacheMetadata,
  sourceGraph?: Graph,
  measured?: MeasuredCoverageSummary | null,
): ViewModel {
  const graph: Graph = {
    nodes: system.units.map((unit) => ({
      id: unit.id,
      kind: 'unit' as const,
      directory: unit.parent ?? '.',
      label: unit.name,
    })),
    edges: system.edges.map((edge): GraphEdge => ({
      source: edge.source,
      target: edge.target,
      kind: 'import',
      evidence: {
        line: 1,
        specifier: edge.weight > 1 ? `${edge.samples[0] ?? 'import'} (+${edge.weight - 1})` : edge.samples[0] ?? 'import',
        resolution: 'exact',
      },
    })),
    diagnostics: [],
    excluded: [],
  };

  const metrics = computeGraphMetrics(graph, buildAdjacency(graph));
  // L20: L0 reads as a build order — a unit sits right of everything it imports — rather
  // than the directory grid the file map uses, which for units collapses to one island.
  const positions = buildSystemPositions(system.units, system.edges);
  // Units are cards, not files: the hub ring is reserved for files, so a unit never
  // takes the thick outline a central file earns. Selection is its only outline (L18).
  const hubs: string[] = [];
  const byId = new Map(system.units.map((unit) => [unit.id, unit]));

  const nodes: ViewNode[] = graph.nodes.map((node) => {
    const unit = byId.get(node.id);
    return {
      ...node,
      workspacePath: node.id,
      fanIn: metrics.fanIn.get(node.id) ?? 0,
      fanOut: metrics.fanOut.get(node.id) ?? 0,
      transitiveDependencies: metrics.transitiveDependencies.get(node.id) ?? 0,
      transitiveDependents: metrics.transitiveDependents.get(node.id) ?? 0,
      size: unit?.files ?? 0,
      files: unit?.files ?? 0,
      periphery: unit?.periphery ?? 0,
      why: unit?.why,
    };
  });

  // The rolled-up report is the source of the weight: the graph edge dropped it when the
  // unit pair was built from `system.edges`.
  const weightByPair = new Map(
    system.edges.map((edge) => [`${edge.source}\u0000${edge.target}`, edge.weight]),
  );
  const edges: ViewEdge[] = graph.edges.map((edge) => ({
    ...edge,
    semanticSource: edge.source,
    semanticTarget: edge.target,
    weight: weightByPair.get(`${edge.source}\u0000${edge.target}`) ?? 1,
  }));

  const single = singleUnitId(system);
  return {
    repository,
    nodes,
    edges,
    positions,
    hubs,
    diagnostics: [],
    excluded: [],
    cache,
    system: true,
    unitCards: buildUnitCards(system, sourceGraph, measured),
    ...(single ? { systemSingleUnit: single } : {}),
  };
}

/**
 * The unit a repository with only one *manifest-declared* unit auto-opens at L1 (L19).
 *
 * A folder with no manifest still rolls up to a fallback root unit, but that is not a build
 * unit an operator recognises, so it keeps the L0 map rather than skipping the overview.
 */
function singleUnitId(system: SystemReport): string | null {
  if (system.units.length !== 1) {
    return null;
  }
  const only = system.units[0];
  return only && only.manifest ? only.id : null;
}

/**
 * The facts each System-view unit card shows (L22).
 *
 * Everything is derived from the report plus the file graph the report was rolled up from.
 * Hotspots are the one exception: the signal count needs the function analysis, so the
 * server leaves it null for the browser to fill.
 */
function buildUnitCards(
  system: SystemReport,
  sourceGraph?: Graph,
  measured?: MeasuredCoverageSummary | null,
): UnitCard[] {
  const linesOf = new Map<string, number>();
  const languageOf = new Map<string, string>();
  for (const node of sourceGraph?.nodes ?? []) {
    if (typeof node.lines === 'number') {
      linesOf.set(node.id, node.lines);
    }
    if (node.language) {
      languageOf.set(node.id, node.language);
    }
  }
  const reached = sourceGraph ? computeTestReachByFile(sourceGraph) : new Map<string, string[]>();
  const coverage = sourceGraph && measured?.available ? fileCoverage(sourceGraph, measured) : null;

  const membersOf = new Map<string, string[]>();
  const layersOf = new Map<string, { name: string; order: number; files: number }[]>();
  for (const layer of system.layers) {
    membersOf.set(layer.unit, [...(membersOf.get(layer.unit) ?? []), ...layer.files]);
    layersOf.set(layer.unit, [
      ...(layersOf.get(layer.unit) ?? []),
      { name: layer.name, order: layer.order, files: layer.files.length },
    ]);
  }
  const shelfOf = new Map<string, UnitShelfFact>();
  for (const entry of system.periphery) {
    const shelf = shelfOf.get(entry.unit) ?? { test: 0, script: 0, generated: 0, fixture: 0, total: 0 };
    shelf[entry.category] += 1;
    shelf.total += 1;
    shelfOf.set(entry.unit, shelf);
  }
  const dependsOn = new Map<string, number>();
  const usedBy = new Map<string, number>();
  for (const edge of system.edges) {
    dependsOn.set(edge.source, (dependsOn.get(edge.source) ?? 0) + 1);
    usedBy.set(edge.target, (usedBy.get(edge.target) ?? 0) + 1);
  }

  return system.units.map((unit) => {
    const members = membersOf.get(unit.id) ?? [];
    const languages: Record<string, number> = {};
    let loc = 0;
    let reachedCount = 0;
    for (const file of members) {
      loc += linesOf.get(file) ?? 0;
      const language = languageOf.get(file) ?? 'other';
      languages[language] = (languages[language] ?? 0) + 1;
      if (reached.has(file)) {
        reachedCount += 1;
      }
    }
    const layers = (layersOf.get(unit.id) ?? [])
      .slice()
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    const role = layers.slice().sort((a, b) => b.files - a.files || a.name.localeCompare(b.name))[0]?.name ?? null;
    return {
      id: unit.id,
      name: unit.name,
      ecosystem: unit.ecosystem,
      manifest: unit.manifest,
      role,
      files: unit.files,
      loc,
      languages,
      layers,
      shelf: shelfOf.get(unit.id) ?? { test: 0, script: 0, generated: 0, fixture: 0, total: 0 },
      hotspots: null,
      testReach: { reached: reachedCount, total: members.length },
      coverage: coverage ? unitCoverage(members, coverage) : null,
      dependsOn: dependsOn.get(unit.id) ?? 0,
      usedBy: usedBy.get(unit.id) ?? 0,
      why: unit.why,
    };
  });
}

function unitCoverage(members: readonly string[], coverage: Map<string, FileCoverage>): UnitCoverageFact {
  let linesHit = 0;
  let linesFound = 0;
  let filesMeasured = 0;
  let notInReport = 0;
  for (const file of members) {
    const figure = coverage.get(file);
    if (!figure || figure.basis !== 'measured') {
      notInReport += 1;
      continue;
    }
    filesMeasured += 1;
    linesHit += figure.linesHit ?? 0;
    linesFound += figure.linesFound ?? 0;
  }
  return { basis: 'measured', linesHit, linesFound, value: percent(linesHit, linesFound), filesMeasured, notInReport };
}

export interface SystemUnitViewOptions {
  /** Draw the selected file's cross-unit edges to their target unit boxes. */
  showOutside?: boolean;
  /** The selected file whose outside links are drawn. */
  selectedFile?: string;
  /** Target units whose badge is expanded in place with their files. */
  expandedUnits?: string[];
  /** The repository's measured coverage report, for the unit cards' coverage fact. */
  measured?: MeasuredCoverageSummary | null;
}

/**
 * Drill-down model for one open unit (L15-L17).
 *
 * The open unit's component files are drawn inside its frame, laid out by the unit's
 * recorded layers (swim lanes) and communities; every other unit stays a collapsed box.
 * Only the selected file's in-unit import edges are drawn (L16); cross-unit edges appear
 * only with `showOutside` (L17), ending at the target unit's box with the files grouped
 * for the count badge. The support shelf stays folded unless opened by the caller.
 */
export function buildSystemUnitViewModel(
  system: SystemReport,
  graph: Graph,
  unitId: string,
  repository: RepositoryDescriptor,
  cache: ScanCacheMetadata,
  options: SystemUnitViewOptions = {},
): ViewModel | null {
  const unit = system.units.find((entry) => entry.id === unitId);
  if (!unit) {
    return null;
  }
  const unitLayers = system.layers
    .filter((layer) => layer.unit === unitId)
    .slice()
    .sort((a, b) => a.order - b.order);
  const memberFiles = unitLayers.flatMap((layer) => layer.files);
  const memberSet = new Set(memberFiles);
  const layerOf = new Map<string, { name: string; order: number; why: string }>();
  for (const layer of unitLayers) {
    for (const file of layer.files) {
      layerOf.set(file, { name: layer.name, order: layer.order, why: layer.why });
    }
  }
  const communityOf = new Map<string, string>();
  const unitCommunities = system.communities.filter((community) => community.unit === unitId);
  for (const community of unitCommunities) {
    for (const file of community.members) {
      if (!communityOf.has(file)) {
        communityOf.set(file, community.id);
      }
    }
  }
  const kindOf = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  const linesOf = new Map(graph.nodes.map((node) => [node.id, node.lines]));
  const metrics = computeGraphMetrics(graph, buildAdjacency(graph));
  // Blast radius split for the L17 counts: how much of a file's reach stays in its unit.
  const { backward } = buildAdjacency(graph);
  const splitDependents = (file: string): { inUnit: number; outside: number } => {
    const seen = new Set<string>();
    const queue = [...(backward.get(file) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift() as string;
      if (seen.has(next)) {
        continue;
      }
      seen.add(next);
      for (const dependent of backward.get(next) ?? []) {
        if (!seen.has(dependent)) {
          queue.push(dependent);
        }
      }
    }
    let inUnit = 0;
    for (const id of seen) {
      if (memberSet.has(id)) {
        inUnit += 1;
      }
    }
    return { inUnit, outside: seen.size - inUnit };
  };

  const nodes: ViewNode[] = [];
  for (const file of memberFiles.slice().sort()) {
    const layer = layerOf.get(file);
    const community = communityOf.get(file);
    const split = splitDependents(file);
    nodes.push({
      id: file,
      kind: kindOf.get(file) ?? 'module',
      directory: parentOf(file),
      label: file.split('/').pop() ?? file,
      ...(linesOf.get(file) !== undefined ? { lines: linesOf.get(file) } : {}),
      workspacePath: file,
      fanIn: metrics.fanIn.get(file) ?? 0,
      fanOut: metrics.fanOut.get(file) ?? 0,
      transitiveDependencies: metrics.transitiveDependencies.get(file) ?? 0,
      transitiveDependents: metrics.transitiveDependents.get(file) ?? 0,
      inUnitDependents: split.inUnit,
      outsideDependents: split.outside,
      systemUnit: unitId,
      systemLayer: layer?.name,
      systemCommunity: community,
      why: layer ? `layer \`${layer.name}\` · ${layer.why}` : undefined,
    });
  }
  // L21: the open unit's support files are a footer on its card, not a node in the frame,
  // so a drill-down never draws a shelf peer (and never an edge to a missing unit node).
  for (const other of system.units) {
    if (other.id === unitId) {
      continue;
    }
    nodes.push({
      id: other.id,
      kind: 'unit' as const,
      directory: other.parent ?? '.',
      label: other.name,
      workspacePath: other.id,
      fanIn: 0,
      fanOut: 0,
      transitiveDependencies: 0,
      transitiveDependents: 0,
      size: other.files,
      files: other.files,
      periphery: other.periphery,
      why: other.why,
      collapsed: true,
    });
  }

  const edges: ViewEdge[] = [];
  for (const edge of graph.edges) {
    if (memberSet.has(edge.source) && memberSet.has(edge.target)) {
      edges.push({ ...edge, semanticSource: edge.source, semanticTarget: edge.target, scope: 'unit' });
    }
  }
  // Cross-unit relationships of the selected file, grouped by target unit for the badge.
  const outsideLinks: OutsideLink[] = [];
  const expanded = new Set(options.expandedUnits ?? []);
  if (options.showOutside && options.selectedFile && memberSet.has(options.selectedFile)) {
    const groups = new Map<string, OutsideLink>();
    for (const edge of graph.edges) {
      const other =
        edge.source === options.selectedFile
          ? edge.target
          : edge.target === options.selectedFile
            ? edge.source
            : null;
      if (other === null || memberSet.has(other)) {
        continue;
      }
      const targetUnit = fileUnitOf(system, other);
      if (!targetUnit || targetUnit === unitId) {
        continue;
      }
      const target = system.units.find((entry) => entry.id === targetUnit);
      const group =
        groups.get(targetUnit) ??
        ({ file: options.selectedFile, targetUnit, targetName: target?.name ?? targetUnit, count: 0, files: [] } as OutsideLink);
      group.count += 1;
      if (!group.files.some((entry) => entry.file === other)) {
        group.files.push({ file: other, specifier: edge.evidence.specifier ?? null, line: edge.evidence.line ?? null });
      }
      groups.set(targetUnit, group);
    }
    for (const group of [...groups.values()].sort((a, b) => a.targetUnit.localeCompare(b.targetUnit))) {
      group.files.sort((a, b) => a.file.localeCompare(b.file));
      outsideLinks.push(group);
      edges.push({
        source: options.selectedFile,
        target: group.targetUnit,
        kind: 'import',
        role: 'use',
        evidence: {
          line: 1,
          specifier: `${group.count} file${group.count === 1 ? '' : 's'} in ${group.targetName}`,
          resolution: 'exact',
        },
        semanticSource: options.selectedFile,
        semanticTarget: group.targetUnit,
        scope: 'outside',
      });
      if (expanded.has(group.targetUnit)) {
        for (const target of group.files) {
          if (!nodes.some((node) => node.id === target.file)) {
            nodes.push({
              id: target.file,
              kind: kindOf.get(target.file) ?? 'module',
              directory: parentOf(target.file),
              label: target.file.split('/').pop() ?? target.file,
              workspacePath: target.file,
              fanIn: metrics.fanIn.get(target.file) ?? 0,
              fanOut: metrics.fanOut.get(target.file) ?? 0,
              transitiveDependencies: metrics.transitiveDependencies.get(target.file) ?? 0,
              transitiveDependents: metrics.transitiveDependents.get(target.file) ?? 0,
              systemUnit: group.targetUnit,
              why: `outside link: reached from ${options.selectedFile}`,
            });
          }
          edges.push({
            source: options.selectedFile,
            target: target.file,
            kind: 'import',
            role: 'use',
            evidence: {
              line: target.line ?? 1,
              specifier: target.specifier ?? 'import',
              resolution: 'exact',
            },
            semanticSource: options.selectedFile,
            semanticTarget: target.file,
            scope: 'outside',
          });
        }
      }
    }
  }

  const positions = layoutUnitLanes(memberFiles, layerOf, communityOf, nodes);
  const hubs = rankHubs(metrics).filter((id) => memberSet.has(id));

  return {
    repository,
    nodes,
    edges,
    positions,
    hubs,
    diagnostics: [],
    excluded: [],
    cache,
    system: true,
    systemUnit: unitId,
    systemUnitName: unit.name,
    systemLayers: unitLayers,
    systemCommunities: unitCommunities,
    outsideLinks,
    expandedUnits: [...expanded],
    unitCards: buildUnitCards(system, graph, options.measured),
    ...(singleUnitId(system) ? { systemSingleUnit: unitId } : {}),
  };
}



/** The unit a file belongs to: the layer that lists it, else the root. */
function fileUnitOf(system: SystemReport, file: string): string {
  for (const layer of system.layers) {
    if (layer.files.includes(file)) {
      return layer.unit;
    }
  }
  const periphery = system.periphery.find((entry) => entry.file === file);
  if (periphery) {
    return periphery.unit;
  }
  return '.';
}

function parentOf(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash === -1 ? '.' : id.slice(0, slash);
}

/**
 * Swim-lane layout: one column per layer in lane order, communities stacked inside their
 * lane with a gap between them, so a community reads as a block rather than a run of
 * unrelated dots. Collapsed unit boxes sit in a row below the lanes; the shelf sits to the
 * left of the first lane. Deterministic, so a reload does not reshuffle the unit.
 */
function layoutUnitLanes(
  memberFiles: string[],
  layerOf: Map<string, { name: string; order: number; why: string }>,
  communityOf: Map<string, string>,
  nodes: ViewNode[],
): { id: string; x: number; y: number }[] {
  const LANE_X = 360;
  const ROW_Y = 110;
  const COMMUNITY_GAP = 48;
  const byLayer = new Map<number, string[]>();
  for (const file of memberFiles) {
    const order = layerOf.get(file)?.order ?? 0;
    byLayer.set(order, [...(byLayer.get(order) ?? []), file]);
  }

  const positions = new Map<string, { x: number; y: number }>();
  let maxY = 0;
  for (const [order, files] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    // Group by community so a community's members stay adjacent; a file with no community
    // (a singleton the pass left alone) keeps its own slot.
    const groups = new Map<string, string[]>();
    for (const file of files.slice().sort()) {
      const key = communityOf.get(file) ?? `solo:${file}`;
      groups.set(key, [...(groups.get(key) ?? []), file]);
    }
    let y = 0;
    for (const [, members] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      for (const file of members) {
        y += ROW_Y;
        positions.set(file, { x: order * LANE_X, y });
        maxY = Math.max(maxY, y);
      }
      y += COMMUNITY_GAP;
      maxY = Math.max(maxY, y);
    }
  }

  let cursorX = 0;
  for (const node of nodes) {
    if (positions.has(node.id)) {
      continue;
    }
    if (node.collapsed) {
      positions.set(node.id, { x: cursorX, y: maxY + 260 });
      cursorX += 300;
      continue;
    }
    // The support shelf: left of the first lane, level with the top of the stack.
    positions.set(node.id, { x: -LANE_X, y: 0 });
  }
  return [...positions.entries()]
    .map(([id, position]) => ({ id, ...position }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The reading numbers every Structure drawing shares (Y9): the ranked edge total, the
 * same-tier ratio, and the honesty counts the legend and panel name rather than hide.
 */
function structureSummaryOf(report: TierReport): NonNullable<ViewModel['structureSummary']> {
  return {
    total: report.tierFlow.total,
    intraRatio: report.tierFlow.intraRatio,
    truncated: report.truncated,
    mixed: report.summary.mixed,
    unclassified: report.summary.unclassified,
  };
}

/** The display name of each role tier, matching the tier panel's own labels. */
const STRUCTURE_LABELS: Record<string, string> = {
  frontend: 'Frontend',
  api: 'API surface',
  domain: 'Domain/service',
  data: 'Data',
  integration: 'Integration',
  infra: 'Infra/config',
  build: 'Build/tooling',
  tests: 'Tests',
  unclassified: 'Unclassified',
};

export interface StructureViewOptions {
  direction?: 'vertical' | 'horizontal';
  /** A tier report at an earlier revision, to read card and edge deltas against. */
  baseline?:
    | { available: true; ref: string; revision: string; report: TierReport }
    | { available: false; ref: string; detail: string };
}

/** The tier-flow edge key a baseline comparison matches on. */
function flowKey(edge: { source: string; target: string; kind?: string }): string {
  return `${edge.source}\u0000${edge.target}\u0000${edge.kind ?? ''}`;
}

/**
 * Read the stack against a baseline: each card's file delta, each edge's import delta, and
 * the edges that existed then and are gone now (drawn as faint ghosts so a fix is visible).
 * Only recorded facts on both sides are compared; a missing side is zero, never guessed.
 */
function applyStructureBaseline(
  nodes: ViewNode[],
  edges: ViewEdge[],
  report: TierReport,
  baseline: TierReport,
): { upwardDelta: number; skipDelta: number } {
  const baseFiles = new Map<string, number>();
  for (const entry of [...baseline.matrix.perTier, ...baseline.shelf]) {
    baseFiles.set(entry.tier, entry.files);
  }
  for (const node of nodes) {
    if (node.ghost) continue;
    node.filesDelta = (node.files ?? 0) - (baseFiles.get(node.id) ?? 0);
  }
  const baseEdges = new Map(baseline.tierFlow.edges.map((edge) => [flowKey(edge), edge]));
  const present = new Set(nodes.map((node) => node.id));
  for (const edge of edges) {
    if (edge.ghost) continue;
    const key = flowKey({ source: edge.source, target: edge.target, kind: edge.tierKind });
    edge.weightDelta = (edge.weight ?? 0) - (baseEdges.get(key)?.weight ?? 0);
    baseEdges.delete(key);
  }
  for (const gone of baseEdges.values()) {
    if (!present.has(gone.source) || !present.has(gone.target)) continue;
    edges.push({
      source: gone.source,
      target: gone.target,
      kind: 'import',
      evidence: { line: 0, specifier: `${gone.weight} import(s) at the baseline, none now`, resolution: 'exact' },
      semanticSource: gone.source,
      semanticTarget: gone.target,
      weight: 0,
      tierKind: gone.kind,
      baselineOnly: true,
      weightDelta: -gone.weight,
    });
  }
  const wrongWay = (flow: TierReport['tierFlow'], kind: 'upward' | 'skip-layer'): number =>
    flow.edges.filter((edge) => edge.kind === kind).reduce((sum, edge) => sum + edge.weight, 0);
  return {
    upwardDelta: wrongWay(report.tierFlow, 'upward') - wrongWay(baseline.tierFlow, 'upward'),
    skipDelta: wrongWay(report.tierFlow, 'skip-layer') - wrongWay(baseline.tierFlow, 'skip-layer'),
  };
}

/**
 * Turn the tier report into the Structure view (Phase 35 Y3).
 *
 * One band per ranked tier, stacked in dependency order (frontend at the top, data at the
 * bottom, or left to right when horizontal) and joined by the `tierFlow` edges; the support
 * tiers sit on a shelf beside the stack rather than in it. Every node is a roll-up, so its
 * size is its file count and its `mixed` count rides along for a badge. Only recorded edges
 * are drawn; a tier or pair with no edge simply has none, never a fabricated one.
 */
export function buildStructureViewModel(
  report: TierReport,
  repository: RepositoryDescriptor,
  cache: ScanCacheMetadata,
  options: StructureViewOptions = {},
): ViewModel {
  const perTier = new Map(report.matrix.perTier.map((entry) => [entry.tier, entry]));
  const intraByTier = new Map(report.tierFlow.intraByTier.map((entry) => [entry.tier, entry.weight]));
  const isHorizontal = options.direction === 'horizontal';
  const BAND_Y = 170;
  const BAND_X = 260;
  const SHELF_X = isHorizontal ? 0 : 460;
  const SHELF_Y = isHorizontal ? 240 : 150;
  const SHELF_STEP_X = 180;
  const SHELF_STEP_Y = 150;

  const nodes: ViewNode[] = [];
  const positions: ViewPosition[] = [];
  const tierNode = (
    tier: Tier,
    kind: 'tier' | 'shelf',
  ): ViewNode => {
    const fact = perTier.get(tier) ?? report.shelf.find((entry) => entry.tier === tier);
    const files = fact?.files ?? 0;
    const lines = fact?.lines ?? 0;
    const tierFiles = (report.files ?? []).filter((f) => f.tier === tier);
    const dirCounts = new Map<string, number>();
    for (const f of tierFiles) {
      const parts = f.file.split('/');
      const first = parts[0] ?? '.';
      const second = parts[1];
      const dir = second ? `${first}/${second}` : first;
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }
    const topDirs = [...dirCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([dir]) => dir);

    return {
      id: tier,
      kind,
      directory: kind === 'shelf' ? 'shelf' : 'stack',
      label: STRUCTURE_LABELS[tier] ?? tier,
      workspacePath: tier,
      fanIn: 0,
      fanOut: 0,
      transitiveDependencies: 0,
      transitiveDependents: 0,
      size: files,
      files,
      lines,
      fileShare: fact && 'fileShare' in fact ? (fact.fileShare as number) : undefined,
      tier,
      mixed: fact?.mixed ?? 0,
      why: topDirs.length > 0 ? topDirs.join(', ') : undefined,
      internalImports: intraByTier.get(tier) ?? 0,
    };
  };

  // The stack: ranked tiers in dependency order, frontend highest (or furthest left) on the canvas.
  report.tierFlow.tiers.forEach((tier, index) => {
    nodes.push(tierNode(tier, 'tier'));
    positions.push({
      id: tier,
      x: isHorizontal ? index * BAND_X : 0,
      y: isHorizontal ? 0 : index * BAND_Y,
    });
  });
  // The shelf: support tiers beside the stack, never a band.
  report.shelf.forEach((entry, index) => {
    nodes.push(tierNode(entry.tier, 'shelf'));
    positions.push({
      id: entry.tier,
      x: isHorizontal ? SHELF_X + index * SHELF_STEP_X : SHELF_X,
      y: isHorizontal ? SHELF_Y : index * SHELF_STEP_Y,
    });
  });

  // Ghost bands: intended tiers from rules that have no files in the repository yet (Y7)
  const existingTiers = new Set(nodes.map((n) => n.id));
  let ghostIndex = report.tierFlow.tiers.length;
  for (const ghostBand of report.intent?.ghostBands ?? []) {
    if (!existingTiers.has(ghostBand.tier)) {
      const node = tierNode(ghostBand.tier, 'tier');
      node.ghost = true;
      node.why = `intended tier · ${ghostBand.ruleId}`;
      nodes.push(node);
      positions.push({
        id: ghostBand.tier,
        x: isHorizontal ? ghostIndex * BAND_X : 0,
        y: isHorizontal ? 0 : ghostIndex * BAND_Y,
      });
      ghostIndex += 1;
      existingTiers.add(ghostBand.tier);
    }
  }

  const edges: ViewEdge[] = report.tierFlow.edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    kind: 'import',
    evidence: {
      line: 1,
      specifier: `${edge.weight} recorded import${edge.weight === 1 ? '' : 's'}`,
      resolution: 'exact',
    },
    semanticSource: edge.source,
    semanticTarget: edge.target,
    weight: edge.weight,
    crossUnit: edge.crossUnit,
    tierKind: edge.kind,
    ghost: edge.ghost,
    intended: edge.intended,
    violation: edge.violation,
    ruleId: edge.ruleId,
    typeOnlyCount: edge.typeOnly ?? 0,
    tierImports: edge.imports ?? [],
  }));

  // Ghost edges: declared intended flows with 0 recorded imports (Y7)
  for (const ghost of report.intent?.ghostEdges ?? []) {
    edges.push({
      source: ghost.source,
      target: ghost.target,
      kind: 'import',
      evidence: {
        line: 0,
        specifier: `declared intent in ${ghost.ruleId} (0 recorded imports)`,
        resolution: 'exact',
      },
      semanticSource: ghost.source,
      semanticTarget: ghost.target,
      weight: 0,
      tierKind: ghost.kind,
      ghost: true,
      intended: true,
      ruleId: ghost.ruleId,
    });
  }

  const baseline = options.baseline;
  let structureBaseline: ViewModel['structureBaseline'];
  if (baseline?.available) {
    const deltas = applyStructureBaseline(nodes, edges, report, baseline.report);
    structureBaseline = { available: true, ref: baseline.ref, revision: baseline.revision, ...deltas };
  } else if (baseline) {
    structureBaseline = { available: false, ref: baseline.ref, detail: baseline.detail };
  }

  return {
    repository,
    nodes,
    edges,
    positions,
    // A band is a roll-up, not a file: the hub ring stays reserved for files.
    hubs: [],
    diagnostics: [],
    excluded: [],
    cache,
    structure: true,
    structureDirection: isHorizontal ? 'horizontal' : 'vertical',
    ...(structureBaseline ? { structureBaseline } : {}),
    structureSummary: structureSummaryOf(report),
    structureSpines: report.spines,
    structureEndpoints: report.endpoints,
    structureIntent: report.intent,
    directoryLabels: { stack: stackHeading(report, structureBaseline), shelf: 'Support Tiers' },
  };
}

/**
 * The stack plate's heading with a one-glance verdict: how layered the repository reads, how
 * many imports run upward, what a comparison changed, and the same-tier share. Same threshold
 * as the tier panel's named limit. Details run most to least telling, since a narrow plate
 * sheds them from the end (`fitLabel`).
 */
function stackHeading(report: TierReport, baseline?: ViewModel['structureBaseline']): string {
  const { total, intraRatio, edges } = report.tierFlow;
  if (total === 0) {
    return 'Architecture Stack';
  }
  const percent = Math.round(intraRatio * 100);
  const details = [intraRatio >= 0.5 ? 'weakly layered' : 'layered'];
  const upward = edges.filter((edge) => edge.kind === 'upward').reduce((sum, edge) => sum + edge.weight, 0);
  if (upward > 0) {
    details.push(`${upward} upward`);
  }
  if (baseline?.available) {
    const delta = baseline.upwardDelta + baseline.skipDelta;
    details.push(delta === 0 ? `no wrong-way change since ${baseline.ref}` : `${signed(delta)} wrong-way since ${baseline.ref}`);
  }
  details.push(intraRatio >= 0.5 ? `${percent}% same-tier` : `${100 - percent}% cross-tier`);
  return `Architecture Stack — ${details.join(' · ')}`;
}

/** `+3` / `−2` / `0`: a delta with its sign always written. */
function signed(value: number): string {
  return value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : '0';
}

/**
 * Turn the tier report into the Structure grid (Phase 35 Y4): the polyglot picture.
 *
 * Columns are build units, rows are ranked tiers in dependency order, and each cell is a
 * build unit's files in that tier, sized by file count and labelled with its unit and tier.
 * Every recorded edge between two cells is drawn, including cross-unit ones, so a monorepo
 * with several services reads as one picture. Support tiers sit on a shelf beside the grid,
 * never as a row. Only recorded edges are drawn; an empty pair simply has no edge.
 */
export function buildStructureGridViewModel(
  report: TierReport,
  repository: RepositoryDescriptor,
  cache: ScanCacheMetadata,
): ViewModel {
  // Wide enough that a cell's in-card label and the edge labels between rows both fit.
  const CELL = 210;
  const grid = report.grid;
  const unitIndex = new Map(grid.units.map((unit, index) => [unit.id, index]));
  const tierIndex = new Map(grid.tiers.map((tier, index) => [tier, index]));

  const nodes: ViewNode[] = [];
  const positions: ViewPosition[] = [];
  // Axis headers name the columns (units) and rows (tiers), so the grid is readable without
  // reading each cell's label. They are roll-ups too: `kind: 'axis'`, never a file.
  grid.units.forEach((unit, index) => {
    const id = `unit:${unit.id}`;
    nodes.push({
      id,
      kind: 'axis',
      directory: '.',
      label: unit.name,
      workspacePath: id,
      fanIn: 0,
      fanOut: 0,
      transitiveDependencies: 0,
      transitiveDependents: 0,
      unit: unit.id,
      unitName: unit.name,
    });
    positions.push({ id, x: index * CELL, y: -CELL });
  });
  grid.tiers.forEach((tier, index) => {
    const id = `tier:${tier}`;
    nodes.push({
      id,
      kind: 'axis',
      directory: '.',
      label: STRUCTURE_LABELS[tier] ?? tier,
      workspacePath: id,
      fanIn: 0,
      fanOut: 0,
      transitiveDependencies: 0,
      transitiveDependents: 0,
      tier,
    });
    positions.push({ id, x: -CELL, y: index * CELL });
  });
  // An import that stays inside one cell is not a relationship between cells: drawn, it is a
  // self-loop sitting on the card. The count rides on the cell instead.
  const internal = new Map(
    grid.edges.filter((edge) => edge.source === edge.target).map((edge) => [edge.source, edge.weight]),
  );
  for (const cell of grid.cells) {
    nodes.push({
      id: cell.id,
      kind: 'tier',
      directory: '.',
      label: `${cell.unitName} · ${STRUCTURE_LABELS[cell.tier] ?? cell.tier}`,
      workspacePath: cell.id,
      fanIn: 0,
      fanOut: 0,
      transitiveDependencies: 0,
      transitiveDependents: 0,
      size: cell.files,
      files: cell.files,
      tier: cell.tier,
      mixed: cell.mixed,
      unit: cell.unit,
      unitName: cell.unitName,
      cell: cell.id,
      internalImports: internal.get(cell.id) ?? 0,
    });
    positions.push({
      id: cell.id,
      x: (unitIndex.get(cell.unit) ?? 0) * CELL,
      y: (tierIndex.get(cell.tier) ?? 0) * CELL,
    });
  }
  // The shelf sits to the right of the grid, in its own column, never a tier row.
  const shelfX = (grid.units.length + 0.5) * CELL;
  report.shelf.forEach((entry, index) => {
    const id = `shelf:${entry.tier}`;
    nodes.push({
      id,
      kind: 'shelf',
      directory: '.',
      label: STRUCTURE_LABELS[entry.tier] ?? entry.tier,
      workspacePath: id,
      fanIn: 0,
      fanOut: 0,
      transitiveDependencies: 0,
      transitiveDependents: 0,
      size: entry.files,
      files: entry.files,
      tier: entry.tier,
      mixed: entry.mixed,
    });
    positions.push({ id, x: shelfX, y: index * CELL });
  });

  const edges: ViewEdge[] = grid.edges.filter((edge) => edge.source !== edge.target).map((edge) => ({
    source: edge.source,
    target: edge.target,
    kind: 'import',
    evidence: {
      line: 1,
      specifier: `${edge.weight} recorded import${edge.weight === 1 ? '' : 's'}`,
      resolution: 'exact',
    },
    semanticSource: edge.source,
    semanticTarget: edge.target,
    weight: edge.weight,
    crossUnit: edge.crossUnit ? edge.weight : 0,
    crossUnitEdge: edge.crossUnit,
    tierKind: edge.kind,
    ghost: edge.ghost,
    intended: edge.intended,
    violation: edge.violation,
    ruleId: edge.ruleId,
    typeOnlyCount: edge.typeOnly ?? 0,
    tierImports: edge.imports ?? [],
  }));

  return {
    repository,
    nodes,
    edges,
    positions,
    // A cell is a roll-up, not a file: the hub ring stays reserved for files.
    hubs: [],
    diagnostics: [],
    excluded: [],
    cache,
    structure: true,
    structureLevel: 'grid',
    structureSummary: structureSummaryOf(report),
    structureGrid: {
      tiers: grid.tiers,
      units: grid.units,
      crossUnitEdges: grid.summary.crossUnitEdges,
    },
    structureSpines: report.spines,
    structureEndpoints: report.endpoints,
    structureIntent: report.intent,
  };
}

export interface StructureCellViewOptions {
  /** The build unit to filter to; absent when drilling from a whole-repository tier band. */
  unit?: string;
  /** The role tier of the cell. */
  tier: Tier;
  /** Draw the selected file's links to other units/cells. */
  showOutside?: boolean;
  /** The selected file whose outside links are drawn. */
  selectedFile?: string;
}

/**
 * Drill-down model for one cell (unit × tier) in the Structure lens (Phase 35 Y5).
 *
 * Draws today's file map filtered to the cell's member files, with intra-cell import edges,
 * central hub files, and collapsed boxes for the remaining units as context.
 */
export function buildStructureCellViewModel(
  report: TierReport,
  graph: Graph,
  repository: RepositoryDescriptor,
  cache: ScanCacheMetadata,
  options: StructureCellViewOptions,
): ViewModel | null {
  const matching = report.files.filter((entry) => {
    const matchUnit = options.unit !== undefined ? (entry.unit ?? '.') === options.unit : true;
    return matchUnit && entry.tier === options.tier;
  });
  if (matching.length === 0) {
    return null;
  }
  const memberFiles = matching.map((e) => e.file).sort();
  const memberSet = new Set(memberFiles);

  const unitInfo = report.grid.units.find((u) => u.id === options.unit);
  const unitName = unitInfo?.name ?? options.unit;
  const cellId = options.unit ? `${options.unit}|${options.tier}` : options.tier;

  const metrics = computeGraphMetrics(graph, buildAdjacency(graph));
  const kindOf = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  const linesOf = new Map(graph.nodes.map((node) => [node.id, node.lines]));
  const classificationOf = new Map(report.files.map((entry) => [entry.file, entry]));

  const nodes: ViewNode[] = [];
  for (const file of memberFiles) {
    const cls = classificationOf.get(file);
    const why = cls?.evidence?.[0]
      ? `tier \`${options.tier}\` · ${cls.evidence[0].detail}`
      : `tier \`${options.tier}\``;
    nodes.push({
      id: file,
      kind: kindOf.get(file) ?? 'module',
      directory: parentOf(file),
      label: file.split('/').pop() ?? file,
      ...(linesOf.get(file) !== undefined ? { lines: linesOf.get(file) } : {}),
      workspacePath: file,
      fanIn: metrics.fanIn.get(file) ?? 0,
      fanOut: metrics.fanOut.get(file) ?? 0,
      transitiveDependencies: metrics.transitiveDependencies.get(file) ?? 0,
      transitiveDependents: metrics.transitiveDependents.get(file) ?? 0,
      tier: options.tier,
      unit: options.unit,
      unitName,
      why,
    });
  }

  // Collapsed unit boxes for the other units so context remains visible
  for (const other of report.grid.units) {
    if (other.id === options.unit) {
      continue;
    }
    nodes.push({
      id: other.id,
      kind: 'unit' as const,
      directory: '.',
      label: other.name,
      workspacePath: other.id,
      fanIn: 0,
      fanOut: 0,
      transitiveDependencies: 0,
      transitiveDependents: 0,
      size: other.files,
      files: other.files,
      collapsed: true,
    });
  }

  const edges: ViewEdge[] = [];
  for (const edge of graph.edges ?? []) {
    if (memberSet.has(edge.source) && memberSet.has(edge.target)) {
      edges.push({
        ...edge,
        semanticSource: edge.source,
        semanticTarget: edge.target,
        scope: 'unit',
      });
    }
  }

  const fileGraph: Graph = {
    nodes: nodes.filter((n) => !n.collapsed).map((n) => ({
      id: n.id,
      directory: n.directory,
      kind: n.kind,
    })),
    edges,
    diagnostics: [],
    excluded: [],
  };
  const positions = buildPositions(fileGraph);
  const maxY = Math.max(0, ...positions.map((p) => p.y));
  let cursorX = 0;
  for (const other of report.grid.units) {
    if (other.id === options.unit) {
      continue;
    }
    positions.push({ id: other.id, x: cursorX, y: maxY + 240 });
    cursorX += 240;
  }

  return {
    repository,
    nodes,
    edges,
    positions,
    hubs: rankHubs(metrics).filter((id) => memberSet.has(id)),
    diagnostics: [],
    excluded: [],
    cache,
    structure: true,
    structureLevel: 'cell',
    structureUnit: options.unit,
    structureUnitName: unitName,
    structureTier: options.tier,
    structureCell: cellId,
    structureSummary: structureSummaryOf(report),
    structureSpines: report.spines,
    structureEndpoints: report.endpoints,
    structureIntent: report.intent,
  };
}
