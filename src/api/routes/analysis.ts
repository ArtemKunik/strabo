import { Router } from 'express';
import fs from 'node:fs';

import { computeCoverage } from '../../analysis/coverage.ts';
import { computeChangePassport } from '../../analysis/change-passport.ts';
import {
  computeCommitMetrics,
  computeMetricsHistory,
  computeWorkingTreeMetrics,
} from '../../analysis/change-metrics.ts';
import { computeCycles } from '../../analysis/cycles.ts';
import { analyzeModuleDepth } from '../../analysis/depth.ts';
import { computeFileHealth } from '../../analysis/file-health.ts';
import { buildFunctions, type FunctionsReport } from '../../analysis/functions.ts';
import { rankHotspots } from '../../analysis/hotspots.ts';
import { buildSystemReport } from '../../analysis/system.ts';
import { buildTierReport } from '../../analysis/tiers.ts';
import { computeArchitectureHealth } from '../../analysis/health.ts';
import { computeImpact } from '../../analysis/impact.ts';
import { collectRelatedSources } from '../../analysis/related-sources.ts';
import { getTimeline } from '../../analysis/timeline.ts';
import { reviewCommit, reviewWorkingTree } from '../../analysis/review.ts';
import { computeOwnership, getFileAuthorHistory } from '../../analysis/ownership.ts';
import { computeQualityScorecard, smellsFromScorecard } from '../../analysis/quality.ts';
import { computeRepositoryPassport } from '../../analysis/passport.ts';
import { assertReadable, resolveRepositoryRoot } from '../../boundary/repository-root.ts';
import { getCachedGraph } from '../../cache/graph-cache.ts';
import { symbolExtractorFor } from '../../scan/languages/registry.ts';
import type { CodeSymbol, MemberAccess } from '../../scan/languages/symbols.ts';
import type { StraboConfig } from '../../types.ts';
import { parseBoolean, parsePositiveInt, sendError } from '../http.ts';

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

  /**
   * The repository passport: languages, size, entry points, layers, top files by fan-in,
   * cycles, and what no test reaches. The opening summary for an unfamiliar repository.
   */
  router.get('/analysis/passport', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const limit = parsePositiveInt(request.query.limit, 10) ?? 10;
      response.json(
        computeRepositoryPassport(
          repository.name,
          cached.report.graph,
          cached.report.extensionCounts,
          limit,
        ),
      );
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
   * The tier lens: each file's role (frontend, API, data, …) from its strongest evidence,
   * rolled up per build unit with the unit's role. Files with no evidence stay unclassified.
   */
  router.get('/analysis/tiers', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      response.json(buildTierReport(repository.root, repository.name, cached.report.graph));
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
          const related = extractor.usesRelatedSources
            ? collectRelatedSources(repository.root, cached.report.graph, file)
            : undefined;
          const result = await extractor.extract(file, content, related ? { related } : undefined);
          symbols = result.symbols;
          accesses = result.accesses ?? [];
        } catch {
          // The file may be binary or unreadable; cohesion stays unavailable.
        }
      }
      const cohesionUnavailable =
        extractor?.tracksAccess === false
          ? `not measured: ${extractor.language} members have no methods that read or write them`
          : undefined;
      response.json(computeFileHealth(cached.report.graph, file, symbols, accesses, cohesionUnavailable));
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Repository-wide function hotspots.
   *
   * Symbol extraction is on demand, so this extracts every supported source file in the
   * graph (bounded), derives each function's signals, and ranks them. Files without an
   * extractor, or that cannot be read, are counted as skipped rather than silently dropped.
   */
  router.get('/analysis/functions', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const limit = parsePositiveInt(request.query.limit, 50) ?? 50;
      const scannedCeiling = 400;

      const candidates = cached.report.graph.nodes
        .map((node) => node.id)
        .filter((file) => symbolExtractorFor(file) !== null)
        .sort();
      const selected = candidates.slice(0, scannedCeiling);

      const reports: FunctionsReport[] = [];
      let skipped = candidates.length - selected.length;
      for (const file of selected) {
        const extractor = symbolExtractorFor(file);
        if (!extractor) {
          skipped += 1;
          continue;
        }
        try {
          const content = fs.readFileSync(assertReadable(repository.root, file), 'utf8');
          const result = await extractor.extract(file, content);
          reports.push(buildFunctions(file, result.symbols, result.calls ?? []));
        } catch {
          skipped += 1;
        }
      }

      response.json(
        rankHotspots(reports, {
          limit,
          filesScanned: selected.length,
          filesSkipped: skipped,
        }),
      );
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

  /**
   * Review a commit's own changes, or the working tree.
   *
   * `base` reviews that revision against its first parent; omitting it reviews the working
   * tree, split into staged, unstaged, and untracked. Either way the result carries the
   * same reverse-dependency impact the change-impact overlay computes.
   */
  router.get('/analysis/review', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const base = typeof request.query.base === 'string' ? request.query.base : '';
      const review = base
        ? await reviewCommit(repository.root, cached.report.graph, base)
        : await reviewWorkingTree(repository.root, cached.report.graph);
      if (!review.available) {
        response.json(review);
        return;
      }
      // The baseline matches the review's own comparison: HEAD for the working tree, and
      // the first parent for a commit (which `^` names for a merge and fails on the root).
      const baseline = base ? `${base}^` : 'HEAD';
      const cohesion = await computeChangePassport(repository.root, review.files, baseline, cached.report.graph);
      const metrics = base
        ? await computeCommitMetrics(repository.root, base)
        : await computeWorkingTreeMetrics(repository.root, review.files);
      response.json({ ...review, cohesion, metrics });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Quantitative change impact: complexity, function, signal, line, and coupling deltas per
   * changed file and for the whole change set. `base` measures that commit against its
   * first parent (cached by commit hash); omitting it measures the working tree against HEAD.
   */
  router.get('/analysis/change-metrics', async (request, response) => {
    try {
      const repository = resolve(request);
      const base = typeof request.query.base === 'string' ? request.query.base : '';
      if (base) {
        response.json(await computeCommitMetrics(repository.root, base));
        return;
      }
      const cached = await getCachedGraph(repository.root);
      const review = await reviewWorkingTree(repository.root, cached.report.graph);
      response.json(review.available ? await computeWorkingTreeMetrics(repository.root, review.files) : review);
    } catch (error) {
      sendError(response, error);
    }
  });

  /** Change metric totals for each recent commit, newest first: the retrospective view. */
  router.get('/analysis/change-metrics/history', async (request, response) => {
    try {
      const repository = resolve(request);
      const limit = parsePositiveInt(request.query.limit, 200) ?? 30;
      const timeline = await getTimeline(repository.root, limit);
      if (!timeline.available) {
        response.json(timeline);
        return;
      }
      response.json({ available: true, commits: await computeMetricsHistory(repository.root, timeline.commits) });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Quality scorecard: per-module measures ranked as repository percentiles.
   */
  router.get('/analysis/quality', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const scorecard = await computeQualityScorecard(
        cached.report.graph,
        repository.root,
        repository.name,
      );
      response.json(scorecard);
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Repository-wide smells: the scorecard's per-module rules, each with its tripping inputs.
   */
  router.get('/analysis/smells', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const scorecard = await computeQualityScorecard(
        cached.report.graph,
        repository.root,
        repository.name,
      );
      response.json(smellsFromScorecard(scorecard));
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
