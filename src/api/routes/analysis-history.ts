import { Router } from 'express';

import { buildCoChangeEdges } from '../../analysis/co-change.ts';
import { collectDrift } from '../../analysis/drift.ts';
import { collectHistory } from '../../analysis/history.ts';
import { checkDeclaredRules, readDeclaredRules } from '../../analysis/rules.ts';
import { computeStringEdges } from '../../analysis/string-edges.ts';
import { getCachedGraph } from '../../cache/graph-cache.ts';
import { parsePositiveInt, sendError } from '../http.ts';
import { parseRatio, type AnalysisContext } from './analysis-context.ts';

/** Co-change, string-edge, declared-rule, and drift endpoints. */
export function createHistoryRouter(context: AnalysisContext): Router {
  const router = Router();
  const { resolve } = context;

  /**
   * Co-change edges: files that change together, each edge carrying the commits behind it.
   *
   * `minCommits` and `ratio` are the knobs (both default conservative). A pair with no
   * listable commits is not drawn, and a pair no import path joins in either direction is
   * flagged `hidden` for the review overlay. Mass commits are named in `skippedCommits`.
   */
  router.get('/analysis/co-change', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const files = cached.report.graph.nodes.map((node) => node.id);
      const summary = await collectHistory(repository.root, files, {
        windowDays: parsePositiveInt(request.query.window, 365) ?? 365,
      });
      const report = buildCoChangeEdges(summary, cached.report.graph, {
        minCommits: parsePositiveInt(request.query.minCommits, 3),
        minRatio: parseRatio(request.query.ratio),
      });
      response.json({ repository: repository.name, ...report });
    } catch (error) {
      sendError(response, error);
    }
  });

  /** String-typed edges (Phase 30 H1-H3): environment variables, HTTP routes, feature flags. */
  router.get('/analysis/string-edges', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      response.json(await computeStringEdges(repository.root, cached.report.graph));
    } catch (error) {
      sendError(response, error);
    }
  });

  /** Declared architecture (Phase 30 H4): the operator's rules and the observed violations. */
  router.get('/analysis/rules', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const rules = readDeclaredRules(repository.root);
      const stringEdges = rules.length > 0 ? await computeStringEdges(repository.root, cached.report.graph) : null;
      response.json(checkDeclaredRules(rules, cached.report.graph, { stringEdges }));
    } catch (error) {
      sendError(response, error);
    }
  });

  /** Architecture drift (Phase 31 O2): one structural measure per cached revision. */
  router.get('/analysis/drift', async (request, response) => {
    try {
      const repository = resolve(request);
      const base = typeof request.query.base === 'string' && request.query.base ? request.query.base : null;
      response.json(
        await collectDrift(repository.root, repository.name, {
          limit: parsePositiveInt(request.query.limit, 100),
          base,
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
