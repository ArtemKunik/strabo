import type { CoverageTrendPoint, CoverageTrendReport } from '../analysis/coverage-trend.ts';

/**
 * The weekly coverage summary is model-generated narrative, framed like every other narrator
 * request.
 *
 * Only the trend of the static test reach across the window becomes evidence; the instruction
 * asks for a short weekly summary for a QA lead. The builder is pure so the summary can be
 * shaped and checked without a provider, and it says plainly that the trend is the test reach
 * at each revision, never a measured report for past commits.
 */
export interface CoverageWeeklyRequest {
  instruction: string;
  evidence: string;
}

/** Bound on the evidence text; the trend is small, so this is a guard, not a target. */
export const COVERAGE_WEEKLY_EVIDENCE_LIMIT = 8_000;

export const COVERAGE_WEEKLY_INSTRUCTION = [
  'Write a short weekly coverage summary for this repository, for a QA lead. Use only the',
  'recorded evidence and report only what it supports: state whether untested used files rose or',
  'fell and by how much, and the same for the reached share and the test-file count. Name the',
  'window and the revisions it spans. The trend is the static test reach at each commit, not a',
  'measured coverage report, so say so. Say plainly when a figure is not recorded rather than',
  'guessing, and do not pad or restate the evidence line by line.',
].join(' ');

export interface CoverageWeeklyInput {
  repository: string;
  report: CoverageTrendReport;
}

/**
 * Turn the coverage trend into the narrator's evidence.
 *
 * An unavailable trend is stated with its reason; an empty window is stated as such rather than
 * filled in, and the movement of every measure is listed oldest to newest.
 */
export function buildCoverageWeeklyRequest(input: CoverageWeeklyInput): CoverageWeeklyRequest {
  const { report } = input;
  const lines: string[] = [];
  lines.push(`repository: ${input.repository || 'unknown'}`);
  lines.push(`window: last ${report.days} day(s)`);

  if (!report.available) {
    lines.push(`coverage trend: not recorded (${report.reason ?? 'unavailable'})`);
    return { instruction: COVERAGE_WEEKLY_INSTRUCTION, evidence: lines.join('\n') };
  }

  const newest = report.points[0];
  const oldest = report.points[report.points.length - 1];
  lines.push(`revisions measured: ${report.points.length}`);
  lines.push(
    newest && oldest
      ? `span: ${describeCommit(oldest)} → ${describeCommit(newest)}`
      : 'span: none: no commit falls in the window',
  );
  lines.push(
    'basis: the static test reach at each revision; no measured coverage report is read for past revisions',
  );

  lines.push('weekly movement (oldest → newest):');
  for (const delta of report.deltas) {
    lines.push(
      `- ${delta.label}: ${formatValue(delta.from)} → ${formatValue(delta.to)} (${formatChange(delta.change)})`,
    );
  }

  let evidence = lines.join('\n');
  if (evidence.length > COVERAGE_WEEKLY_EVIDENCE_LIMIT) {
    evidence = `${evidence.slice(0, COVERAGE_WEEKLY_EVIDENCE_LIMIT)}\n(evidence truncated)`;
  }
  return { instruction: COVERAGE_WEEKLY_INSTRUCTION, evidence };
}

function describeCommit(point: CoverageTrendPoint): string {
  const subject = point.subject ? ` "${point.subject}"` : '';
  return `${point.short} ${point.date ?? 'no date'}${subject}`;
}

function formatValue(value: number | null): string {
  return value === null ? 'not recorded' : String(value);
}

function formatChange(change: number | null): string {
  if (change === null) return 'not recorded';
  return change > 0 ? `+${change}` : String(change);
}
