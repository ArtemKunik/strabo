import { Router } from 'express';

import { openWorkspaceCache } from '../../cache/workspace-cache.ts';
import type { StraboConfig } from '../../types.ts';
import { analyzeWorkspace } from '../../workspace/analyze.ts';
import { resolveWorkspaceRepositories } from '../../workspace/config.ts';
import { sendError } from '../http.ts';

/**
 * Multi-repository analysis.
 *
 * The workspace is the explicitly declared repository list (`STRABO_CONFIG`), or the single
 * configured root when none is given. Cross-repo flows are package publish/consume edges
 * resolved from recorded manifests and imports; contract drift compares the data contracts
 * repositories share; service flows join a recorded outbound HTTP call to an endpoint a
 * sibling declares in its OpenAPI document. All of them report only what the scan recorded.
 */
export function createWorkspaceRouter(config: StraboConfig): Router {
  const router = Router();

  router.get('/workspace', async (_request, response) => {
    try {
      const { name, repositories } = resolveWorkspaceRepositories(config);
      response.json(await analyzeWorkspace(name, repositories, { cache: openWorkspaceCache() }));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/workspace/contracts', async (_request, response) => {
    try {
      const { name, repositories } = resolveWorkspaceRepositories(config);
      const report = await analyzeWorkspace(name, repositories, { cache: openWorkspaceCache() });
      response.json({
        name: report.name,
        repositories: report.repositories.map((entry) => entry.name),
        contracts: report.contracts,
        drift: report.drift,
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/workspace/services', async (_request, response) => {
    try {
      const { name, repositories } = resolveWorkspaceRepositories(config);
      const report = await analyzeWorkspace(name, repositories, { cache: openWorkspaceCache() });
      response.json({
        name: report.name,
        repositories: report.repositories.map((entry) => entry.name),
        endpoints: report.serviceEndpoints,
        flows: report.serviceFlows,
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
