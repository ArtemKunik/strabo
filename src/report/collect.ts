import fs from 'node:fs';

import { computeCoverage } from '../analysis/coverage.ts';
import { computeMeasuredCoverage } from '../analysis/measured-coverage.ts';
import { collectDrift } from '../analysis/drift.ts';
import { buildFunctions, type FunctionsReport } from '../analysis/functions.ts';
import { rankHotspots } from '../analysis/hotspots.ts';
import { computeOwnership, getFileAuthorHistory } from '../analysis/ownership.ts';
import { computeQualityScorecard, smellsFromScorecard } from '../analysis/quality.ts';
import { reviewWorkingTree } from '../analysis/review.ts';
import { assertReadable } from '../boundary/repository-root.ts';
import { computeRiskReport, type RiskOptions } from '../risk/report.ts';
import { symbolExtractorFor } from '../scan/languages/registry.ts';
import type { Graph } from '../types.ts';
import {
  buildRepositoryReport,
  type RepositoryChangeSection,
  type RepositoryReportDocument,
  type ReportLimits,
  type ReportRevision,
} from './repository-report.ts';

/** Files examined for function hotspots, matching the `/analysis/functions` ceiling. */
const HOTSPOT_FILE_CEILING = 400;
/** Files whose authorship is read, ranked by transitive dependents. */
const OWNERSHIP_FILE_CEILING = 100;

export interface CollectRepositoryReportOptions {
  repository: string;
  root: string;
  graph: Graph;
  extensionCounts?: Record<string, number>;
  revision: ReportRevision;
  /** Include the pending working-tree change set. Defaults to true. */
  change?: boolean;
  /** Compute quality smells (reads Git history). Defaults to true. */
  smells?: boolean;
  /** Compute function hotspots (extracts symbols). Defaults to true. */
  hotspots?: boolean;
  /** Compute ownership and bus factor (reads Git authorship). Defaults to true. */
  ownership?: boolean;
  /** Compute architecture drift over recent revisions (revision graphs). Defaults to true. */
  drift?: boolean;
  /** Dependency-risk config; omitted means the risk section is not computed. */
  risk?: RiskOptions;
  /** Where to read the measured coverage report; omitted means the conventional locations. */
  coverage?: { reportPaths?: readonly string[]; ceiling?: string };
  generatedAt?: string;
  limits?: Partial<ReportLimits>;
}

/**
 * Gather the recorded analyses a repository report composes and build the document.
 *
 * This is the I/O half: the pure builder takes these inputs and ranks them. Both the CLI and
 * the HTTP route call this, so a report from either surface is the same document.
 */
export async function collectRepositoryReport(
  options: CollectRepositoryReportOptions,
): Promise<RepositoryReportDocument> {
  const { root, graph } = options;

  const smells =
    options.smells === false
      ? undefined
      : smellsFromScorecard(await computeQualityScorecard(graph, root, options.repository));

  const hotspots = options.hotspots === false ? undefined : await collectHotspots(root, graph);

  const ownership =
    options.ownership === false ? undefined : await collectOwnership(root, graph);

  const risk = options.risk ? await computeRiskReport(root, graph, options.risk) : undefined;

  const change = options.change === false ? undefined : await collectWorkingTreeChange(root, graph);

  const drift =
    options.drift === false ? undefined : await collectDrift(root, options.repository, { limit: 10 });

  // Read, never run: the report the repository already has, or unavailable with a reason.
  const coverage = await computeMeasuredCoverage(root, graph, {
    ...(options.coverage?.reportPaths ? { reportPaths: options.coverage.reportPaths } : {}),
    ...(options.coverage?.ceiling ? { ceiling: options.coverage.ceiling } : {}),
  });

  return buildRepositoryReport({
    repository: options.repository,
    root,
    graph,
    ...(options.extensionCounts ? { extensionCounts: options.extensionCounts } : {}),
    revision: options.revision,
    ...(smells ? { smells } : {}),
    ...(hotspots ? { hotspots } : {}),
    ...(ownership ? { ownership } : {}),
    ...(risk ? { risk } : {}),
    ...(change ? { change } : {}),
    ...(drift ? { drift } : {}),
    coverage,
    ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  });
}

async function collectHotspots(root: string, graph: Graph) {
  const candidates = graph.nodes
    .map((node) => node.id)
    .filter((file) => symbolExtractorFor(file) !== null)
    .sort();
  const selected = candidates.slice(0, HOTSPOT_FILE_CEILING);

  const reports: FunctionsReport[] = [];
  let skipped = candidates.length - selected.length;
  for (const file of selected) {
    const extractor = symbolExtractorFor(file);
    if (!extractor) {
      skipped += 1;
      continue;
    }
    try {
      const content = fs.readFileSync(assertReadable(root, file), 'utf8');
      const result = await extractor.extract(file, content);
      reports.push(buildFunctions(file, result.symbols, result.calls ?? [], []));
    } catch {
      skipped += 1;
    }
  }
  return rankHotspots(reports, { filesScanned: selected.length, filesSkipped: skipped });
}

async function collectOwnership(root: string, graph: Graph) {
  const files = [...graph.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node) => node.id)
    .slice(0, OWNERSHIP_FILE_CEILING);
  const history = await getFileAuthorHistory(root, files);
  return computeOwnership(history, graph);
}

async function collectWorkingTreeChange(
  root: string,
  graph: Graph,
): Promise<RepositoryChangeSection | null> {
  const review = await reviewWorkingTree(root, graph);
  if (!review.available) {
    return null;
  }
  const coverage = computeCoverage(graph);
  const reached = new Set(coverage.reached);
  const tests = new Set(coverage.testFiles);
  const changed = review.files.map((file) => file.path);
  const untestedReach = review.impact.affected
    .map((entry) => entry.id)
    .filter((id) => !reached.has(id) && !tests.has(id))
    .sort();

  return {
    base: 'HEAD',
    baseRevision: null,
    head: null,
    changedFiles: review.files.map((file) => ({
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      status: file.status,
    })),
    reach: {
      changed,
      affected: review.impact.affected,
      outsideGraph: review.impact.outsideGraph,
    },
    untestedReach,
    hotspotsTouched: [],
    structural: null,
    warnings: review.excluded?.map((entry) => `${entry.path} excluded (${entry.reason})`) ?? [],
  };
}
