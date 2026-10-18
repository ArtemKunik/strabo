import { Router } from 'express';
import fs from 'node:fs';

import { assertReadable } from '../../boundary/repository-root.ts';
import { rankCandidates, type FileReading } from '../../analysis/candidates.ts';
import { buildFunctions } from '../../analysis/functions.ts';
import { findIssue, resolveIssues } from '../../analysis/issues.ts';
import { buildRetention } from '../../analysis/retention.ts';
import { collectRelatedSources } from '../../analysis/related-sources.ts';
import { getCachedGraph } from '../../scan/graph.ts';
import { symbolExtractorFor } from '../../scan/languages/registry.ts';
import type { Graph } from '../../types.ts';
import { sendError } from '../http.ts';
import type { AnalysisContext } from './analysis-context.ts';

/**
 * The issue surfaces: one file's resource retention (Phase 40), and the ranked candidates for
 * a reported symptom (Phase 41).
 *
 * Extraction is on demand, exactly as `/symbols` does it, so a scan never pays for members it
 * does not need. A language with no symbol extractor says `not-implemented` rather than
 * reporting an empty reading.
 */
export function createIssuesRouter(context: AnalysisContext): Router {
  const router = Router();

  router.get('/analysis/retention', async (request, response) => {
    try {
      const repository = context.resolve(request);
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
          facts: [],
          signals: [],
          unavailable: [],
        });
        return;
      }

      const content = fs.readFileSync(assertReadable(repository.root, file), 'utf8');
      const graph = (await getCachedGraph(repository.root)).report.graph;
      const related = extractor.usesRelatedSources
        ? collectRelatedSources(repository.root, graph, file)
        : undefined;
      const result = await extractor.extract(file, content, related ? { related } : undefined);
      const report = buildRetention(file, result.symbols, result.calls ?? []);

      response.json({ ...report, language: extractor.language });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/analysis/candidates', async (request, response) => {
    try {
      const repository = context.resolve(request);
      const issues = resolveIssues(repository.root);
      const requested = typeof request.query.issue === 'string' ? request.query.issue : '';
      const issue = requested === '' ? undefined : findIssue(issues, requested);
      if (!issue) {
        response.status(400).json({
          error: requested === '' ? 'issue query parameter is required.' : `unknown issue class "${requested}".`,
          issues: issues.map((entry) => entry.name),
        });
        return;
      }

      const limit = parseLimit(request.query.limit);
      const graph = (await getCachedGraph(repository.root)).report.graph;
      const read = await readRepository(repository.root, graph, issue.ranksBy);
      response.json(
        rankCandidates(issue, read.readings, {
          ...(limit ? { limit } : {}),
          ...(read.note ? { note: read.note } : {}),
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}

/** Files read for one ranking. Bounded so a large repository cannot stall the request. */
const ISSUE_SCAN_CAP = 400;

interface RepositoryReading {
  readings: FileReading[];
  note?: string;
}

/**
 * Read every source file's signals for one ranking, bounded and capped.
 *
 * The extraction is the same on-demand path `/symbols` and the Functions tab use, so the
 * ranking and the passport cannot disagree. A file the extractor cannot read is skipped, and
 * the cap is named in the note rather than silently dropping files.
 */
async function readRepository(
  root: string,
  graph: Graph,
  ranksBy: string,
): Promise<RepositoryReading> {
  if (ranksBy === 'change' || ranksBy === 'breakage') {
    return {
      readings: [],
      note: `the ${ranksBy} reading is not wired to this endpoint yet; use /analysis/review or /analysis/impact`,
    };
  }

  const sourceNodes = graph.nodes.filter((node) => node.kind !== 'test');
  const files = sourceNodes.slice(0, ISSUE_SCAN_CAP);

  const readings: FileReading[] = [];
  let unread = 0;

  for (const node of files) {
    const extractor = symbolExtractorFor(node.id);
    if (!extractor) {
      continue;
    }
    try {
      const content = fs.readFileSync(assertReadable(root, node.id), 'utf8');
      const related = extractor.usesRelatedSources
        ? collectRelatedSources(root, graph, node.id)
        : undefined;
      const result = await extractor.extract(node.id, content, related ? { related } : undefined);
      const lines = node.lines ?? content.split('\n').length;

      if (ranksBy === 'compute') {
        const functions = buildFunctions(node.id, result.symbols, result.calls ?? []);
        readings.push({
          file: node.id,
          lines,
          recorded: functions.functions.length,
          signals: functions.functions.flatMap((entry) =>
            entry.signals.map((signal) => ({ kind: signal.kind, line: signal.line, detail: signal.detail })),
          ),
        });
        continue;
      }

      const retention = buildRetention(node.id, result.symbols, result.calls ?? []);
      readings.push({
        file: node.id,
        lines,
        recorded: retention.facts.length,
        signals: retention.signals.map((signal) => ({
          kind: signal.kind,
          line: signal.line,
          detail: signal.detail,
        })),
      });
    } catch {
      unread += 1;
    }
  }

  const notes = rankingLimits({
    sourceFiles: sourceNodes.length,
    readFiles: files.length,
    totalNodes: graph.nodes.length,
    unreadFiles: unread,
  });

  return { readings, ...(notes.length > 0 ? { note: notes.join('; ') } : {}) };
}

/**
 * What a ranking could not read, as separate facts rather than one conflated count.
 *
 * The cap is the caller's to raise; the test files are excluded on purpose. Reporting the two
 * as a single "read N of M" number made a complete read look truncated, and hid the reason.
 */
export function rankingLimits(counts: {
  sourceFiles: number;
  readFiles: number;
  totalNodes: number;
  unreadFiles: number;
}): string[] {
  const notes: string[] = [];
  const capped = counts.sourceFiles - counts.readFiles;
  if (capped > 0) {
    notes.push(
      `read the first ${counts.readFiles} of ${counts.sourceFiles} source files (the scan cap)`,
    );
  }
  const testNodes = counts.totalNodes - counts.sourceFiles;
  if (testNodes > 0) {
    notes.push(`${testNodes} test file(s) were not read`);
  }
  if (counts.unreadFiles > 0) {
    notes.push(`${counts.unreadFiles} file(s) could not be read and were skipped`);
  }
  return notes;
}

function parseLimit(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : null;
}
