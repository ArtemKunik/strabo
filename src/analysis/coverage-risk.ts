import type { HotspotReport } from './hotspots.ts';

/**
 * Risk from coverage (Phase 34 U5): the functions that are both structurally risky and
 * poorly covered, ranked, with every input shown beside the rank.
 *
 * The rank is a product of three recorded facts — complexity (Phase 14 decision points),
 * churn (Phase 17 Q5 commits), and the uncovered share of the function (Phase 27/34) — but a
 * product alone is never the answer: each input is returned so a reader sees why a function
 * ranks where it does, and a missing input is named as missing rather than counted as zero.
 */

/** The inputs U5 can read. Churn comes from Git authorship; coverage from the report. */
export interface RiskyUntestedInput {
  hotspots: HotspotReport;
  /** Commits touching a file, from Git authorship; absent means churn was not read. */
  churnByFile?: ReadonlyMap<string, number>;
  /** Uncovered share at or above this counts as untested. Defaults to 0.5 (50%). */
  uncoveredThreshold?: number;
}

/** One function in the risky-and-untested list, with its inputs for the caption. */
export interface RiskyUntestedRow {
  file: string;
  name: string;
  line: number;
  /** Decision points (Phase 14), or null when the function records none. */
  complexity: number | null;
  /** Commits touching the file (Phase 17 Q5), or null when churn was not read. */
  churn: number | null;
  /** Measured uncovered share of the function (0-1), or null when the report lacks it. */
  uncoveredShare: number | null;
  /** The inputs that entered the rank, named so the score is never bare. */
  inputs: string[];
  /** The product of the present inputs; null when none is present. */
  rankScore: number | null;
  /** True when the function is at or above the uncovered threshold, or coverage is absent. */
  untested: boolean;
}

export interface RiskyUntestedReport {
  available: boolean;
  /** Why the list could not be built, when it could not. */
  detail?: string;
  rows: RiskyUntestedRow[];
  /** Which inputs were available at all, so a caption can say what the rank is missing. */
  inputs: { complexity: boolean; churn: boolean; coverage: boolean };
  /** Hotspots left out because no input was present to rank them. */
  unranked: number;
}

/**
 * Rank functions by complexity × churn × uncovered share, over the inputs that are present.
 *
 * A function with no input at all is not ranked and is counted in `unranked` instead, so the
 * list never claims a function is risky without a recorded reason. The product is for order
 * only: the inputs travel with each row.
 */
export function computeRiskyUntested(input: RiskyUntestedInput): RiskyUntestedReport {
  const hotspots = input.hotspots;
  const churnByFile = input.churnByFile;
  const threshold = input.uncoveredThreshold ?? 0.5;
  let sawComplexity = false;
  let sawChurn = false;
  let sawCoverage = false;
  let unranked = 0;
  const rows: RiskyUntestedRow[] = [];

  for (const hotspot of hotspots.hotspots) {
    const complexity = hotspot.decisionPoints > 0 ? hotspot.decisionPoints : null;
    const churn = churnByFile?.get(hotspot.file) ?? null;
    const coverage = hotspot.coverage ?? null;
    let uncoveredShare: number | null = null;
    if (coverage) {
      if (typeof coverage.lineCoverage === 'number') {
        uncoveredShare = Number(((100 - coverage.lineCoverage) / 100).toFixed(3));
      } else if (coverage.linesFound > 0) {
        uncoveredShare = Number((1 - coverage.linesHit / coverage.linesFound).toFixed(3));
      }
    }

    const inputs: string[] = [];
    if (complexity !== null) {
      inputs.push('complexity');
      sawComplexity = true;
    }
    if (churn !== null) {
      inputs.push('churn');
      sawChurn = true;
    }
    if (uncoveredShare !== null) {
      inputs.push('uncovered');
      sawCoverage = true;
    }
    if (inputs.length === 0) {
      unranked += 1;
      continue;
    }

    const rankScore = (complexity ?? 1) * (churn ?? 1) * (uncoveredShare ?? 1);
    rows.push({
      file: hotspot.file,
      name: hotspot.name,
      line: hotspot.line,
      complexity,
      churn,
      uncoveredShare,
      inputs,
      rankScore: Number(rankScore.toFixed(3)),
      untested: uncoveredShare === null || uncoveredShare >= threshold,
    });
  }

  rows.sort(
    (a, b) =>
      (b.rankScore ?? 0) - (a.rankScore ?? 0) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );

  return {
    available: true,
    rows,
    inputs: { complexity: sawComplexity, churn: sawChurn, coverage: sawCoverage },
    unranked,
  };
}

/** A one-line caption for the risky-and-untested list, naming which inputs the rank used. */
export function riskyUntestedCaption(report: RiskyUntestedReport | null): string {
  if (!report || report.available === false) {
    return 'Risky and untested functions are unavailable.';
  }
  if (report.rows.length === 0) {
    return 'No function has a recorded complexity, churn, or uncovered share to rank.';
  }
  const inputs = report.inputs;
  const used = [
    inputs.complexity ? 'complexity' : null,
    inputs.churn ? 'churn' : null,
    inputs.coverage ? 'uncovered share' : null,
  ].filter((entry): entry is string => entry !== null);
  const missing = [
    inputs.complexity ? null : 'complexity',
    inputs.churn ? null : 'churn',
    inputs.coverage ? null : 'uncovered share',
  ].filter((entry): entry is string => entry !== null);
  return (
    `${report.rows.length} function(s) ranked by ${used.join(' × ')}` +
    (missing.length > 0 ? `; ${missing.join(' and ')} not recorded here` : '')
  );
}
