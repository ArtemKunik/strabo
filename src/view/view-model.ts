import { buildAdjacency, computeGraphMetrics, rankHubs } from '../analysis/analysis.ts';
import { buildPositions } from '../analysis/layout.ts';
import type { SystemReport } from '../analysis/system.ts';

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
): ViewModel {
  const graph: Graph = {
    nodes: system.units.map((unit) => ({
      id: unit.id,
      kind: 'module',
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
  const positions = buildPositions(graph);
  const hubs = rankHubs(metrics);
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
    diagnostics: [],
    excluded: [],
    cache,
    system: true,
  };
}
