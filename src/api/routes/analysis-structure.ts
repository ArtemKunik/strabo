import { Router } from 'express';

import { findDirectedPath } from '../../analysis/analysis.ts';
import { computeArchitectureHealth } from '../../analysis/health.ts';
import { computeRepositoryPassport } from '../../analysis/passport.ts';
import { computeReadingRoute } from '../../analysis/route.ts';
import { buildSystemReport } from '../../analysis/system.ts';
import { buildTierReport } from '../../analysis/tiers.ts';
import { computeCycles } from '../../analysis/cycles.ts';
import { analyzeModuleDepth } from '../../analysis/depth.ts';
import { computeOwnership, getFileAuthorHistory } from '../../analysis/ownership.ts';
import { getTimeline } from '../../analysis/timeline.ts';
import { collectRepositoryReport } from '../../report/collect.ts';
import { renderReportHtml } from '../../report/render-html.ts';
import { renderReportMarkdown } from '../../report/render-markdown.ts';
import { parseDeniedLicenses } from '../../risk/licenses.ts';
import { getCachedGraph } from '../../cache/graph-cache.ts';
import { parseBoolean, parsePositiveInt, sendError } from '../http.ts';
import { graphProvenance, type AnalysisContext } from './analysis-context.ts';

/** The repository overview, structure, and history endpoints. */
export function createStructureRouter(context: AnalysisContext): Router {
  const router = Router();
  const { config, resolve, measuredCoverage } = context;

  router.get('/analysis/cycles', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      response.json(computeCycles(cached.report.graph));
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * The shortest recorded dependency path between two files, breadth-first and bounded.
   * A missing path is a recorded answer (`found: false`), not an error.
   */
  router.get('/analysis/dependency-path', async (request, response) => {
    try {
      const repository = resolve(request);
      const from = typeof request.query.from === 'string' ? request.query.from : '';
      const to = typeof request.query.to === 'string' ? request.query.to : '';
      if (!from || !to) {
        response.status(400).json({ error: 'from and to query parameters are required.' });
        return;
      }
      const cached = await getCachedGraph(repository.root);
      const path = findDirectedPath(cached.report.graph, from, to);
      response.json({
        from,
        to,
        found: path !== null,
        path: path ?? [],
        hops: path ? path.length - 1 : null,
      });
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

  /**
   * The repository passport: languages, size, entry points, layers, top files by fan-in,
   * cycles, and what tests leave uncovered (measured when a report exists, else reachability).
   * The opening summary for an unfamiliar repository.
   */
  router.get('/analysis/passport', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const limit = parsePositiveInt(request.query.limit, 10) ?? 10;
      const measured = await measuredCoverage(repository, cached.report.graph);
      response.json({
        ...computeRepositoryPassport(
          repository.name,
          cached.report.graph,
          cached.report.extensionCounts,
          limit,
          measured,
        ),
        provenance: await graphProvenance(repository.root, cached),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * The whole-repository report: the recorded analyses composed into one document, as JSON
   * (default), Markdown, or self-contained HTML. The same document the CLI emits, so the two
   * surfaces cannot disagree. `change=0` omits the pending change set.
   */
  router.get('/analysis/report', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const provenance = await graphProvenance(repository.root, cached);
      const includeChange = request.query.change === undefined ? true : parseBoolean(request.query.change);
      const denied = parseDeniedLicenses(config.risk?.deniedLicenses?.join(','));
      const document = await collectRepositoryReport({
        repository: repository.name,
        root: repository.root,
        graph: cached.report.graph,
        extensionCounts: cached.report.extensionCounts,
        revision: {
          head: provenance.revision,
          fingerprint: provenance.fingerprint,
          scannedAt: provenance.scannedAt,
          stale: provenance.stale,
        },
        change: includeChange,
        risk: { online: config.risk?.online === true, deniedLicenses: denied },
        coverage: {
          ...(config.coverageReports ? { reportPaths: config.coverageReports } : {}),
          ceiling: config.scanCeiling ?? config.workspaceRoot,
        },
      });
      const format = typeof request.query.format === 'string' ? request.query.format : 'json';
      if (format === 'md') {
        response.type('text/markdown').send(renderReportMarkdown(document));
        return;
      }
      if (format === 'html') {
        response.type('text/html').send(renderReportHtml(document));
        return;
      }
      response.json(document);
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * The System view: build units, the import edges between them, layers inside each unit,
   * and the support shelf. Every group names the evidence that formed it.
   */
  router.get('/analysis/system', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      response.json(buildSystemReport(repository.root, repository.name, cached.report.graph));
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * The reading route: an outward topological walk from every declared entry point, each
   * file naming the importer and depth that reached it, its recorded fan-in, tier, and unit.
   * The walk follows recorded import edges only, and files no entry point reaches are returned
   * separately rather than forced into the order. A per-layer `limit` bounds a wide layer.
   */
  router.get('/analysis/route', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const layerLimit = parsePositiveInt(request.query.limit, 25) ?? 25;
      response.json(
        computeReadingRoute(repository.root, repository.name, cached.report.graph, { layerLimit }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * The tier lens: each file's role (frontend, API, data, …) from its strongest evidence,
   * rolled up per build unit with the unit's role. Files with no evidence stay unclassified.
   */
  router.get('/analysis/tiers', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      // The matrix cells and per-tier stats read the measured report when one exists, else
      // the labelled reach fallback; the report is read once here, never inside the analysis.
      const measured = await measuredCoverage(repository, cached.report.graph);
      response.json(buildTierReport(repository.root, repository.name, cached.report.graph, measured));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/analysis/architecture-health', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const measured = await measuredCoverage(repository, cached.report.graph);
      response.json(computeArchitectureHealth(cached.report.graph, measured));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/analysis/timeline', async (request, response) => {
    try {
      const repository = resolve(request);
      const limit = parsePositiveInt(request.query.limit, 100);
      response.json(await getTimeline(repository.root, limit ?? 30));
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
