import { buildBlockViewModel } from '../analysis/blocks.ts';
import { buildSystemReport } from '../analysis/system.ts';
import { CACHE_ARTIFACT_VERSION, type CachedGraph } from '../cache/graph-cache.ts';
import type { RepositoryDescriptor, ScanCacheMetadata, ViewModel } from '../types.ts';
import { buildSystemViewModel, buildViewModel } from '../view/view-model.ts';

export type ExportViewMode = 'file' | 'block' | 'system';

export interface SelectViewModelOptions {
  root: string;
  descriptor: RepositoryDescriptor;
  cached: CachedGraph;
  view?: string;
  blockDepth?: number;
  blockPrefix?: string;
}

export function selectViewModel(options: SelectViewModelOptions): ViewModel {
  const cache: ScanCacheMetadata = {
    status: options.cached.status,
    fingerprint: options.cached.fingerprint,
    artifactVersion: CACHE_ARTIFACT_VERSION,
    generatedAt: options.cached.report.scannedAt,
    stale: options.cached.stale,
  };
  const view = (options.view ?? 'file').toLowerCase();

  if (view === 'system') {
    const report = buildSystemReport(options.root, options.descriptor.name, options.cached.report.graph);
    return buildSystemViewModel(report, options.descriptor, cache, options.cached.report.graph);
  }
  if (view === 'block') {
    const block = buildBlockViewModel(
      options.cached.report.graph,
      { depth: options.blockDepth ?? 1, prefix: options.blockPrefix },
      { repository: options.descriptor, cache },
    );
    return {
      repository: block.repository ?? options.descriptor,
      nodes: block.nodes,
      edges: block.edges,
      positions: block.positions,
      hubs: [],
      diagnostics: [],
      excluded: [],
      cache: block.cache ?? cache,
    };
  }
  return buildViewModel(options.root, options.cached.report, options.descriptor, cache);
}
