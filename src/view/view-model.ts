import { buildAdjacency, computeGraphMetrics, rankHubs } from '../analysis/analysis.ts';
import { buildPositions } from '../analysis/layout.ts';
import { assignPaletteIndexes, topLevelDirectory } from '../analysis/palette.ts';
import { toPosix } from '../boundary/repository-root.ts';
import type {
  Graph,
  RepositoryDescriptor,
  ScanCacheMetadata,
  ScanReport,
  ViewEdge,
  ViewModel,
  ViewNode,
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
  const palette = assignPaletteIndexes(
    new Map(graph.nodes.map((node) => [node.id, topLevelDirectory(node.id)])),
  );

  const nodes: ViewNode[] = graph.nodes.map((node) => ({
    ...node,
    paletteIndex: palette.get(node.id) ?? 0,
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
