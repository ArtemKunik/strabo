import { Router } from 'express';

import { planExtraction } from '../../analysis/extraction.ts';
import { readDeclaredRules } from '../../analysis/rules.ts';
import { computeStringEdges } from '../../analysis/string-edges.ts';
import { buildTierReport } from '../../analysis/tiers.ts';
import { detectUnits } from '../../analysis/units.ts';
import { parseWhatIfOperations, simulateWhatIf } from '../../analysis/what-if.ts';
import { getCachedGraph } from '../../scan/graph.ts';
import { sendError } from '../http.ts';
import type { AnalysisContext } from './analysis-context.ts';

/**
 * The refactor sandbox (Phase 39): hypothetical edits to the recorded graph, and the cost of
 * extracting a file set. Both only read: nothing here writes to the repository or the cache.
 */
export function createSandboxRouter(context: AnalysisContext): Router {
  const router = Router();
  const { resolve } = context;

  /**
   * Plan extracting the files `include` selects (comma-separated globs; a bare directory means
   * everything under it): outward dependencies to cut or take along, inward dependents to
   * repoint, boundary cycles, string-edge crossings, and the external packages it imports.
   */
  router.get('/analysis/extraction', async (request, response) => {
    try {
      const repository = resolve(request);
      const include = splitList(request.query.include);
      if (include.length === 0) {
        response.status(400).json({ error: 'include query parameter is required (comma-separated globs).' });
        return;
      }
      const cached = await getCachedGraph(repository.root);
      const graph = cached.report.graph;
      const stringEdges = await computeStringEdges(repository.root, graph);
      response.json({ repository: repository.name, ...planExtraction(graph, include, { stringEdges }) });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Apply hypothetical edits (`ops`, a JSON array of `{op:"cut"|"add",source,target}` and
   * `{op:"move",from,to}`) to a copy of the recorded graph and report the cycles, wrong-way
   * tier edges, rule violations, and blast radius the edited graph would have. A GET, because
   * nothing is written; a malformed edit is returned in `rejected`, not applied.
   */
  router.get('/analysis/what-if', async (request, response) => {
    try {
      const repository = resolve(request);
      const raw = typeof request.query.ops === 'string' ? request.query.ops : '';
      let input: unknown;
      try {
        input = JSON.parse(raw);
      } catch {
        response.status(400).json({ error: 'ops must be a JSON array of operations.' });
        return;
      }
      const { operations, rejected } = parseWhatIfOperations(input);
      const cached = await getCachedGraph(repository.root);
      const graph = cached.report.graph;
      const tiers = buildTierReport(repository.root, repository.name, graph);
      const rules = readDeclaredRules(repository.root);
      const result = simulateWhatIf(graph, operations, {
        tierOf: new Map(tiers.files.map((entry) => [entry.file, entry.tier])),
        units: detectUnits(repository.root, graph.nodes.map((node) => node.id), repository.name),
        rules,
        stringEdges: rules.length > 0 ? await computeStringEdges(repository.root, graph) : null,
      });
      response.json({
        repository: repository.name,
        ...result,
        rejected: [...rejected, ...result.rejected],
        ...(tiers.truncated > 0 ? { tierTruncated: tiers.truncated } : {}),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}

function splitList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((entry): entry is string => typeof entry === 'string')
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
}
