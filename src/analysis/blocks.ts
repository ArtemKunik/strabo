import type {
  BlockViewModel,
  Graph,
  GraphNode,
  RepositoryDescriptor,
  ScanCacheMetadata,
  ViewEdge,
  ViewNode,
  ViewPosition,
} from '../types.ts';
import { buildAdjacency, computeGraphMetrics, rankHubs } from './analysis.ts';
import { buildPositions } from './layout.ts';
import { assignPaletteIndexes, blockRegion } from './palette.ts';

export interface BlockOptions {
  /** Number of directory segments to group by, relative to `prefix`. */
  depth: number;
  /** Directory to drill into; blocks are then relative to this prefix. */
  prefix?: string;
}

export interface BlockMeta {
  repository?: RepositoryDescriptor;
  cache?: ScanCacheMetadata;
}

/**
 * Roll a file graph up into path-prefix blocks, permitting drill-down by one segment.
 *
 * Reuses adjacency, reachability, and packing rules. File mode stays exact; block mode
 * turns a large repository into navigable directory aggregates. A normal file graph
 * request must not pay for roll-up work, so this runs only when block mode is requested.
 *
 * A block's identity is derived from the *directory* of each file, never the file name:
 * a root-level file belongs to block `.`. With a `prefix`, only files under that prefix
 * are included and block ids are absolute (e.g. prefix `src`, depth 1 -> `src/api`).
 */
export function buildBlockViewModel(
  graph: Graph,
  options: BlockOptions,
  meta: BlockMeta = {},
): BlockViewModel {
  const depth = Math.max(1, Math.floor(options.depth) || 1);
  const prefix = normalizePrefix(options.prefix);

  const mapping = new Map<string, string>();
  const aggregateKind = new Map<string, 'module' | 'test'>();

  for (const node of graph.nodes) {
    const directory = directoryOf(node.id);
    if (!isUnderPrefix(directory, prefix)) {
      continue;
    }
    const relative = relativeToPrefix(directory, prefix);
    const blockRelative = relative.split('/').filter(Boolean).slice(0, depth).join('/');
    const block = joinBlock(prefix, blockRelative);
    mapping.set(node.id, block);

    const previous = aggregateKind.get(block);
    const kind = node.kind === 'test' ? 'test' : 'module';
    if (previous === undefined) {
      aggregateKind.set(block, kind);
    } else if (previous !== kind) {
      // A block with any non-test member is a module block.
      aggregateKind.set(block, 'module');
    }
  }

  const nodes: GraphNode[] = [...mapping.values()]
    .filter((block, index, all) => all.indexOf(block) === index)
    .sort()
    .map((id) => ({
      id,
      kind: aggregateKind.get(id) ?? 'module',
      directory: parentOf(id),
    }));

  const aggregated: Graph = { nodes, edges: [], diagnostics: graph.diagnostics, excluded: graph.excluded };
  const edgeKeys = new Set<string>();
  for (const edge of graph.edges) {
    const source = mapping.get(edge.source);
    const target = mapping.get(edge.target);
    if (!source || !target || source === target) {
      continue;
    }
    const key = `${source}\u0000${target}`;
    if (edgeKeys.has(key)) {
      continue;
    }
    edgeKeys.add(key);
    aggregated.edges.push({ ...edge, source, target });
  }
  aggregated.edges.sort(
    (a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
  );

  const metrics = computeGraphMetrics(aggregated, buildAdjacency(aggregated));
  const palette = assignPaletteIndexes(
    new Map(aggregated.nodes.map((node) => [node.id, blockRegion(node.id)])),
  );
  const viewNodes: ViewNode[] = aggregated.nodes.map((node) => ({
    ...node,
    paletteIndex: palette.get(node.id) ?? 0,
    workspacePath: node.id,
    fanIn: metrics.fanIn.get(node.id) ?? 0,
    fanOut: metrics.fanOut.get(node.id) ?? 0,
    transitiveDependencies: metrics.transitiveDependencies.get(node.id) ?? 0,
    transitiveDependents: metrics.transitiveDependents.get(node.id) ?? 0,
  }));
  const edges: ViewEdge[] = aggregated.edges.map((edge) => ({
    ...edge,
    semanticSource: edge.source,
    semanticTarget: edge.target,
  }));
  const positions: ViewPosition[] = buildPositions(aggregated);

  return {
    prefixLength: depth,
    repository: meta.repository,
    nodes: viewNodes,
    edges,
    positions,
    cache: meta.cache,
  };
}

export function hubsOf(graph: Graph): string[] {
  return rankHubs(computeGraphMetrics(graph));
}

function normalizePrefix(prefix?: string): string {
  return (prefix ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function directoryOf(id: string): string {
  const index = id.lastIndexOf('/');
  return index === -1 ? '' : id.slice(0, index);
}

function isUnderPrefix(directory: string, prefix: string): boolean {
  return prefix === '' || directory === prefix || directory.startsWith(`${prefix}/`);
}

function relativeToPrefix(directory: string, prefix: string): string {
  return prefix === '' ? directory : directory.slice(prefix.length).replace(/^\/+/, '');
}

function joinBlock(prefix: string, blockRelative: string): string {
  if (!blockRelative) {
    return prefix || '.';
  }
  return prefix ? `${prefix}/${blockRelative}` : blockRelative;
}

function parentOf(block: string): string {
  if (block === '.') {
    return '.';
  }
  const index = block.lastIndexOf('/');
  return index === -1 ? '.' : block.slice(0, index);
}
