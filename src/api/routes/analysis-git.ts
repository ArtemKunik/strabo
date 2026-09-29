import { Router } from 'express';

import { dropBranches, mergeRequest, pushBranch } from '../../analysis/branch-actions.ts';
import { listBranches } from '../../analysis/branches.ts';
import { isSameOriginRequest, sendError } from '../http.ts';
import type { AnalysisContext } from './analysis-context.ts';

/**
 * Branch listing, branch review support, and the explicit Git write actions.
 *
 * Listing stays read-only. The write actions (push, drop stale, and the merge-request URL)
 * are accepted only from the Strabo page's own origin, and the analysis module validates
 * every ref before it reaches Git and never force-pushes.
 */
export function createGitRouter(context: AnalysisContext): Router {
  const router = Router();
  const { resolve } = context;

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
   * The forge URL that opens a new merge request for a branch into the base. Read-only:
   * it builds the URL from the remote alone, and the browser opens it. No token is stored
   * and no request reaches the forge from the server.
   */
  router.get('/analysis/branches/merge-request', async (request, response) => {
    try {
      const repository = resolve(request);
      const branch = typeof request.query.branch === 'string' ? request.query.branch : '';
      if (!branch) {
        response.status(400).json({ error: 'branch query parameter is required.' });
        return;
      }
      const base = typeof request.query.base === 'string' && request.query.base ? request.query.base : undefined;
      response.json(await mergeRequest(repository.root, branch, base));
    } catch (error) {
      sendError(response, error);
    }
  });

  /** Push one local branch to its upstream, publishing it when none is set. Never forced. */
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

  /**
   * Drop the named local branches that the listing already calls stale (upstream gone, or
   * fully merged into the base). The checked-out and base branches are always skipped.
   */
  router.post('/analysis/branches/drop', async (request, response) => {
    try {
      if (!isSameOriginRequest(request)) {
        response.status(403).json({ error: 'branch actions are accepted only from the Strabo page.' });
        return;
      }
      const repository = resolve(request);
      const branches = Array.isArray(request.body?.branches)
        ? request.body.branches.filter((name: unknown): name is string => typeof name === 'string')
        : [];
      response.json(await dropBranches(repository.root, branches));
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
