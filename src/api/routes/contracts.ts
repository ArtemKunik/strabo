import { Router } from 'express';

import {
  buildBoundaryView,
  buildContractBoundary,
  buildContractOverlay,
  computeContractImpact,
  type ContractBoundaryReport,
} from '../../analysis/data/contracts-graph.ts';
import { getCachedGraph } from '../../cache/graph-cache.ts';
import { openWorkspaceCache, type WorkspaceCache } from '../../cache/workspace-cache.ts';
import type { DataReport, Graph, StraboConfig } from '../../types.ts';
import { analyzeWorkspace } from '../../workspace/analyze.ts';
import { readWorkspaceConfig, resolveWorkspaceRepositories } from '../../workspace/config.ts';
import { isSameOriginRequest, sendError } from '../http.ts';

export interface ContractsRouterOptions {
  /** Fact cache; defaults to the persisted one. */
  cache?: WorkspaceCache;
}

/**
 * The data-contracts lens (Phase 36): governed boundaries between producer and consumer
 * units, the canvas overlay, edge evidence, the boundary plate view, and contract change
 * impact. Every edge exists only because a recorded import, call, or data use resolved
 * to a declared contract; the rest is reported uncontracted or unverified, never guessed.
 */
export function createContractsRouter(config: StraboConfig, options: ContractsRouterOptions = {}): Router {
  const router = Router();

  const analyze = async (): Promise<{
    name: string;
    repositories: string[];
    boundary: ContractBoundaryReport;
    data: DataReport;
  }> => {
    const { name, repositories } = resolveWorkspaceRepositories(config);
    const declared = readWorkspaceConfig(config.configPath);
    const workspace = await analyzeWorkspace(name, repositories, {
      cache: options.cache ?? openWorkspaceCache(),
      qualifiedContracts: declared?.contractsIdentity === 'qualified',
    });
    const graphs: Array<{ name: string; root: string; graph: Graph }> = [];
    for (const repository of repositories) {
      try {
        const cached = await getCachedGraph(repository.root);
        graphs.push({ name: repository.name, root: repository.root, graph: cached.report.graph });
      } catch {
        // A repository with no cached graph contributes no import/call edges; its data
        // edges still bound boundaries, and the gap is named in `unavailable`.
      }
    }
    const boundary = buildContractBoundary({
      repositories: graphs.length > 0
        ? graphs
        : repositories.map((repository) => ({
          name: repository.name,
          root: repository.root,
          graph: { nodes: [], edges: [], diagnostics: [], excluded: [] },
        })),
      data: workspace.data,
    });
    return {
      name,
      repositories: repositories.map((entry) => entry.name),
      boundary,
      data: workspace.data,
    };
  };

  router.get('/analysis/contracts/graph', async (_request, response) => {
    try {
      const { name, repositories, boundary } = await analyze();
      response.json({ name, repositories, ...boundary });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/analysis/contracts/overlay', async (_request, response) => {
    try {
      const { name, repositories, boundary } = await analyze();
      response.json({ name, repositories, ...buildContractOverlay(boundary) });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/analysis/contracts/boundary', async (_request, response) => {
    try {
      const { name, repositories, boundary } = await analyze();
      response.json({ name, repositories, ...buildBoundaryView(boundary) });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Edge evidence for one dependency (K3): the contract name, format, schema fields,
   * access role, and conformance check results. A pair with no recorded binding is
   * reported as uncontracted or unverified, never as governed.
   */
  router.get('/analysis/contracts/edge', async (request, response) => {
    try {
      const source = typeof request.query.source === 'string' ? request.query.source : '';
      const target = typeof request.query.target === 'string' ? request.query.target : '';
      const { name, boundary, data } = await analyze();
      const governed = boundary.governedEdges.filter(
        (edge) => (source === '' || edge.source === source) && (target === '' || edge.target === target),
      );
      const uncontracted = boundary.uncontractedBoundaries.filter(
        (edge) => (source === '' || edge.source === source) && (target === '' || edge.target === target),
      );
      const withFields = governed.map((edge) => {
        const definition = boundary.definitions.find((entry) => entry.id === edge.contract);
        const conformance = boundary.conformanceDeviations.filter(
          (finding) => finding.contract === edge.contract,
        );
        const access = data.edges
          .filter((dataEdge) => dataEdge.source === edge.source && (dataEdge.kind === 'reads' || dataEdge.kind === 'writes'))
          .map((dataEdge) => dataEdge.kind);
        return {
          ...edge,
          fields: definition?.fields ?? [],
          origin: definition?.origin ?? 'dto',
          conformanceFindings: conformance,
          access: [...new Set(access)],
        };
      });
      response.json({ name, source: source === '' ? null : source, target: target === '' ? null : target, governed: withFields, uncontracted });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Downstream consumers of one contract (K6 `get_contract_consumers`): the recorded
   * files and units bound through a governed edge, plus uncontracted bypass pairs.
   */
  router.get('/analysis/contracts/consumers', async (request, response) => {
    try {
      const contract = typeof request.query.contract === 'string' ? request.query.contract : '';
      const field = typeof request.query.field === 'string' ? request.query.field : null;
      const { name, repositories, boundary } = await analyze();
      if (contract === '') {
        response.status(400).json({ error: 'A contract query is required.' });
        return;
      }
      const governed = boundary.governedEdges.filter((edge) => edge.contract === contract);
      if (governed.length === 0) {
        response.json({
          name,
          repositories,
          contract,
          field,
          consumers: [],
          units: [],
          repositoriesTouched: [],
          bypass: [],
          unavailable: `no recorded consumer binds to ${contract}; it may be orphaned or unresolved`,
        });
        return;
      }
      const consumers = [...new Set(governed.flatMap((edge) => [edge.source, edge.target]))].sort();
      const units = [...new Set(governed.flatMap((edge) => [edge.sourceUnit, edge.targetUnit]))].sort();
      const bypass = boundary.uncontractedBoundaries.filter(
        (edge) => consumers.includes(edge.source) && consumers.includes(edge.target),
      );
      response.json({
        name,
        repositories,
        contract,
        field,
        consumers,
        units,
        repositoriesTouched: [...new Set(governed.map((edge) => edge.repository).filter((entry): entry is string => entry !== null))].sort(),
        bypass,
        conformance: boundary.conformanceDeviations.filter((finding) => finding.contract === contract),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Contract change blast radius (K4): exact field-level breaking changes for an edited
   * contract plus the direct and transitive downstream consumers. Accepts either an
   * explicit before/after shape or the changed files of a branch/review, in which case
   * every contract defined by those files is traced.
   */
  router.post('/analysis/contracts/impact', async (request, response) => {
    try {
      if (!isSameOriginRequest(request)) {
        response.status(403).json({ error: 'Contract impact is computed only for the Strabo page.' });
        return;
      }
      const body = isRecord(request.body) ? request.body : {};
      const { name, boundary, data } = await analyze();
      const downstreamOf = (dataset: string): string[] => {
        const seen = new Set<string>();
        const stack = data.lineage.filter((edge) => edge.source === dataset).map((edge) => edge.target);
        while (stack.length > 0) {
          const next = stack.pop() as string;
          if (seen.has(next)) {
            continue;
          }
          seen.add(next);
          for (const edge of data.lineage.filter((edge) => edge.source === next)) {
            stack.push(edge.target);
          }
        }
        return [...seen].sort();
      };

      if (typeof body.contract === 'string' && Array.isArray(body.before) && Array.isArray(body.after)) {
        const impact = computeContractImpact({
          contract: body.contract,
          before: body.before.filter(isContractField),
          after: body.after.filter(isContractField),
          boundary,
          downstreamOf,
        });
        response.json({ name, impacts: [impact] });
        return;
      }

      const changedFiles = Array.isArray(body.files)
        ? body.files.filter((entry): entry is string => typeof entry === 'string')
        : [];
      const contracts = boundary.definitions.filter((definition) => changedFiles.includes(definition.source));
      const impacts = contracts.map((definition) =>
        computeContractImpact({ contract: definition.id, before: definition.fields, after: definition.fields, boundary, downstreamOf }),
      );
      response.json({ name, changedFiles, impacts });
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isContractField(value: unknown): value is { name: string; type: string; required: boolean } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { type?: unknown }).type === 'string' &&
    typeof (value as { required?: unknown }).required === 'boolean'
  );
}
