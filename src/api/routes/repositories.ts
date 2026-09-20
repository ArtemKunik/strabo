import { Router } from 'express';

import { isInside, resolveRepositoryRoot } from '../../boundary/repository-root.ts';
import type { RepositoryStore } from '../../state/repository-store.ts';
import type { StraboConfig } from '../../types.ts';
import { sendError } from '../http.ts';

/**
 * The repository picker's data source.
 *
 * Known repositories are remembered outside the scanned tree so the picker survives a
 * restart and reopens whatever was last in use. Every path is still resolved through the
 * scan ceiling, so remembering a path can never widen what Strabo may read.
 */
export function createRepositoriesRouter(config: StraboConfig, store: RepositoryStore): Router {
  const router = Router();
  // Read the ceiling per request: `/settings` may change it while the server runs, so a
  // value captured at construction would keep filtering against the startup boundary.
  const ceiling = (): string => config.scanCeiling ?? config.workspaceRoot;

  /** Ensure the configured root is offered even before anything has been opened. */
  const seed = (): void => {
    if (store.list().length === 0) {
      store.remember(config.workspaceRoot);
      store.setActive(config.workspaceRoot);
    }
  };

  router.get('/repositories', (_request, response) => {
    try {
      seed();
      const limit = ceiling();
      const repositories = store
        .list()
        .filter((entry) => isInside(entry.root, limit));
      const active = store.active();
      response.json({
        active: active && isInside(active, limit) ? active : repositories[0]?.root ?? null,
        ceiling: limit,
        repositories,
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  /** Remember a repository and make it the active one. */
  router.post('/repositories', (request, response) => {
    try {
      const requested = typeof request.body?.root === 'string' ? request.body.root : '';
      if (!requested) {
        response.status(400).json({ error: 'root is required.' });
        return;
      }
      const repository = resolveRepositoryRoot({
        workspaceRoot: config.workspaceRoot,
        scanCeiling: ceiling(),
        requested,
      });
      const entry = store.remember(repository.root);
      store.setActive(repository.root);
      response.status(201).json(entry);
    } catch (error) {
      sendError(response, error);
    }
  });

  router.delete('/repositories', (request, response) => {
    try {
      const requested = typeof request.query.root === 'string' ? request.query.root : '';
      if (!requested) {
        response.status(400).json({ error: 'root query parameter is required.' });
        return;
      }
      response.json({ removed: store.forget(requested) });
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
