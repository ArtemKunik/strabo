import { Router } from 'express';
import fs from 'node:fs';

import { assertReadable, resolveRepositoryRoot } from '../../boundary/repository-root.ts';
import { computeCoverage } from '../../analysis/coverage.ts';
import { buildFunctions } from '../../analysis/functions.ts';
import { buildMemberMap } from '../../analysis/member-map.ts';
import { computeMeasuredCoverage, measuredFileFigure } from '../../analysis/measured-coverage.ts';
import { collectRelatedSources } from '../../analysis/related-sources.ts';
import { getCachedGraph } from '../../cache/graph-cache.ts';
import { symbolExtractorFor } from '../../scan/languages/registry.ts';
import type { StraboConfig } from '../../types.ts';
import { sendError } from '../http.ts';

/**
 * Symbol extraction for a single file, on demand.
 *
 * Edges never need members, so extraction is not part of every scan. Languages without a
 * symbol extractor return `available: false` rather than an empty list, so the UI can say
 * "not implemented" instead of implying the file has no members.
 */
export function createSymbolsRouter(config: StraboConfig): Router {
  const router = Router();

  router.get('/symbols', async (request, response) => {
    try {
      const repository = resolveRepositoryRoot({
        workspaceRoot: config.workspaceRoot,
        scanCeiling: config.scanCeiling ?? config.workspaceRoot,
        requested:
          typeof request.query.repository === 'string' ? request.query.repository : undefined,
      });
      const file = typeof request.query.file === 'string' ? request.query.file : '';
      if (!file) {
        response.status(400).json({ error: 'file query parameter is required.' });
        return;
      }

      const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
      const extractor = symbolExtractorFor(file);
      if (!extractor) {
        response.json({
          file,
          available: false,
          reason: 'not-implemented',
          detail: `Symbol extraction is not implemented for "${extension || 'unknown'}" yet.`,
        });
        return;
      }

      const content = fs.readFileSync(assertReadable(repository.root, file), 'utf8');
      const graph = (await getCachedGraph(repository.root)).report.graph;
      // A language that splits a type across files needs the headers this one includes;
      // they come from the recorded edges, never from a search.
      const related = extractor.usesRelatedSources
        ? collectRelatedSources(repository.root, graph, file)
        : undefined;
      const result = await extractor.extract(file, content, related ? { related } : undefined);
      // Measured coverage is read for this one file only, so the staleness `git log` is a
      // single bounded call. A function the report does not name keeps no coverage mark.
      const measured = await computeMeasuredCoverage(repository.root, graph, {
        reportPaths: config.coverageReports,
        ceiling: config.scanCeiling ?? config.workspaceRoot,
        files: [file],
      });
      const measuredEntry = measured.files.find((entry) => entry.inGraph && entry.file === file);
      // Measured when a report names the file; otherwise the static reach, labelled as such.
      const reach = computeCoverage(graph);
      const reachable =
        reach.testFiles.length === 0
          ? { value: null, detail: 'no test files identified' }
          : reach.reached.includes(file) || reach.testFiles.includes(file)
            ? { value: 100, detail: `reachable from ${reach.testFiles.length} test file(s)` }
            : { value: 0, detail: 'no path from a test' };
      response.json({
        file,
        language: extractor.language,
        available: true,
        symbols: result.symbols,
        diagnostics: result.diagnostics,
        memberMap: buildMemberMap(file, result.symbols, result.accesses ?? [], result.reExports ?? []),
        coverage:
          measuredFileFigure(measured, file) ?? {
            basis: 'reachable',
            value: reachable.value,
            detail: reachable.detail,
            reportModified: measured.reportModified,
            reportAgeMs: measured.reportAgeMs,
            stale: null,
          },
        functions: buildFunctions(file, result.symbols, result.calls ?? [], measuredEntry?.functions ?? []),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
