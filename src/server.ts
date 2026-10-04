import express, { type Express } from 'express';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStraboRouter } from './api/router.ts';
import { isAllowedHost } from './api/http.ts';
import type { StraboConfig } from './types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Locate package-owned `public/` assets from either `src/` or `dist/`. */
function publicDirectory(): string {
  const candidates = [path.join(here, '..', 'public'), path.join(here, '..', '..', 'public')];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? path.join(here, '..', 'public');
}

/**
 * Cytoscape's `dist/` directory, found the way Node finds the package. A fixed
 * `../node_modules/cytoscape` breaks whenever npm hoists it — the usual case when a host
 * embeds `strabo-map/server` — and the map then loads without its renderer.
 */
function cytoscapeDirectory(): string {
  try {
    return path.dirname(createRequire(import.meta.url).resolve('cytoscape/dist/cytoscape.min.js'));
  } catch {
    return path.join(here, '..', 'node_modules', 'cytoscape', 'dist');
  }
}

/**
 * A self-contained Express application that serves `public/` and mounts the router at
 * `/api/strabo`. The same API behaviour is used by standalone and embedded hosts.
 */
export function createStraboServer(config: StraboConfig): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // DNS-rebinding guard: a malicious page can make a browser send requests to an
  // attacker domain that resolves to 127.0.0.1. Those arrive with the attacker's Host,
  // so they are refused here — ahead of the static assets and every API route — rather
  // than letting the page load the app shell or read data.
  app.use((request, response, next) => {
    if (!isAllowedHost(request, config.host)) {
      response.status(403).json({ error: 'requests must address the server by its own host.' });
      return;
    }
    next();
  });

  const assets = publicDirectory();
  app.use('/', express.static(assets));
  app.use('/vendor/cytoscape', express.static(cytoscapeDirectory()));

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
