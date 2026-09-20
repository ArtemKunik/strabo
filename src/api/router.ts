import { Router } from 'express';

import { browseDirectories } from '../boundary/browse.ts';
import { loadCatalogue } from '../integrations/catalogue.ts';
import { createRepositoryStore, type RepositoryStore } from '../state/repository-store.ts';
import { createAnalysisRouter } from './routes/analysis.ts';
import { createDelegateRouter } from './routes/delegate.ts';
import { createGraphRouter } from './routes/graph.ts';
import { createLineageRouter } from './routes/lineage.ts';
import { createNarratorRouter } from './routes/narrator.ts';
import { createRepositoriesRouter } from './routes/repositories.ts';
import { createRiskRouter } from './routes/risk.ts';
import { createSettingsRouter } from './routes/settings.ts';
import { createSymbolsRouter } from './routes/symbols.ts';
import { createVulnerabilityRouter } from './routes/vulnerabilities.ts';
import { createWorkspaceRouter } from './routes/workspace.ts';
import type { StraboConfig } from '../types.ts';
import { sendError } from './http.ts';

/**
 * Compose routes; focused routers own lineage and depth endpoints.
 *
 * The identical router is mounted by the standalone server and by an embedded host.
 * A host may inject its own repository store so known repositories are shared rather
 * than re-read from disk on every mount.
 */
export function createStraboRouter(config: StraboConfig, store?: RepositoryStore): Router {
  const router = Router();
  const repositoryStore = store ?? createRepositoryStore();

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
  router.use(createRiskRouter(config));
  router.use(createDelegateRouter(config));
  router.use(createNarratorRouter(config));
  router.use(createSymbolsRouter(config));
  router.use(createRepositoriesRouter(config, repositoryStore));
  router.use(createSettingsRouter(config));
  router.use(createVulnerabilityRouter(config));
  router.use(createLineageRouter(config));
  router.use(createWorkspaceRouter(config));

  return router;
}
