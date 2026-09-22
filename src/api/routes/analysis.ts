import { Router } from 'express';
import fs from 'node:fs';

import { findDirectedPath } from '../../analysis/analysis.ts';
import { computeCoverage } from '../../analysis/coverage.ts';
import { computeChangePassport } from '../../analysis/change-passport.ts';
import {
  computeCommitMetrics,
  computeMetricsHistory,
  computeRangeMetrics,
  computeWorkingTreeMetrics,
} from '../../analysis/change-metrics.ts';
import { listBranches, reviewBranch } from '../../analysis/branches.ts';
import { fetchBranches, pullBranch, pushBranch, syncBranch } from '../../analysis/branch-actions.ts';
import { commitWorkingTree } from '../../analysis/commit.ts';
import { computeCycles } from '../../analysis/cycles.ts';
import { analyzeModuleDepth } from '../../analysis/depth.ts';
import { computeFileHealth } from '../../analysis/file-health.ts';
import { buildFunctions, type FunctionsReport } from '../../analysis/functions.ts';
import { rankHotspots } from '../../analysis/hotspots.ts';
import {
  computeMeasuredCoverage,
  coverageProvenance,
  type MeasuredCoverageSummary,
} from '../../analysis/measured-coverage.ts';
import { buildSystemReport } from '../../analysis/system.ts';
import { computeReadingRoute } from '../../analysis/route.ts';
import { buildTierReport } from '../../analysis/tiers.ts';
import { computeArchitectureHealth } from '../../analysis/health.ts';
import { computeImpact } from '../../analysis/impact.ts';
import { computeFileImpactPassport, rollUpImpactPassports } from '../../analysis/impact-passport.ts';
import { collectRelatedSources } from '../../analysis/related-sources.ts';
import { getTimeline } from '../../analysis/timeline.ts';
import { reviewCommit, reviewWorkingTree } from '../../analysis/review.ts';
import { computeOwnership, getFileAuthorHistory } from '../../analysis/ownership.ts';
import { computeQualityScorecard, smellsFromScorecard } from '../../analysis/quality.ts';
import { buildCoChangeEdges } from '../../analysis/co-change.ts';
import { collectHistory } from '../../analysis/history.ts';
import { computeRepositoryPassport } from '../../analysis/passport.ts';
import { computeStructuralDiff } from '../../analysis/structural-diff.ts';
import { assertReadable, resolveRepositoryRoot } from '../../boundary/repository-root.ts';
import { getCachedGraph, type CachedGraph } from '../../cache/graph-cache.ts';
import { computeFreshness, revisionFromFingerprint } from '../../status.ts';
import type { GraphProvenance } from '../../analysis/review-types.ts';
import { symbolExtractorFor } from '../../scan/languages/registry.ts';
import type { CodeSymbol, MemberAccess } from '../../scan/languages/symbols.ts';
import type { Graph, StraboConfig } from '../../types.ts';
import { parseBoolean, parsePositiveInt, isSameOriginRequest, sendError } from '../http.ts';

/**
 * The graph fingerprint and scan time behind a served passport, plus a staleness comparison
 * against the working tree now. Reuses `computeFreshness`, so a passport reads the same
 * revision, behind count, and stale flag the global freshness badge shows.
 */
export async function graphProvenance(
  root: string,
  cached: Pick<CachedGraph, 'fingerprint' | 'report'>,
): Promise<GraphProvenance> {
  const freshness = await computeFreshness(root, cached.fingerprint, cached.report.scannedAt);
  return {
    fingerprint: cached.fingerprint,
    revision: revisionFromFingerprint(cached.fingerprint),
    scannedAt: cached.report.scannedAt,
    currentFingerprint: freshness.current.fingerprint,
    behind: freshness.behind,
    stale: freshness.stale,
  };
}

