import { Router } from 'express';

import { computeRiskReport } from '../../risk/report.ts';
import { createLicenseClient, parseDeniedLicenses } from '../../risk/licenses.ts';
import { createOsvClient } from '../../risk/osv.ts';
import { resolveRepositoryRoot } from '../../boundary/repository-root.ts';
import { getCachedGraph } from '../../cache/graph-cache.ts';
import type { StraboConfig } from '../../types.ts';
import { sendError } from '../http.ts';

/**
 * Dependency risk: advisories, licenses, and the files that import each dependency.
 *
 * Inventory and file mapping are offline. Advisories and licenses require the opt-in
 * `risk.online` setting; when it is off the report says so instead of returning empty
 * findings that would look like a clean bill of health.
 */
export function createRiskRouter(config: StraboConfig): Router {
  const router = Router();
  const denied = parseDeniedLicenses(config.risk?.deniedLicenses?.join(','));
  // Settings toggles `config.risk.online` at runtime, so it is read per request; the
  // clients are created on first online use and kept for their caches.
  let osv: ReturnType<typeof createOsvClient> | undefined;
  let licenses: ReturnType<typeof createLicenseClient> | undefined;

  router.get('/analysis/risk', async (request, response) => {
    try {
      const online = config.risk?.online === true;
      if (online) {
        osv ??= createOsvClient({ log: config.serverLog });
        licenses ??= createLicenseClient({ log: config.serverLog });
      }
      const repository = resolveRepositoryRoot({
        workspaceRoot: config.workspaceRoot,
        scanCeiling: config.scanCeiling ?? config.workspaceRoot,
        requested: typeof request.query.repository === 'string' ? request.query.repository : undefined,
      });
      const cached = await getCachedGraph(repository.root);
      response.json(
        await computeRiskReport(repository.root, cached.report.graph, {
          online,
          deniedLicenses: denied,
          ...(osv ? { osv } : {}),
          ...(licenses ? { licenses } : {}),
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
