import type { CoverageGap, CoverageGapReport } from '../analysis/coverage-gaps.ts';
import { formatAge, type MeasuredCoverageSummary } from '../analysis/measured-coverage.ts';

/**
 * The coverage plan is model-generated narrative, framed like every other narrator request.
 *
 * Only the ranked weak coverage points and the measured report's provenance become evidence;
 * the instruction asks for a prioritised test plan. The builder is pure so the plan can be
 * shaped and checked without a provider, and a fact the evidence does not carry stays unsaid.
 */
export interface CoveragePlanRequest {
  instruction: string;
  evidence: string;
}

/** Most weak points listed before the evidence says it truncated. */
export const COVERAGE_PLAN_GAP_LIMIT = 40;

/** Bound on the evidence text, so a large repository cannot crowd out the instruction. */
export const COVERAGE_PLAN_EVIDENCE_LIMIT = 12_000;

export const COVERAGE_PLAN_INSTRUCTION = [
  'Write a prioritised test plan to close the weakest recorded coverage points in this',
  'repository, for a developer who is about to write the tests. Use only the recorded evidence',
  'and report only what it supports. For the leading points, name the file, why it matters',
  '(its direct and transitive dependents, or the cycle it sits in), and a concrete, minimal',
  'next step. Treat a file the report does not name as unrecorded, never as 0%. Say plainly',
  'when a fact is not recorded rather than guessing, and do not invent tests the evidence does',
  'not support. Lead with the highest-impact point and keep the plan tight; do not restate the',
  'evidence line by line or describe its format.',
].join(' ');

export interface CoveragePlanInput {
  repository: string;
  report: CoverageGapReport;
  /** The measured report the gaps were read from, when one was read; absent is the fallback. */
  measured?: MeasuredCoverageSummary | null;
}

/**
 * Turn the ranked gaps and the report provenance into the narrator's evidence.
 *
 * A repository with no gaps is stated as such rather than filled in, and the list is capped so
 * the evidence stays within its budget.
 */
export function buildCoveragePlanRequest(input: CoveragePlanInput): CoveragePlanRequest {
  const { report } = input;
  const lines: string[] = [];
  lines.push(`repository: ${input.repository || 'unknown'}`);
  lines.push(`coverage basis: ${report.basis}${basisDetail(input.measured)}`);
  lines.push(`under-covered threshold: ${report.threshold}%`);
  lines.push(`weak used files: ${report.total}`);
  lines.push(`used files the report does not name: ${report.notInReport}`);

  const gaps = report.gaps.slice(0, COVERAGE_PLAN_GAP_LIMIT);
  lines.push('weak coverage points (weakest first):');
  if (gaps.length === 0) {
    lines.push('- none recorded: no used file is under the threshold or unreached');
  } else {
    for (const gap of gaps) {
      lines.push(`- ${describeGap(gap)}`);
    }
    if (report.total > gaps.length) {
      lines.push(`- ${report.total - gaps.length} further weak file(s) not listed`);
    }
  }

  let evidence = lines.join('\n');
  if (evidence.length > COVERAGE_PLAN_EVIDENCE_LIMIT) {
    evidence = `${evidence.slice(0, COVERAGE_PLAN_EVIDENCE_LIMIT)}\n(evidence truncated)`;
  }
  return { instruction: COVERAGE_PLAN_INSTRUCTION, evidence };
}

/** One gap as an evidence line: the figure, the blast radius, and what already reaches it. */
function describeGap(gap: CoverageGap): string {
  const figure =
    gap.basis === 'measured' && gap.value !== null
      ? `measured ${gap.value}% of ${gap.linesFound ?? 0} line(s)`
      : 'no test reaches it';
  const stale = gap.stale ? ' (stale report for this file)' : '';
  const radius = `${gap.dependents} direct importer(s), ${gap.transitiveDependents} transitive dependent(s)`;
  const cycle = gap.cycleSize > 1 ? `; in a cycle of ${gap.cycleSize}` : '';
  const signals = gap.signals > 0 ? `; ${gap.signals} recorded function signal(s)` : '';
  const tests = gap.tests.length > 0 ? `; ${gap.tests.length} test(s) already reach it` : '';
  return `${gap.file}: ${figure}${stale}; ${radius}${cycle}${signals}${tests}`;
}

/** Where the measured figure came from, or that reachability stood in for a missing report. */
function basisDetail(measured: MeasuredCoverageSummary | null | undefined): string {
  if (!measured?.available) {
    return ' (reachability fallback: no coverage report was found)';
  }
  const format = measured.format ?? 'coverage';
  const path = measured.reportPath ?? 'unknown path';
  const age =
    measured.reportAgeMs !== null && measured.reportAgeMs !== undefined
      ? `, ${formatAge(measured.reportAgeMs)} old`
      : '';
  return ` (${format} report ${path}${age})`;
}
