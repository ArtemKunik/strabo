import { Router } from 'express';

import { resolveRepositoryRoot } from '../../boundary/repository-root.ts';
import { CACHE_ARTIFACT_VERSION, getCachedGraph } from '../../cache/graph-cache.ts';
import { exportGraph, type GraphExportFormat } from '../../export/graph-export.ts';
import { selectViewModel } from '../../export/select-view.ts';
import { renderViewModelSvg } from '../../export/svg.ts';
import { describeRepository } from '../../repository.ts';
import { computeFreshness } from '../../status.ts';
import type { StraboConfig } from '../../types.ts';
import { parseBoolean, parsePositiveInt, sendError } from '../http.ts';

const CONTENT_TYPES: Record<string, string> = {
  json: 'application/json; charset=utf-8',
  dot: 'text/vnd.graphviz; charset=utf-8',
  mermaid: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8',
};

export function createInteropRouter(config: StraboConfig): Router {
  const router = Router();

  const resolve = (request: { query: Record<string, unknown> }) =>
    resolveRepositoryRoot({
      workspaceRoot: config.workspaceRoot,
      scanCeiling: config.scanCeiling ?? config.workspaceRoot,
      configPath: config.configPath,
      requested: asString(request.query.repository) ?? asString(request.query.path),
    });

  router.get('/export', async (request, response) => {
    try {
      const repository = resolve(request);
      const format = (asString(request.query.format) ?? 'json').toLowerCase();
      if (!(format in CONTENT_TYPES)) {
        response.status(400).json({ error: `Unsupported export format "${format}".` });
        return;
      }
      const cached = await getCachedGraph(repository.root);
      const descriptor = await describeRepository(repository.root);

      if (format === 'svg') {
        const model = selectViewModel({
          root: repository.root,
          descriptor,
          cached,
          view: asString(request.query.view),
          blockDepth: parsePositiveInt(request.query.blockDepth, 5),
          blockPrefix: asString(request.query.blockPrefix),
        });
        response.type(CONTENT_TYPES.svg as string).send(
          renderViewModelSvg(model, { title: descriptor.name }),
        );
        return;
      }

      const body = exportGraph(cached.report.graph, {
        format: format as GraphExportFormat,
        fingerprint: cached.fingerprint,
        revision: cached.fingerprint?.split(':')[0] ?? null,
        generatedAt: cached.report.scannedAt,
        includeDeclare: parseBoolean(request.query.includeDeclare),
      });
      response.type(CONTENT_TYPES[format] as string).send(body);
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/status', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const freshness = await computeFreshness(
        repository.root,
        cached.fingerprint,
        cached.report.scannedAt,
      );
      response.json({
        repository: {
          name: repository.name,
          root: repository.root,
          workspaceRoot: repository.workspaceRoot,
        },
        cache: {
          status: cached.status,
          artifactVersion: CACHE_ARTIFACT_VERSION,
          generatedAt: cached.report.scannedAt,
          stale: cached.stale ?? false,
        },
        ...freshness,
      });
      if (freshness.stale && config.autoRebuild !== false) {
        void getCachedGraph(repository.root, { refresh: true }).catch(() => undefined);
      }
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
