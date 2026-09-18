import { Router } from 'express';

import { computeCoverage } from '../../analysis/coverage.ts';
import { computeCycles } from '../../analysis/cycles.ts';
import { analyzeModuleDepth } from '../../analysis/depth.ts';
import { computeArchitectureHealth } from '../../analysis/health.ts';
import { computeImpact } from '../../analysis/impact.ts';
import { getTimeline } from '../../analysis/timeline.ts';
import { computeOwnership, getFileAuthorHistory } from '../../analysis/ownership.ts';
import { resolveRepositoryRoot } from '../../boundary/repository-root.ts';
import { getCachedGraph } from '../../cache/graph-cache.ts';
import type { StraboConfig } from '../../types.ts';
import { sendError } from '../http.ts';

/** Review-focused analyses. All of them inherit the scanner's scope. */
export function createAnalysisRouter(config: StraboConfig): Router {
  const router = Router();

  const resolve = (request: { query: Record<string, unknown> }) =>
    resolveRepositoryRoot({
      workspaceRoot: config.workspaceRoot,
      scanCeiling: config.scanCeiling ?? config.workspaceRoot,
      requested: typeof request.query.repository === 'string' ? request.query.repository : undefined,
    });

  router.get('/analysis/impact', async (request, response) => {
    try {
      const repository = resolve(request);
      const baseRef = typeof request.query.base === 'string' ? request.query.base : undefined;
      const cached = await getCachedGraph(repository.root);
      response.json(await computeImpact(repository.root, cached.report.graph, baseRef));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/analysis/test-reach', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      response.json(computeCoverage(cached.report.graph));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/analysis/cycles', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      response.json(computeCycles(cached.report.graph));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/analysis/module-depth', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const files = cached.report.graph.nodes.map((node) => node.id);
      response.json(analyzeModuleDepth(repository.root, files));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/analysis/ownership', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const files = cached.report.graph.nodes.map((node) => node.id);
      const history = await getFileAuthorHistory(repository.root, files);
      response.json(computeOwnership(history, cached.report.graph));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/analysis/architecture-health', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      response.json(computeArchitectureHealth(cached.report.graph));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/analysis/timeline', async (request, response) => {
    try {
      const repository = resolve(request);
      const limit = Number.parseInt(String(request.query.limit ?? ''), 10);
      response.json(await getTimeline(repository.root, Number.isFinite(limit) && limit > 0 ? limit : 30));
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
