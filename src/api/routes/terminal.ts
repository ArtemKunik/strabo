import { Router } from 'express';

import { StraboScopeError, resolveRepositoryRoot } from '../../boundary/repository-root.ts';
import type { StraboConfig } from '../../types.ts';
import { isSameOriginRequest, parsePositiveInt, sendError } from '../http.ts';
import { findCitations } from '../../terminal/citations.ts';
import { listPresets } from '../../terminal/presets.ts';
import type { CreateSessionOptions, SessionKind, SessionOrigin } from '../../terminal/protocol.ts';
import { TERMINAL_LIMITS } from '../../terminal/protocol.ts';
import { getSessionManager } from '../../terminal/registry.ts';

const SESSION_KINDS: readonly SessionKind[] = ['shell', 'agent', 'task', 'watch'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Parse a JSON session body into {@link CreateSessionOptions}, or null when it is malformed.
 *
 * Deliberately a closed shape: only the fields a route accepts are copied, each is type-
 * checked, and an unexpected `argv` or `origin` is a 400 rather than a silently dropped
 * value. The manager re-validates, but a clear error belongs at the edge.
 */
function parseCreateOptions(raw: unknown): CreateSessionOptions | null {
  if (raw === null || raw === undefined) {
    return {};
  }
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const options: CreateSessionOptions = {};

  if ('kind' in record) {
    if (typeof record.kind !== 'string' || !SESSION_KINDS.includes(record.kind as SessionKind)) {
      return null;
    }
    options.kind = record.kind as SessionKind;
  }
  for (const key of ['repo', 'cwd', 'title', 'preset'] as const) {
    if (key in record) {
      if (typeof record[key] !== 'string') {
        return null;
      }
      options[key] = record[key] as string;
    }
  }
  if ('argv' in record) {
    if (!Array.isArray(record.argv) || !record.argv.every((entry) => typeof entry === 'string')) {
      return null;
    }
    options.argv = record.argv as string[];
  }
  if ('origin' in record) {
    const origin = asRecord(record.origin);
    if (!origin) {
      return null;
    }
    const parsed: SessionOrigin = {};
    for (const key of ['node', 'commit', 'review'] as const) {
      if (key in origin) {
        if (typeof origin[key] !== 'string') {
          return null;
        }
        parsed[key] = origin[key] as string;
      }
    }
    options.origin = parsed;
  }
  if ('env' in record) {
    const env = asRecord(record.env);
    if (!env || !Object.values(env).every((value) => typeof value === 'string')) {
      return null;
    }
    options.env = env as Record<string, string>;
  }
  return options;
}

function resolveQueryRepository(config: StraboConfig, requested: unknown) {
  return resolveRepositoryRoot({
    workspaceRoot: config.workspaceRoot,
    scanCeiling: config.scanCeiling ?? config.workspaceRoot,
    requested: typeof requested === 'string' && requested.trim() !== '' ? requested : undefined,
  });
}

/**
 * REST surface over the terminal session registry, plus repository-derived presets.
 *
 * Reads are open; creating, killing, and renaming sessions are state-changing and accepted
 * only from the page's own origin. Failed creates are mapped by error type so a bad request
 * is a 400 and a full registry is a 409 instead of a blanket 500.
 */
export function createTerminalRouter(config: StraboConfig): Router {
  const router = Router();

  router.get('/terminal/sessions', (_request, response) => {
    try {
      response.json({ sessions: getSessionManager(config).list() });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/terminal/sessions', async (request, response) => {
    try {
      if (!isSameOriginRequest(request)) {
        response.status(403).json({ error: 'terminal sessions are created only from the Strabo page.' });
        return;
      }
      const options = parseCreateOptions(request.body);
      if (!options) {
        response.status(400).json({ error: 'invalid session options.' });
        return;
      }
      const manager = getSessionManager(config);
      if (manager.list().length >= TERMINAL_LIMITS.maxSessions) {
        response.status(409).json({ error: `session limit of ${TERMINAL_LIMITS.maxSessions} reached.` });
        return;
      }
      const session = await manager.create(options);
      response.status(201).json({ session: session.meta });
    } catch (error) {
      if (error instanceof StraboScopeError) {
        response.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof TypeError || error instanceof RangeError) {
        response.status(400).json({ error: error.message });
        return;
      }
      sendError(response, error);
    }
  });

  router.get('/terminal/sessions/:id/backlog', (request, response) => {
    try {
      const session = getSessionManager(config).get(request.params.id);
      if (!session) {
        response.status(404).json({ error: 'unknown session.' });
        return;
      }
      const fromSeq = parsePositiveInt(request.query.fromSeq) ?? 0;
      const slice = session.backlog(fromSeq);
      response.json({ id: session.meta.id, fromSeq: slice.fromSeq, seq: slice.seq, data: slice.data });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/terminal/sessions/:id/citations', (request, response) => {
    try {
      const session = getSessionManager(config).get(request.params.id);
      if (!session) {
        response.status(404).json({ error: 'unknown session.' });
        return;
      }
      const fromSeq = parsePositiveInt(request.query.fromSeq) ?? 0;
      const slice = session.backlog(fromSeq);
      response.json({ citations: findCitations(slice.data, { root: session.meta.repo }) });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/terminal/sessions/:id/rename', (request, response) => {
    try {
      if (!isSameOriginRequest(request)) {
        response.status(403).json({ error: 'terminal sessions are renamed only from the Strabo page.' });
        return;
      }
      const title = request.body?.title;
      if (typeof title !== 'string' || title.trim() === '') {
        response.status(400).json({ error: 'title is required.' });
        return;
      }
      if (title.length > TERMINAL_LIMITS.maxTitleChars) {
        response.status(400).json({ error: `title exceeds ${TERMINAL_LIMITS.maxTitleChars} characters.` });
        return;
      }
      const manager = getSessionManager(config);
      if (!manager.rename(request.params.id, title)) {
        response.status(404).json({ error: 'unknown session.' });
        return;
      }
      const session = manager.get(request.params.id);
      if (!session) {
        response.status(404).json({ error: 'unknown session.' });
        return;
      }
      response.json({ session: session.meta });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.delete('/terminal/sessions/:id', (request, response) => {
    try {
      if (!isSameOriginRequest(request)) {
        response.status(403).json({ error: 'terminal sessions are killed only from the Strabo page.' });
        return;
      }
      if (!getSessionManager(config).kill(request.params.id)) {
        response.status(404).json({ error: 'unknown session.' });
        return;
      }
      response.json({ ok: true });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/terminal/presets', (request, response) => {
    try {
      const repository = resolveQueryRepository(config, request.query.repo);
      response.json({ presets: listPresets(repository.root) });
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
