import { computeMeasuredCoverage } from '../../analysis/measured-coverage.ts';
import { resolveRepositoryRoot, type ResolvedRepository } from '../../boundary/repository-root.ts';
import { getCachedGraph, type CachedGraph } from '../../cache/graph-cache.ts';
import { computeFreshness, revisionFromFingerprint } from '../../status.ts';
import type { GraphProvenance } from '../../analysis/review-types.ts';
import type { Graph, StraboConfig } from '../../types.ts';

/** The shared dependencies every analysis route factory is handed. */
export interface AnalysisContext {
  config: StraboConfig;
  resolve(request: { query: Record<string, unknown> }): ResolvedRepository;
  measuredCoverage(
    repository: { root: string },
    graph: Graph,
    files?: readonly string[],
  ): Promise<Awaited<ReturnType<typeof computeMeasuredCoverage>>>;
}

/**
 * The graph fingerprint and scan time behind a served passport, plus a staleness comparison
 * against the working tree now. Reuses `computeFreshness`, so a passport reads the same
 * revision, behind count, and stale flag the global freshness badge shows.
 */
export async function graphProvenance(
  root: string,
  cached: Pick<CachedGraph, 'fingerprint' | 'report'>,
): Promise<GraphProvenance> {
  const freshness = await computeFreshness(root, cached.fingerprint, cached.report.scannedAt);
  return {
    fingerprint: cached.fingerprint,
    revision: revisionFromFingerprint(cached.fingerprint),
    scannedAt: cached.report.scannedAt,
    currentFingerprint: freshness.current.fingerprint,
    behind: freshness.behind,
    stale: freshness.stale,
  };
}

export function createAnalysisContext(config: StraboConfig): AnalysisContext {
  const resolve = (request: { query: Record<string, unknown> }) =>
    resolveRepositoryRoot({
      workspaceRoot: config.workspaceRoot,
      scanCeiling: config.scanCeiling ?? config.workspaceRoot,
      requested: typeof request.query.repository === 'string' ? request.query.repository : undefined,
    });

  /**
   * Read the repository's existing coverage report, bounded by the scan ceiling. `files`
   * limits the staleness `git log` to the files a caller needs (e.g. one file for `/symbols`).
   */
  const measuredCoverage = (repository: { root: string }, graph: Graph, files?: readonly string[]) =>
    computeMeasuredCoverage(repository.root, graph, {
      reportPaths: config.coverageReports,
      ceiling: config.scanCeiling ?? config.workspaceRoot,
      ...(files ? { files } : {}),
    });

  return { config, resolve, measuredCoverage };
}

/** A repeated or comma-separated query value, as a list of non-empty globs. */
export function expectValues(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return raw.map((entry) => String(entry).trim()).filter((entry) => entry !== '');
}

/** A 0-1 ratio query parameter, or undefined so the builder's default stands. */
export function parseRatio(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}
