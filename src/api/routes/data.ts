import { Router } from 'express';

import { computeDataImpact, type DataImpactFinding } from '../../analysis/data/impact.ts';
import { buildDataOverlay } from '../../analysis/data/product-level.ts';
import { openWorkspaceCache, type WorkspaceCache } from '../../cache/workspace-cache.ts';
import { buildOpenLineage } from '../../export/openlineage.ts';
import type { DataReport, StraboConfig } from '../../types.ts';
import { analyzeWorkspace } from '../../workspace/analyze.ts';
import { readWorkspaceConfig, resolveWorkspaceRepositories } from '../../workspace/config.ts';
import { isSameOriginRequest, sendError } from '../http.ts';

export interface DataRouterOptions {
  /** Fact cache; defaults to the persisted one. */
  cache?: WorkspaceCache;
}

/** The recorded data layer as JSON, or an OpenLineage static export. */
export function createDataRouter(config: StraboConfig, options: DataRouterOptions = {}): Router {
  const router = Router();

  const analyze = async (): Promise<{ name: string; repositories: string[]; data: DataReport }> => {
    const { name, repositories } = resolveWorkspaceRepositories(config);
    const declared = readWorkspaceConfig(config.configPath);
    const workspace = await analyzeWorkspace(name, repositories, {
      cache: options.cache ?? openWorkspaceCache(),
      qualifiedContracts: declared?.contractsIdentity === 'qualified',
    });
    return { name, repositories: repositories.map((entry) => entry.name), data: workspace.data };
  };

  router.get('/analysis/data', async (_request, response) => {
    try {
      const { name, repositories, data } = await analyze();
      response.json({ name, repositories, data });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/analysis/data/model', async (_request, response) => {
    try {
      const { name, repositories, data } = await analyze();
      response.json({
        name,
        repositories,
        entities: data.model.entities,
        findings: data.model.findings,
        datasets: data.datasets,
        edges: data.edges.filter((edge) => edge.kind === 'reads' || edge.kind === 'writes'),
        lineage: data.lineage,
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/analysis/data/products', async (_request, response) => {
    try {
      const { name, repositories, data } = await analyze();
      response.json({
        name,
        repositories,
        products: data.products,
        candidates: data.candidates,
        contracts: data.contracts,
        shapeTwins: data.shapeTwins,
        conformance: data.conformance,
        classifications: data.classifications,
        catalogs: data.catalogs,
        events: data.events,
        eventContracts: data.eventContracts,
        dbt: data.dbt,
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/analysis/data/lineage', async (request, response) => {
    try {
      const { name, repositories, data } = await analyze();
      const dataset = typeof request.query.dataset === 'string' ? request.query.dataset.trim() : '';
      const wanted = dataset === '' ? null : dataset;
      const edges = wanted
        ? data.lineage.filter((edge) => edge.source === wanted || edge.target === wanted || edge.target.endsWith(`/${wanted}`) || edge.source.endsWith(`/${wanted}`))
        : data.lineage;
      const upstream = new Set(edges.map((edge) => edge.source));
      const downstream = new Set(edges.map((edge) => edge.target));
      const matches = (dataset: string): boolean =>
        !wanted ||
        dataset === wanted ||
        dataset.endsWith(`/${wanted}`) ||
        dataset.endsWith(`:${wanted}`);
      response.json({
        name,
        repositories,
        dataset: wanted,
        lineage: edges,
        upstream: [...upstream].sort(),
        downstream: [...downstream].sort(),
        producers: data.edges.filter((edge) => edge.kind === 'writes' && matches(edge.target)),
        consumers: data.edges.filter((edge) => edge.kind === 'reads' && matches(edge.target)),
        products: data.products.filter((product) =>
          [...product.outputPorts, ...product.inputPorts].some((port) => matches(port.dataset)),
        ),
        contracts: data.contracts.filter((contract) => matches(contract.bareId) || matches(contract.qualifiedId)),
        classifications: data.classifications.filter((tag) => !wanted || tag.dataset === wanted || tag.path.some((step) => step.dataset === wanted)),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * The data-on-code overlay: for every recorded file, the datasets it writes and reads and
   * the products it feeds. Off by default in the map; this serves the recorded facts only.
   */
  router.get('/analysis/data/overlay', async (_request, response) => {
    try {
      const { data } = await analyze();
      response.json(buildDataOverlay(data));
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * The recorded lineage as a static OpenLineage export, so a catalog can ingest what Strabo
   * read without Strabo becoming a catalog. Read-only and derived only from recorded facts.
   */
  router.get('/analysis/data/openlineage', async (_request, response) => {
    try {
      const { data } = await analyze();
      response.json(buildOpenLineage(data));
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * The data impact of a pending change: datasets a changed file writes, the downstream that
   * reaches them, and the products and contracts that raise the severity. Read-only, and only
   * the changed paths are accepted.
   */
  router.post('/analysis/data/impact', async (request, response) => {
    try {
      if (!isSameOriginRequest(request)) {
        response.status(403).json({ error: 'Data impact is computed only for the Strabo page.' });
        return;
      }
      const body = isRecord(request.body) ? request.body : {};
      const changedFiles = Array.isArray(body.files)
        ? body.files.filter((entry): entry is string => typeof entry === 'string')
        : [];
      const { name, data } = await analyze();
      const governedBy = new Map<string, string[]>();
      for (const edge of data.edges) {
        if (edge.kind !== 'governs') {
          continue;
        }
        const list = governedBy.get(edge.target) ?? [];
        list.push(edge.source);
        governedBy.set(edge.target, list);
      }
      const findings: DataImpactFinding[] = computeDataImpact({
        changedFiles,
        edges: data.edges,
        products: data.products,
        candidates: data.candidates,
        governedBy,
        lineage: data.lineage,
      });
      response.json({ name, changedFiles, findings });
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
