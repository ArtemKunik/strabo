import { Router } from 'express';

import { browseDirectories } from '../boundary/browse.ts';
import { loadCatalogue } from '../integrations/catalogue.ts';
import { createAnalysisRouter } from './routes/analysis.ts';
import { createGraphRouter } from './routes/graph.ts';
import { createLineageRouter } from './routes/lineage.ts';
import { createSymbolsRouter } from './routes/symbols.ts';
import { createVulnerabilityRouter } from './routes/vulnerabilities.ts';
import type { StraboConfig } from '../types.ts';
import { sendError } from './http.ts';

/**
 * Compose routes; focused routers own lineage and depth endpoints.
 *
 * The identical router is mounted by the standalone server and by an embedded host.
 */
export function createStraboRouter(config: StraboConfig): Router {
  const router = Router();

  router.get('/health', (_request, response) => {
    response.json({ ok: true });
  });

  router.get('/catalogue', async (_request, response) => {
    try {
      response.json(await loadCatalogue(config.integrations ?? {}, config.workspaceRoot, config.serverLog));
    } catch (error) {
      sendError(response, error);
    }
  });

  /** Directory listing for the folder-selection dialog, bounded by the scan ceiling. */
  router.get('/browse', (request, response) => {
    try {
      response.json(
        browseDirectories({
          ceiling: config.scanCeiling ?? config.workspaceRoot,
          requested: typeof request.query.path === 'string' ? request.query.path : undefined,
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.use(createGraphRouter(config));
  router.use(createAnalysisRouter(config));
  router.use(createSymbolsRouter(config));
  router.use(createVulnerabilityRouter(config));
  router.use(createLineageRouter(config));

  return router;
}
