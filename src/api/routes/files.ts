import { Router } from 'express';

import { diffFile } from '../../analysis/diff.ts';
import { contentAtRevision, readWorkingFile } from '../../analysis/git-content.ts';
import { isSafeRevision } from '../../analysis/impact.ts';
import { assertReadable, resolveRepositoryRoot } from '../../boundary/repository-root.ts';
import type { StraboConfig } from '../../types.ts';
import { parseBoolean, sendError } from '../http.ts';

/**
 * Reading one file for the in-page viewer: its text, and its change against a revision.
 *
 * `ref` reads a past version; otherwise the working tree is read. The diff endpoint mirrors
 * the review's own routes (`ref`, `base`/`head`, `staged`, `untracked`) so the viewer and the
 * review panel name the same two sides rather than guessing at them.
 */
export function createFilesRouter(config: StraboConfig): Router {
  const router = Router();

  const resolve = (request: { query: Record<string, unknown> }) =>
    resolveRepositoryRoot({
      workspaceRoot: config.workspaceRoot,
      scanCeiling: config.scanCeiling ?? config.workspaceRoot,
      requested: typeof request.query.repository === 'string' ? request.query.repository : undefined,
    });

  router.get('/source', async (request, response) => {
    try {
      const repository = resolve(request);
      const file = asString(request.query.file);
      if (!file) {
        response.status(400).json({ error: 'file query parameter is required.' });
        return;
      }
      const ref = asString(request.query.ref);
      if (ref) {
        const content = isSafeRevision(ref) ? await contentAtRevision(repository.root, ref, file) : null;
        if (content === null) {
          response.status(404).json({ error: `"${file}" is not readable as text at "${ref}".` });
          return;
        }
        response.json({ file, ref, content });
        return;
      }
      assertReadable(repository.root, file);
      const content = readWorkingFile(repository.root, file);
      if (content === null) {
        response.status(415).json({ error: `"${file}" is not readable as text.` });
        return;
      }
      response.json({ file, content });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/diff', async (request, response) => {
    try {
      const repository = resolve(request);
      const file = asString(request.query.file);
      if (!file) {
        response.status(400).json({ error: 'file query parameter is required.' });
        return;
      }
      // Containment only: a deleted file has no working copy left to read.
      assertReadable(repository.root, file);
      response.json(
        await diffFile(repository.root, {
          file,
          ref: asString(request.query.ref),
          base: asString(request.query.base),
          head: asString(request.query.head),
          staged: parseBoolean(request.query.staged),
          untracked: parseBoolean(request.query.untracked),
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
