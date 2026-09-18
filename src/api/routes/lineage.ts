import { Router } from 'express';

import { getCachedGraph } from '../../cache/graph-cache.ts';
import { getLineage } from '../../integrations/lineage-pack.ts';
import type { Graph, StraboConfig } from '../../types.ts';
import { sendError } from '../http.ts';

/**
 * Lineage is emitted only when an explicit pack is passed to the host. The pack
 * declares the repositories it inspects; none are inferred.
 */
export function createLineageRouter(config: StraboConfig): Router {
  const router = Router();

  router.get('/lineage', async (_request, response) => {
    try {
      const pack = config.integrations?.lineagePack;
      const graphs = new Map<string, Graph>();
      if (pack) {
        for (const root of pack.repositories) {
          const cached = await getCachedGraph(root);
          graphs.set(root, cached.report.graph);
        }
      }
      response.json(await getLineage(config.integrations ?? {}, graphs, config.serverLog));
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