/** Review-focused analyses. All of them inherit the scanner's scope. */
export function createAnalysisRouter(config: StraboConfig): Router {
  const router = Router();

  const resolve = (request: { query: Record<string, unknown> }) =>
    resolveRepositoryRoot({
      workspaceRoot: config.workspaceRoot,
      scanCeiling: config.scanCeiling ?? config.workspaceRoot,
      requested: typeof request.query.repository === 'string' ? request.query.repository : undefined,
    });

  /**
   * Read the repository's existing coverage report, bounded by the scan ceiling. `files`
   * limits the staleness `git log` to the files a caller needs (e.g. one file for `/symbols`).
   */
  const measuredCoverage = (repository: { root: string }, graph: Graph, files?: readonly string[]) =>
    computeMeasuredCoverage(repository.root, graph, {
      reportPaths: config.coverageReports,
      ceiling: config.scanCeiling ?? config.workspaceRoot,
      ...(files ? { files } : {}),
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

  /**
   * Measured coverage from an existing report, with the static test-reach as the fallback.
   *
   * The report is read, never produced. A path the report names that is not a graph node is
   * listed in `measured.outOfGraph`; an absent or malformed report is `available: false`
   * with a reason, not zeros. `reachable` is always the graph-reach answer so a caller can
   * label a figure `measured` or `reachable`.
   */
  router.get('/analysis/coverage', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const measured = await measuredCoverage(repository, cached.report.graph);
      response.json({
        repository: repository.name,
        measured,
        reachable: { basis: 'reachable', ...computeCoverage(cached.report.graph) },
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * The structural diff between HEAD and `base`: dependency edges, cycles, wrong-way tier
   * edges, entry points, and test reach that appeared or disappeared. The base graph is
   * scanned from a temporary worktree; an unreadable base is returned `unavailable`.
   */
  router.get('/analysis/structural-diff', async (request, response) => {
    try {
      const repository = resolve(request);
      const base = typeof request.query.base === 'string' ? request.query.base : '';
      if (!base) {
        response.status(400).json({ error: 'base query parameter is required.' });
        return;
      }
      const cached = await getCachedGraph(repository.root);
      response.json(
        await computeStructuralDiff(repository.root, base, {
          headGraph: cached.report.graph,
          headRevision: revisionFromFingerprint(cached.fingerprint),
          repository: repository.name,
        }),
      );
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
   * cycles, and what no test reaches. The opening summary for an unfamiliar repository.
   */
  router.get('/analysis/passport', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const limit = parsePositiveInt(request.query.limit, 10) ?? 10;
      response.json({
        ...computeRepositoryPassport(
          repository.name,
          cached.report.graph,
          cached.report.extensionCounts,
          limit,
        ),
        provenance: await graphProvenance(repository.root, cached),
      });
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
      response.json(buildTierReport(repository.root, repository.name, cached.report.graph));
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
      const measured = await measuredCoverage(repository, cached.report.graph, [file]);
      response.json(
        computeFileHealth(cached.report.graph, file, symbols, accesses, cohesionUnavailable, measured),
      );
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

      // The measured report is read once for the files being examined, and the staleness
      // read is bounded to those files; a function the report does not name stays unavailable.
      const measured = await measuredCoverage(repository, cached.report.graph, selected);
      const coverageByFile = new Map(
        measured.files.filter((entry) => entry.inGraph).map((entry) => [entry.file, entry]),
      );

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
          const entry = coverageByFile.get(file);
          reports.push(buildFunctions(file, result.symbols, result.calls ?? [], entry?.functions ?? []));
        } catch {
          skipped += 1;
        }
      }

      response.json({
        ...rankHotspots(reports, {
          limit,
          filesScanned: selected.length,
          filesSkipped: skipped,
        }),
        coverage: coverageProvenance(measured),
      });
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
   * Branches with their upstream sync and their divergence from a base branch. `base`
   * names the branch to compare with; by default the remote's default branch.
   */
  router.get('/analysis/branches', async (request, response) => {
    try {
      const repository = resolve(request);
      const base = typeof request.query.base === 'string' && request.query.base ? request.query.base : undefined;
      response.json(await listBranches(repository.root, base));
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Git actions that write: fetch, pull (fetch + fast-forward), push, and sync. They are
   * state-changing, so they are accepted only from the Strabo page's own origin (see
   * `isSameOriginRequest`), and the analysis module validates every ref before it reaches Git
   * and never force-pushes.
   */
  router.post('/analysis/branches/fetch', async (request, response) => {
    try {
      if (!isSameOriginRequest(request)) {
        response.status(403).json({ error: 'branch actions are accepted only from the Strabo page.' });
        return;
      }
      const repository = resolve(request);
      const remote = typeof request.body?.remote === 'string' && request.body.remote ? request.body.remote : undefined;
      response.json(await fetchBranches(repository.root, remote));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/analysis/branches/push', async (request, response) => {
    try {
      if (!isSameOriginRequest(request)) {
        response.status(403).json({ error: 'branch actions are accepted only from the Strabo page.' });
        return;
      }
      const repository = resolve(request);
      const branch = typeof request.body?.branch === 'string' ? request.body.branch : '';
      if (!branch) {
        response.status(400).json({ error: 'branch is required.' });
        return;
      }
      response.json(await pushBranch(repository.root, branch));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/analysis/branches/pull', async (request, response) => {
    try {
      if (!isSameOriginRequest(request)) {
        response.status(403).json({ error: 'branch actions are accepted only from the Strabo page.' });
        return;
      }
      const repository = resolve(request);
      const branch = typeof request.body?.branch === 'string' ? request.body.branch : '';
      if (!branch) {
        response.status(400).json({ error: 'branch is required.' });
        return;
      }
      response.json(await pullBranch(repository.root, branch));
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/analysis/branches/sync', async (request, response) => {
    try {
      if (!isSameOriginRequest(request)) {
        response.status(403).json({ error: 'branch actions are accepted only from the Strabo page.' });
        return;
      }
      const repository = resolve(request);
      const branch = typeof request.body?.branch === 'string' ? request.body.branch : '';
      if (!branch) {
        response.status(400).json({ error: 'branch is required.' });
        return;
      }
      response.json(await syncBranch(repository.root, branch));
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Commit the working tree and push the current branch, from a message the operator
   * confirmed in the browser.
   *
   * State-changing, so it is accepted only from the Strabo page's own origin. The message
   * reaches Git as a `-m` argument, never a shell, and the push is a normal push — never
   * forced — so a diverged branch is reported after the commit is made rather than
   * overwritten. The message is generated by `POST /narrator/commit-message`, but this route
   * takes whatever the operator submitted and does not contact the narrator itself.
   */
  router.post('/analysis/commit', async (request, response) => {
    try {
      if (!isSameOriginRequest(request)) {
        response.status(403).json({ error: 'commits are accepted only from the Strabo page.' });
        return;
      }
      const repository = resolve(request);
      const message = typeof request.body?.message === 'string' ? request.body.message : '';
      const push = request.body?.push !== false;
      response.json(await commitWorkingTree(repository.root, message, { push }));
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Review a commit's own changes, a branch against a base, or the working tree.
   *
   * `base` reviews that revision against its first parent; `branch` reviews that branch's
   * work since it left `against` (default: the remote's default branch); neither reviews
   * the working tree, split into staged, unstaged, and untracked. Every shape carries the
   * same reverse-dependency impact the change-impact overlay computes.
   */
  router.get('/analysis/review', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      // The base-vs-head edge diff, from the two scanned graphs. Reused by the passport so
      // its per-file edge deltas and the panel's structural diff read the same base graph.
      const structuralEdges = async (baseRevision: string) => {
        const structural = await computeStructuralDiff(repository.root, baseRevision, {
          headGraph: cached.report.graph,
          headRevision: revisionFromFingerprint(cached.fingerprint),
          repository: repository.name,
        });
        return structural.available ? structural.diff : undefined;
      };
      const branch = typeof request.query.branch === 'string' ? request.query.branch : '';
      if (branch) {
        const against = typeof request.query.against === 'string' && request.query.against ? request.query.against : undefined;
        const review = await reviewBranch(repository.root, cached.report.graph, branch, against);
        if (!review.available || !review.branch) {
          response.json(review);
          return;
        }
        // The passport reads the after side from the working tree, so it is only honest
        // when the branch is what is checked out.
        const edges = review.branch.checkedOut ? await structuralEdges(review.branch.mergeBase) : undefined;
        const cohesion = review.branch.checkedOut
          ? await computeChangePassport(repository.root, review.files, review.branch.mergeBase, cached.report.graph, edges)
          : undefined;
        const metrics = await computeRangeMetrics(repository.root, review.branch.mergeBase, review.branch.tipHash);
        const provenance = await graphProvenance(repository.root, cached);
        response.json({
          ...review,
          ...(cohesion ? { cohesion } : {}),
          metrics,
          provenance,
          ...(cohesion
            ? {
                impactPassport: {
                  ...rollUpImpactPassports(
                    cached.report.graph,
                    cohesion.files.map((change) => change.impactPassport),
                    'revision',
                    cohesion.baseline,
                    cohesion.capped,
                  ),
                  provenance,
                },
              }
            : {}),
        });
        return;
      }
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
      const edges = await structuralEdges(baseline);
      const cohesion = await computeChangePassport(repository.root, review.files, baseline, cached.report.graph, edges);
      const metrics = base
        ? await computeCommitMetrics(repository.root, base)
        : await computeWorkingTreeMetrics(repository.root, review.files);
      const provenance = await graphProvenance(repository.root, cached);
      const impactPassport = {
        ...rollUpImpactPassports(
          cached.report.graph,
          cohesion.files.map((change) => change.impactPassport),
          'change-set',
          cohesion.baseline,
          cohesion.capped,
        ),
        provenance,
      };
      response.json({ ...review, cohesion, metrics, impactPassport, provenance });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * The Change impact passport for one file: its current-graph snapshot (blast radius,
   * importers, imports), complexity, signals, and most complex functions, with the deltas
   * against HEAD when the file has pending changes. The Module Passport reads this.
   */
  router.get('/analysis/impact-passport', async (request, response) => {
    try {
      const repository = resolve(request);
      const file = typeof request.query.file === 'string' ? request.query.file : '';
      if (!file) {
        response.status(400).json({ error: 'file query parameter is required.' });
        return;
      }
      const cached = await getCachedGraph(repository.root);
      response.json({
        ...(await computeFileImpactPassport(repository.root, cached.report.graph, file)),
        provenance: await graphProvenance(repository.root, cached),
      });
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

  return router;
}

/** A 0-1 ratio query parameter, or undefined so the builder's default stands. */
function parseRatio(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}
