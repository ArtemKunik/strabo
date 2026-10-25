import type { Graph, GraphNode, RepositoryDescriptor, ScanCacheMetadata } from '../types.ts';
import type { BlockViewModel, ViewEdge, ViewNode, ViewPosition } from '../types/view.ts';
import { buildAdjacency, computeGraphMetrics, rankHubs } from './analysis.ts';
import { buildLayeredPositions } from './layered-layout.ts';

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
      ...blockLabel(id, prefix),
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
  const dependentFiles = outsideDependentFiles(graph, mapping);
  const viewNodes: ViewNode[] = aggregated.nodes.map((node) => ({
    ...node,
    workspacePath: node.id,
    fanIn: metrics.fanIn.get(node.id) ?? 0,
    fanOut: metrics.fanOut.get(node.id) ?? 0,
    transitiveDependencies: metrics.transitiveDependencies.get(node.id) ?? 0,
    transitiveDependents: metrics.transitiveDependents.get(node.id) ?? 0,
    dependentFiles: dependentFiles.get(node.id) ?? 0,
  }));
  const edges: ViewEdge[] = aggregated.edges.map((edge) => ({
    ...edge,
    semanticSource: edge.source,
    semanticTarget: edge.target,
  }));
  const positions: ViewPosition[] = buildLayeredPositions(aggregated);

  return {
    prefixLength: depth,
    repository: meta.repository,
    nodes: viewNodes,
    edges,
    positions,
    cache: meta.cache,
  };
}

/**
 * Inside a drill-down every block shares the prefix the breadcrumb already shows, so it is
 * named relative to it (`api`, not `src/api`). A label wins over the route's unit-anchored
 * directory labels, which only matter at the top level.
 */
function blockLabel(id: string, prefix: string): { label?: string } {
  if (id === '.') return { label: '(root files)' };
  if (prefix === '') return {};
  if (id === prefix) return { label: `(files in ${prefix})` };
  return { label: id.slice(prefix.length + 1) };
}

/**
 * For each block, how many files outside it depend on one of its files, directly or
 * transitively, counted over the whole file graph so a drill-down still sees its callers
 * outside the prefix. Block-to-block reachability tops out at the handful of blocks on the
 * map; this is the number the "size = dependents" legend promises.
 */
function outsideDependentFiles(graph: Graph, mapping: ReadonlyMap<string, string>): Map<string, number> {
  const { backward } = buildAdjacency(graph);
  const members = new Map<string, string[]>();
  for (const [file, block] of mapping) {
    const list = members.get(block);
    if (list) list.push(file);
    else members.set(block, [file]);
  }
  const counts = new Map<string, number>();
  for (const [block, files] of members) {
    const seen = new Set<string>(files);
    const queue = [...files];
    let outside = 0;
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const dependent of backward.get(current) ?? []) {
        if (seen.has(dependent)) continue;
        seen.add(dependent);
        queue.push(dependent);
        if (mapping.get(dependent) !== block) outside += 1;
      }
    }
    counts.set(block, outside);
  }
  return counts;
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
