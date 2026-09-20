import { Router } from 'express';

import { createNarratorClient, type NarratorClient } from '../../narrator/client.ts';
import type { StraboConfig } from '../../types.ts';
import { sendError } from '../http.ts';

/**
 * The opt-in narrator surface.
 *
 * `GET /narrator` reports whether the narrator is configured and how much of its budget is
 * left, without ever exposing the endpoint path or the key. `POST /narrator` sends recorded
 * evidence and returns narrative text labelled as such. The client is created once, inert
 * unless the operator configured an endpoint, a model, and the key environment variable.
 */
export function createNarratorRouter(config: StraboConfig, client?: NarratorClient): Router {
  const router = Router();
  const narrator =
    client ??
    createNarratorClient({
      config: config.narrator,
      root: config.workspaceRoot,
      serverLog: config.serverLog,
    });

  router.get('/narrator', (_request, response) => {
    response.json(narrator.status());
  });

  router.get('/narrator/runs', (_request, response) => {
    response.json({ runs: narrator.runs() });
  });

  router.post('/narrator', async (request, response) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const evidence = typeof body.evidence === 'string' ? body.evidence : '';
      if (evidence.trim().length === 0) {
        response.status(400).json({ error: 'evidence is required' });
        return;
      }
      const instruction = typeof body.instruction === 'string' ? body.instruction : '';
      const source = typeof body.source === 'string' ? body.source : undefined;
      response.json(await narrator.narrate({ instruction, evidence, ...(source ? { source } : {}) }));
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
