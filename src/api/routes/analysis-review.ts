import { Router } from 'express';

import { buildAdjacency } from '../../analysis/analysis.ts';
import { reviewBranch } from '../../analysis/branches.ts';
import { computeChangePassport } from '../../analysis/change-passport.ts';
import {
  computeCommitMetrics,
  computeMetricsHistory,
  computeRangeMetrics,
  computeWorkingTreeMetrics,
} from '../../analysis/change-metrics.ts';
import { computeClones } from '../../analysis/clones.ts';
import { computeImpact } from '../../analysis/impact.ts';
import { computeFileImpactPassport, rollUpImpactPassports } from '../../analysis/impact-passport.ts';
import { computePublicApiDiff } from '../../analysis/public-api-diff.ts';
import { reviewCommit, reviewWorkingTree } from '../../analysis/review.ts';
import { computeScopeFence } from '../../analysis/scope-fence.ts';
import { computeStructuralDiff } from '../../analysis/structural-diff.ts';
import { getTimeline } from '../../analysis/timeline.ts';
import { listWorktrees, resolveWorktree, type WorktreeSummary } from '../../analysis/worktrees.ts';
import { getCachedGraph } from '../../cache/graph-cache.ts';
import { revisionFromFingerprint } from '../../status.ts';
import { parsePositiveInt, sendError } from '../http.ts';
import { expectValues, graphProvenance, type AnalysisContext } from './analysis-context.ts';

/** Change review, impact, and related change-set endpoints. */
export function createReviewRouter(context: AnalysisContext): Router {
  const router = Router();
  const { config, resolve, measuredCoverage } = context;

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
      const branch = typeof request.query.branch === 'string' ? request.query.branch : '';
      const base = typeof request.query.base === 'string' ? request.query.base : '';
      const requestedWorktree =
        typeof request.query.worktree === 'string' ? request.query.worktree.trim() : '';
      // A linked worktree is only meaningful for the working-tree review: a commit names its
      // own revision and a branch is read from the repository at `root`.
      let worktree: WorktreeSummary | null = null;
      if (!branch && !base && requestedWorktree) {
        worktree = await resolveWorktree(
          repository.root,
          requestedWorktree,
          config.scanCeiling ?? config.workspaceRoot,
        );
        if (!worktree) {
          response.status(400).json({
            error: `"${requestedWorktree}" is not a worktree of this repository.`,
          });
          return;
        }
      }
      // The graph the working-tree review reads: the selected root, or the linked worktree
      // when one is named. Paths stay repository-relative, so a sibling worktree's files map
      // onto the same node ids as the selected root's graph.
      const workingRoot = worktree ? worktree.path : repository.root;
      const cached = await getCachedGraph(workingRoot);
      // The base-vs-head edge diff, from the two scanned graphs. Reused by the passport so
      // its per-file edge deltas and the panel's structural diff read the same base graph.
      const structuralEdges = async (baseRevision: string) => {
        const structural = await computeStructuralDiff(workingRoot, baseRevision, {
          headGraph: cached.report.graph,
          headRevision: revisionFromFingerprint(cached.fingerprint),
          repository: repository.name,
        });
        return structural.available ? structural.diff : undefined;
      };
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
        const measured = review.branch.checkedOut
          ? await measuredCoverage(repository, cached.report.graph, review.files.map((file) => file.path))
          : null;
        const cohesion = review.branch.checkedOut
          ? await computeChangePassport(repository.root, review.files, review.branch.mergeBase, cached.report.graph, edges, measured)
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
      const review = base
        ? await reviewCommit(repository.root, cached.report.graph, base)
        : await reviewWorkingTree(workingRoot, cached.report.graph);
      if (!review.available) {
        response.json(review);
        return;
      }
      // The baseline matches the review's own comparison: HEAD for the working tree, and
      // the first parent for a commit (which `^` names for a merge and fails on the root).
      const baseline = base ? `${base}^` : 'HEAD';
      const edges = await structuralEdges(baseline);
      const measured = await measuredCoverage(repository, cached.report.graph, review.files.map((file) => file.path));
      const cohesion = await computeChangePassport(workingRoot, review.files, baseline, cached.report.graph, edges, measured);
      const metrics = base
        ? await computeCommitMetrics(repository.root, base)
        : await computeWorkingTreeMetrics(workingRoot, review.files);
      const provenance = await graphProvenance(workingRoot, cached);
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
      const expected = expectValues(request.query.expect);
      const scopeFence =
        expected.length > 0
          ? computeScopeFence({
              changed: review.files.map((file) => ({
                path: file.path,
                ...(file.previousPath ? { previousPath: file.previousPath } : {}),
              })),
              expected,
              importers: buildAdjacency(cached.report.graph).backward,
            })
          : undefined;
      response.json({
        ...review,
        ...(worktree ? { worktree: { path: worktree.path, branch: worktree.branch } } : {}),
        cohesion,
        metrics,
        impactPassport,
        provenance,
        ...(scopeFence ? { scopeFence } : {}),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * The repository's working trees: the checked-out root and every linked `git worktree add`
   * checkout, which is where a coding agent may be editing rather than the selected root.
   * The Review screen uses this to choose which tree to diff.
   */
  router.get('/analysis/worktrees', async (request, response) => {
    try {
      const repository = resolve(request);
      response.json({
        repository: repository.name,
        root: repository.root,
        ...(await listWorktrees(repository.root)),
      });
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
      const measured = await measuredCoverage(repository, cached.report.graph, [file]);
      response.json({
        ...(await computeFileImpactPassport(repository.root, cached.report.graph, file, measured)),
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
   * Scope fence (Phase 29 E1): the changed paths outside a declared zone, plus the changed
   * paths inside it whose importers lie outside. A filter over the review, not new analysis.
   */
  router.get('/analysis/scope-fence', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const expected = expectValues(request.query.expect);
      const base = typeof request.query.base === 'string' ? request.query.base : '';
      const review = base
        ? await reviewCommit(repository.root, cached.report.graph, base)
        : await reviewWorkingTree(repository.root, cached.report.graph);
      if (!review.available) {
        response.json(review);
        return;
      }
      const { backward } = buildAdjacency(cached.report.graph);
      response.json(
        computeScopeFence({
          changed: review.files.map((file) => ({
            path: file.path,
            ...(file.previousPath ? { previousPath: file.previousPath } : {}),
          })),
          expected,
          importers: backward,
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Public API diff (Phase 29 E2): exported and pub symbols added, removed, or re-signed
   * between two revisions, per extractor language, with the recorded consumers of each.
   */
  router.get('/analysis/public-api-diff', async (request, response) => {
    try {
      const repository = resolve(request);
      const base = typeof request.query.base === 'string' ? request.query.base : '';
      if (!base) {
        response.status(400).json({ error: 'base query parameter is required.' });
        return;
      }
      const cached = await getCachedGraph(repository.root);
      const head = typeof request.query.head === 'string' && request.query.head ? request.query.head : null;
      response.json(await computePublicApiDiff(repository.root, base, { head, graph: cached.report.graph }));
    } catch (error) {
      sendError(response, error);
    }
  });

  /** Function clones (Phase 29 E3): equal normalised function bodies grouped into clusters. */
  router.get('/analysis/clones', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      response.json(
        await computeClones(repository.root, cached.report.graph, {
          minTokens: parsePositiveInt(request.query.minTokens, 500),
          maxFiles: parsePositiveInt(request.query.maxFiles, 4000),
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
