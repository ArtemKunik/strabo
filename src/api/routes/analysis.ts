import { Router } from 'express';
import fs from 'node:fs';

import { computeCoverage } from '../../analysis/coverage.ts';
import { computeCycles } from '../../analysis/cycles.ts';
import { analyzeModuleDepth } from '../../analysis/depth.ts';
import { computeFileHealth } from '../../analysis/file-health.ts';
import { computeArchitectureHealth } from '../../analysis/health.ts';
import { computeImpact } from '../../analysis/impact.ts';
import { getTimeline } from '../../analysis/timeline.ts';
import { computeOwnership, getFileAuthorHistory } from '../../analysis/ownership.ts';
import { assertReadable, resolveRepositoryRoot } from '../../boundary/repository-root.ts';
import { getCachedGraph } from '../../cache/graph-cache.ts';
import { symbolExtractorFor } from '../../scan/languages/registry.ts';
import type { CodeSymbol, MemberAccess } from '../../scan/languages/symbols.ts';
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

  /**
   * Architecture health for one file. Symbol extraction runs here so the cohesion axis can
   * be derived from recorded member wiring; a file without an extractor keeps cohesion
   * unavailable rather than scoring it as zero.
   */
  router.get('/analysis/file-health', async (request, response) => {
    try {
      const repository = resolve(request);
      const file = typeof request.query.file === 'string' ? request.query.file : '';
      if (!file) {
        response.status(400).json({ error: 'file query parameter is required.' });
        return;
      }
      const cached = await getCachedGraph(repository.root);
      let symbols: CodeSymbol[] = [];
      let accesses: MemberAccess[] = [];
      const extractor = symbolExtractorFor(file);
      if (extractor) {
        try {
          const content = fs.readFileSync(assertReadable(repository.root, file), 'utf8');
          const result = await extractor.extract(file, content);
          symbols = result.symbols;
          accesses = result.accesses ?? [];
        } catch {
          // The file may be binary or unreadable; cohesion stays unavailable.
        }
      }
      response.json(computeFileHealth(cached.report.graph, file, symbols, accesses));
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
