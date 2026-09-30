import { Router } from 'express';

import { dropBranches, fetchBranches, mergeRequest, pullBranch, pushBranch, syncBranch } from '../../analysis/branch-actions.ts';
import { listBranches } from '../../analysis/branches.ts';
import { commitWorkingTree } from '../../analysis/commit.ts';
import { isSameOriginRequest, sendError } from '../http.ts';
import type { AnalysisContext } from './analysis-context.ts';

/**
 * Branch listing, branch review support, and the explicit Git write actions.
 *
 * Listing stays read-only. The write actions (fetch, pull, sync, push, drop stale, commit,
 * and the merge-request URL) are accepted only from the Strabo page's own origin, and the
 * analysis module validates every ref before it reaches Git, never force-pushes, and never
 * rebases: a diverged branch is reported rather than overwritten.
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

  /**
   * Fetch the remotes the branches track, else the default one. This is what makes the
   * panel's ahead/behind counts fresh; it updates remote-tracking refs only.
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
   * Pull one local branch: fetch its upstream and fast-forward it. The checked-out branch is
   * advanced so the working tree follows; a diverged branch is reported, never merged.
   */
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

  /** Sync the checked-out branch: fetch, fast-forward when behind, then push when ahead. */
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

  return router;
}
