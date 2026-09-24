import { Router } from 'express';

import { buildBlockViewModel } from '../../analysis/blocks.ts';
import { computeMeasuredCoverage } from '../../analysis/measured-coverage.ts';
import { buildSystemReport } from '../../analysis/system.ts';
import { buildBlockLabels, buildDirectoryLabels } from '../../analysis/units.ts';
import { resolveRepositoryRoot } from '../../boundary/repository-root.ts';
import { CACHE_ARTIFACT_VERSION, getCachedGraph } from '../../cache/graph-cache.ts';
import { describeRepository } from '../../repository.ts';
import type { ScanCacheMetadata, StraboConfig } from '../../types.ts';
import { buildSystemUnitViewModel, buildSystemViewModel, buildViewModel } from '../../view/view-model.ts';
import { parseBoolean, parsePositiveInt, sendError } from '../http.ts';

/**
 * Graph route: resolve a repository, get its graph through the cache, add
 * workspace-relative node paths, and derive the presentation model.
 *
 * Optional `blockDepth`/`blockPrefix` request a rolled-up path-block graph and permit
 * drill-down by one path segment; a normal file graph must not pay for roll-up work.
 * `system=1` rolls up to build units; `systemUnit=<id>` opens one unit's files, and
 * `outside=1` with `selected=<file>` attaches that file's cross-unit links.
 */
export function createGraphRouter(config: StraboConfig): Router {
  const router = Router();

  router.get('/graph', async (request, response) => {
    try {
      const repository = resolveRepositoryRoot({
        workspaceRoot: config.workspaceRoot,
        scanCeiling: config.scanCeiling ?? config.workspaceRoot,
        configPath: config.configPath,
        requested: asString(request.query.repository) ?? asString(request.query.path),
      });

      const cached = await getCachedGraph(repository.root, {
        refresh: parseBoolean(request.query.refresh),
      });
      const descriptor = await describeRepository(repository.root);
      const cache: ScanCacheMetadata = {
        status: cached.status,
        fingerprint: cached.fingerprint,
        artifactVersion: CACHE_ARTIFACT_VERSION,
        generatedAt: cached.report.scannedAt,
        stale: cached.stale,
      };

      // The System view rolls the file graph up into build units; it takes precedence over
      // any block-depth parameters a stale URL still carries.
      const systemUnit = asString(request.query.systemUnit);
      if (parseBoolean(request.query.system) || systemUnit) {
        const report = buildSystemReport(repository.root, repository.name, cached.report.graph);
        // Unit cards sum lines, so per-file staleness (a `git log` per file) is not read here.
        const measured = await computeMeasuredCoverage(repository.root, cached.report.graph, {
          reportPaths: config.coverageReports,
          ceiling: config.scanCeiling ?? config.workspaceRoot,
          maxStalenessFiles: 0,
        });
        if (systemUnit) {
          const model = buildSystemUnitViewModel(
            report,
            cached.report.graph,
            systemUnit,
            descriptor,
            cache,
            {
              showOutside: parseBoolean(request.query.outside),
              selectedFile: asString(request.query.selected),
              expandedUnits: asString(request.query.expanded)?.split(',').filter(Boolean),
              measured,
            },
          );
          if (model) {
            response.json(model);
            return;
          }
        }
        response.json(buildSystemViewModel(report, descriptor, cache, cached.report.graph, measured));
        return;
      }

      const files = cached.report.graph.nodes.map((node) => node.id);

      const blockDepth = parsePositiveInt(request.query.blockDepth, 5);
      if (blockDepth) {
        const model = buildBlockViewModel(
          cached.report.graph,
          {
            depth: blockDepth,
            prefix: asString(request.query.blockPrefix),
          },
          { repository: descriptor, cache },
        );
        model.directoryLabels = buildBlockLabels(
          repository.root,
          files,
          repository.name,
          model.nodes.map((node) => node.id),
        );
        response.json(model);
        return;
      }

      const model = buildViewModel(repository.root, cached.report, descriptor, cache);
      model.directoryLabels = buildDirectoryLabels(repository.root, files, repository.name);
      response.json(model);
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
