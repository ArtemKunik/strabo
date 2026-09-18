import express, { type Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStraboRouter } from './api/router.ts';
import type { StraboConfig } from './types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Locate package-owned `public/` assets from either `src/` or `dist/`. */
function publicDirectory(): string {
  const candidates = [path.join(here, '..', 'public'), path.join(here, '..', '..', 'public')];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? path.join(here, '..', 'public');
}

/**
 * A self-contained Express application that serves `public/` and mounts the router at
 * `/api/strabo`. The same API behaviour is used by standalone and embedded hosts.
 */
export function createStraboServer(config: StraboConfig): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  const assets = publicDirectory();
  app.use('/', express.static(assets));
  app.use('/vendor/cytoscape', express.static(path.join(here, '..', 'node_modules', 'cytoscape', 'dist')));

  app.use('/api/strabo', createStraboRouter(config));

  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      config.serverLog?.('unhandled request error', error);
      if (!response.headersSent) {
        response.status(500).json({ error: 'Internal Strabo error' });
      }
    },
  );

  return app;
}
