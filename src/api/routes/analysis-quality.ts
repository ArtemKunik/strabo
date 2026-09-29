import { Router } from 'express';
import fs from 'node:fs';

import { computeCoverage } from '../../analysis/coverage.ts';
import {
  fileCoverageReport,
  folderCoverageReport,
  normaliseFolder,
  projectCoverageReport,
} from '../../analysis/coverage-report.ts';
import { computeFileHealth } from '../../analysis/file-health.ts';
import { UNDER_COVERED_THRESHOLD } from '../../analysis/file-coverage.ts';
import { computeRiskyUntested } from '../../analysis/coverage-risk.ts';
import { buildFunctions, type FunctionsReport } from '../../analysis/functions.ts';
import { rankHotspots } from '../../analysis/hotspots.ts';
import { getFileAuthorHistory } from '../../analysis/ownership.ts';
import { coverageProvenance } from '../../analysis/measured-coverage.ts';
import { refreshCoverage } from '../../analysis/coverage-refresh.ts';
import { computeQualityScorecard, smellsFromScorecard } from '../../analysis/quality.ts';
import { collectRelatedSources } from '../../analysis/related-sources.ts';
import { assertReadable } from '../../boundary/repository-root.ts';
import { getCachedGraph } from '../../cache/graph-cache.ts';
import { symbolExtractorFor } from '../../scan/languages/registry.ts';
import type { CodeSymbol, MemberAccess } from '../../scan/languages/symbols.ts';
import { isSameOriginRequest, parsePositiveInt, sendError } from '../http.ts';
import type { AnalysisContext } from './analysis-context.ts';
import { diffFile } from '../../analysis/diff.ts';
import { computeChangedLineCoverage, summariseChangedCoverage, type ChangedLineCoverage } from '../../analysis/changed-coverage.ts';
import { reviewWorkingTree, reviewCommit } from '../../analysis/review.ts';
import { readWorkingFile } from '../../analysis/git-content.ts';

