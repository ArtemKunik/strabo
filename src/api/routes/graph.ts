import { Router } from 'express';
import fs from 'node:fs';

import { buildBlockViewModel } from '../../analysis/blocks.ts';
import { assertReadable, resolveRepositoryRoot } from '../../boundary/repository-root.ts';
import { CACHE_ARTIFACT_VERSION, getCachedGraph } from '../../cache/graph-cache.ts';
import { describeRepository } from '../../repository.ts';
import type { ScanCacheMetadata, StraboConfig } from '../../types.ts';
import { buildViewModel } from '../../view/view-model.ts';
import { parseBoolean, parsePositiveInt, sendError } from '../http.ts';

/**
 * Graph route: resolve a repository, get its graph through the cache, add
 * workspace-relative node paths, and derive the presentation model.
 *
 * Optional `blockDepth`/`blockPrefix` request a rolled-up path-block graph and permit
 * drill-down by one path segment; a normal file graph must not pay for roll-up work.
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

      const blockDepth = parsePositiveInt(request.query.blockDepth);
      if (blockDepth) {
        response.json(
          buildBlockViewModel(
            cached.report.graph,
            {
              depth: blockDepth,
              prefix: asString(request.query.blockPrefix),
            },
            { repository: descriptor, cache },
          ),
        );
        return;
      }

      response.json(buildViewModel(repository.root, cached.report, descriptor, cache));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/source', async (request, response) => {
    try {
      const repository = resolveRepositoryRoot({
        workspaceRoot: config.workspaceRoot,
        scanCeiling: config.scanCeiling ?? config.workspaceRoot,
        requested: asString(request.query.repository),
      });
      const requested = asString(request.query.file);
      if (!requested) {
        response.status(400).json({ error: 'file query parameter is required.' });
        return;
      }
      const absolute = assertReadable(repository.root, requested);
      response.json({ file: requested, content: fs.readFileSync(absolute, 'utf8') });
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
