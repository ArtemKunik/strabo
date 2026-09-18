import { Router } from 'express';

import { resolveRepositoryRoot } from '../../boundary/repository-root.ts';
import { getCachedGraph } from '../../cache/graph-cache.ts';
import { getVulnerabilities } from '../../integrations/vulnerability.ts';
import { describeRepository } from '../../repository.ts';
import type { StraboConfig } from '../../types.ts';
import { sendError } from '../http.ts';

/**
 * The vulnerabilities route uses the same repository boundary. A provider error is
 * isolated to this endpoint and must not disable graph scanning.
 */
export function createVulnerabilityRouter(config: StraboConfig): Router {
  const router = Router();

  router.get('/vulnerabilities', async (request, response) => {
    try {
      const repository = resolveRepositoryRoot({
        workspaceRoot: config.workspaceRoot,
        scanCeiling: config.scanCeiling ?? config.workspaceRoot,
        configPath: config.configPath,
      });
      const descriptor = await describeRepository(repository.root);
      const cached = await getCachedGraph(repository.root);
      const result = await getVulnerabilities(
        config.integrations ?? {},
        descriptor,
        cached.report.graph,
        config.serverLog,
      );
      response.json(result);
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
