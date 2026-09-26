import { Router } from 'express';
import fs from 'node:fs';

import { computeCoverage } from '../../analysis/coverage.ts';
import { computeFileHealth } from '../../analysis/file-health.ts';
import { buildFunctions, type FunctionsReport } from '../../analysis/functions.ts';
import { rankHotspots } from '../../analysis/hotspots.ts';
import { coverageProvenance } from '../../analysis/measured-coverage.ts';
import { computeQualityScorecard, smellsFromScorecard } from '../../analysis/quality.ts';
import { collectRelatedSources } from '../../analysis/related-sources.ts';
import { assertReadable } from '../../boundary/repository-root.ts';
import { getCachedGraph } from '../../cache/graph-cache.ts';
import { symbolExtractorFor } from '../../scan/languages/registry.ts';
import type { CodeSymbol, MemberAccess } from '../../scan/languages/symbols.ts';
import { parsePositiveInt, sendError } from '../http.ts';
import type { AnalysisContext } from './analysis-context.ts';

/** Coverage, file-health, function, and quality endpoints. */
export function createQualityRouter(context: AnalysisContext): Router {
  const router = Router();
  const { resolve, measuredCoverage } = context;

  router.get('/analysis/test-reach', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      response.json(computeCoverage(cached.report.graph));
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Measured coverage from an existing report, with the static test-reach as the fallback.
   *
   * The report is read, never produced. A path the report names that is not a graph node is
   * listed in `measured.outOfGraph`; an absent or malformed report is `available: false`
   * with a reason, not zeros. `reachable` is always the graph-reach answer so a caller can
   * label a figure `measured` or `reachable`.
   */
  router.get('/analysis/coverage', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const measured = await measuredCoverage(repository, cached.report.graph);
      response.json({
        repository: repository.name,
        measured,
        reachable: { basis: 'reachable', ...computeCoverage(cached.report.graph) },
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Architecture health for one file. Symbol extraction runs here so the cohesion axis can
   * be derived from recorded member wiring; a file without an extractor keeps cohesion
   * unavailable rather than scoring it as zero.
   */
  router.get('/analysis/file-health', async (request, response) => {
    try {
      const repository = resolve(request);
      const file = typeof request.query.file === 'string' ? request.query.file : '';
      if (!file) {
        response.status(400).json({ error: 'file query parameter is required.' });
        return;
      }
      const cached = await getCachedGraph(repository.root);
      let symbols: CodeSymbol[] = [];
      let accesses: MemberAccess[] = [];
      const extractor = symbolExtractorFor(file);
      if (extractor) {
        try {
          const content = fs.readFileSync(assertReadable(repository.root, file), 'utf8');
          const related = extractor.usesRelatedSources
            ? collectRelatedSources(repository.root, cached.report.graph, file)
            : undefined;
          const result = await extractor.extract(file, content, related ? { related } : undefined);
          symbols = result.symbols;
          accesses = result.accesses ?? [];
        } catch {
          // The file may be binary or unreadable; cohesion stays unavailable.
        }
      }
      const cohesionUnavailable =
        extractor?.tracksAccess === false
          ? `not measured: ${extractor.language} members have no methods that read or write them`
          : undefined;
      const measured = await measuredCoverage(repository, cached.report.graph, [file]);
      response.json(
        computeFileHealth(cached.report.graph, file, symbols, accesses, cohesionUnavailable, measured),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Repository-wide function hotspots.
   *
   * Symbol extraction is on demand, so this extracts every supported source file in the
   * graph (bounded), derives each function's signals, and ranks them. Files without an
   * extractor, or that cannot be read, are counted as skipped rather than silently dropped.
   */
  router.get('/analysis/functions', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const limit = parsePositiveInt(request.query.limit, 50) ?? 50;
      const scannedCeiling = 400;

      const candidates = cached.report.graph.nodes
        .map((node) => node.id)
        .filter((file) => symbolExtractorFor(file) !== null)
        .sort();
      const selected = candidates.slice(0, scannedCeiling);

      // The measured report is read once for the files being examined, and the staleness
      // read is bounded to those files; a function the report does not name stays unavailable.
      const measured = await measuredCoverage(repository, cached.report.graph, selected);
      const coverageByFile = new Map(
        measured.files.filter((entry) => entry.inGraph).map((entry) => [entry.file, entry]),
      );

      const reports: FunctionsReport[] = [];
      let skipped = candidates.length - selected.length;
      for (const file of selected) {
        const extractor = symbolExtractorFor(file);
        if (!extractor) {
          skipped += 1;
          continue;
        }
        try {
          const content = fs.readFileSync(assertReadable(repository.root, file), 'utf8');
          const result = await extractor.extract(file, content);
          const entry = coverageByFile.get(file);
          reports.push(buildFunctions(file, result.symbols, result.calls ?? [], entry?.functions ?? []));
        } catch {
          skipped += 1;
        }
      }

      response.json({
        ...rankHotspots(reports, {
          limit,
          filesScanned: selected.length,
          filesSkipped: skipped,
        }),
        coverage: coverageProvenance(measured),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Quality scorecard: per-module measures ranked as repository percentiles.
   */
  router.get('/analysis/quality', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const scorecard = await computeQualityScorecard(
        cached.report.graph,
        repository.root,
        repository.name,
      );
      response.json(scorecard);
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Repository-wide smells: the scorecard's per-module rules, each with its tripping inputs.
   */
  router.get('/analysis/smells', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const scorecard = await computeQualityScorecard(
        cached.report.graph,
        repository.root,
        repository.name,
      );
      response.json(smellsFromScorecard(scorecard));
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