/** Coverage, file-health, function, and quality endpoints. */
export function createQualityRouter(context: AnalysisContext): Router {
  const router = Router();
  const { config, resolve, measuredCoverage } = context;

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
        // The file ids the overlay marks; a report-named path not here is `not in report`.
        nodes: cached.report.graph.nodes.map((node) => node.id),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Coverage at the three scopes: project, a folder subtree, and one file.
   *
   * Every figure comes from the same measured-or-reachable reading the map uses, so a file
   * cannot be `measured` here and `reachable` elsewhere. A file the report does not name is
   * `not in report`, never 0%. The optional `threshold` (percent) overrides the under-covered
   * cut-off; it defaults to the published one.
   */
  router.get('/analysis/coverage/project', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const measured = await measuredCoverage(repository, cached.report.graph);
      response.json(
        projectCoverageReport(cached.report.graph, measured, coverageThreshold(request.query.threshold)),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/analysis/coverage/folder', async (request, response) => {
    try {
      const repository = resolve(request);
      const raw = typeof request.query.folder === 'string' ? request.query.folder : '';
      if (!raw.trim()) {
        response.status(400).json({ error: 'folder query parameter is required.' });
        return;
      }
      const folder = normaliseFolder(raw);
      const cached = await getCachedGraph(repository.root);
      const hasFolder =
        folder === '.' ||
        cached.report.graph.nodes.some(
          (node) => node.id === folder || node.id.startsWith(`${folder}/`),
        );
      if (!hasFolder) {
        response.status(404).json({ error: `no scanned file sits in folder "${folder}".` });
        return;
      }
      const measured = await measuredCoverage(repository, cached.report.graph);
      response.json(
        folderCoverageReport(cached.report.graph, measured, folder, coverageThreshold(request.query.threshold)),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/analysis/coverage/file', async (request, response) => {
    try {
      const repository = resolve(request);
      const file = typeof request.query.file === 'string' ? request.query.file : '';
      if (!file.trim()) {
        response.status(400).json({ error: 'file query parameter is required.' });
        return;
      }
      const cached = await getCachedGraph(repository.root);
      const measured = await measuredCoverage(repository, cached.report.graph, [file]);
      const report = fileCoverageReport(
        cached.report.graph,
        measured,
        file,
        coverageThreshold(request.query.threshold),
      );
      if (!report) {
        response.status(404).json({ error: `"${file}" is not a scanned file in this repository.` });
        return;
      }
      response.json(report);
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Changed-line coverage for the working tree or against a baseline revision.
   */
  router.get('/analysis/coverage/uncovered-changes', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const baseline = typeof request.query.baseline === 'string' && request.query.baseline.trim()
        ? request.query.baseline.trim()
        : null;

      const review = baseline
        ? await reviewCommit(repository.root, cached.report.graph, baseline)
        : await reviewWorkingTree(repository.root, cached.report.graph);

      const reviewFiles = review.available ? review.files : [];
      const measured = await measuredCoverage(repository, cached.report.graph);
      const threshold = coverageThreshold(request.query.threshold) ?? 100;

      const fileResults: ChangedLineCoverage[] = [];
      for (const file of reviewFiles) {
        if (file.status === 'deleted') {
          continue;
        }
        const diffResult = await diffFile(repository.root, {
          file: file.path,
          base: baseline ?? undefined,
          untracked: file.status === 'untracked',
        });
        if (diffResult.available) {
          const extractor = symbolExtractorFor(file.path);
          let functions;
          if (extractor) {
            const content = readWorkingFile(repository.root, file.path);
            if (content !== null) {
              try {
                const extraction = await extractor.extract(file.path, content);
                functions = buildFunctions(file.path, extraction.symbols, extraction.calls ?? []).functions;
              } catch {
                // extractor error; continue without functions
              }
            }
          }
          const item = computeChangedLineCoverage(diffResult.diff, measured, {
            functions,
          });
          fileResults.push(item);
        }
      }

      const totals = summariseChangedCoverage(fileResults);
      const belowThreshold = fileResults.filter(
        (item) => item.coveragePercent !== null && item.coveragePercent < threshold,
      );

      const isStale = measured?.files.some((f) => f.stale) ?? false;
      const basis = measured?.available ? (isStale ? 'stale' : 'measured') : 'unavailable';

      response.json({
        repository: repository.name,
        basis,
        reportPath: measured?.reportPath ?? null,
        reportModified: measured?.reportModified ?? null,
        reportAgeMs: measured?.reportAgeMs ?? null,
        stale: isStale,
        threshold,
        files: fileResults,
        belowThreshold,
        totals,
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Produce a coverage report by running the repository's own conventional coverage script
   * (`test:coverage`, `coverage`, …) and read it back, returning the project report. This is
   * the one analysis that executes repository code, so it is opt-in and same-origin only: with
   * `allowCoverageRefresh` off the route refuses, and the GET routes still name the detected
   * command for the operator to run by hand.
   */
  router.post('/analysis/coverage/refresh', async (request, response) => {
    try {
      if (!config.allowCoverageRefresh) {
        response.status(403).json({
          error:
            'coverage refresh is off; set STRABO_ALLOW_COVERAGE_REFRESH=1 to let the server run the repository script',
        });
        return;
      }
      if (!isSameOriginRequest(request)) {
        response.status(403).json({ error: "coverage refresh is only accepted from this server's own origin" });
        return;
      }
      const repository = resolve(request);
      const result = await refreshCoverage(repository.root);
      const cached = await getCachedGraph(repository.root);
      const measured = await measuredCoverage(repository, cached.report.graph);
      // A suite that exits non-zero still usually writes the report. Read it back regardless;
      // only refuse when the command produced nothing to read.
      if (!result.ok && !measured.available) {
        const notFound = result.reason === 'no-script' || result.reason === 'no-manifest';
        response.status(notFound ? 409 : 500).json({
          error: result.detail ?? 'the coverage command did not succeed',
          command: result.command,
          exitCode: result.exitCode,
          output: result.output,
        });
        return;
      }
      response.json({
        ...projectCoverageReport(
          cached.report.graph,
          measured,
          coverageThreshold(request.query.threshold),
        ),
        refresh: {
          ok: result.ok,
          command: result.command,
          output: result.output,
          ...(result.ok
            ? {}
            : { reason: result.reason, detail: result.detail ?? 'the coverage command did not succeed' }),
        },
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
   * Risky and untested functions (Phase 34 U5): the hotspots ranked by complexity × churn ×
   * uncovered share, with each input returned beside the rank. Churn is read from Git for the
   * hotspots only, bounded, so a wide repository does not pay a `git log` per file.
   */
  router.get('/analysis/coverage/risky', async (request, response) => {
    try {
      const repository = resolve(request);
      const cached = await getCachedGraph(repository.root);
      const limit = parsePositiveInt(request.query.limit, 50) ?? 50;
      const scannedCeiling = 400;
      const churnCeiling = 60;

      const candidates = cached.report.graph.nodes
        .map((node) => node.id)
        .filter((file) => symbolExtractorFor(file) !== null)
        .sort();
      const selected = candidates.slice(0, scannedCeiling);

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

      // Read churn for the hotspot files only: a git log per file is the expensive part.
      const hotspots = rankHotspots(reports, {
        limit: Number.MAX_SAFE_INTEGER,
        filesScanned: selected.length,
        filesSkipped: skipped,
      });
      const churnFiles = [...new Set(hotspots.hotspots.map((hotspot) => hotspot.file))].slice(0, churnCeiling);
      const churnByFile = new Map<string, number>();
      try {
        for (const entry of await getFileAuthorHistory(repository.root, churnFiles)) {
          churnByFile.set(entry.file, entry.commits);
        }
      } catch {
        // No Git history: churn is simply not an input, and the caption says so.
      }

      const report = computeRiskyUntested({ hotspots, churnByFile });
      response.json({
        ...report,
        rows: report.rows.slice(0, limit),
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

/** A 0-100 coverage threshold from the query, or the published default. */
function coverageThreshold(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : UNDER_COVERED_THRESHOLD;
}
