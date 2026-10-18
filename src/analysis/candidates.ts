import type { DeclaredIssue } from './issues.ts';

/**
 * Candidate ranking: turn a reported symptom into a ranked file set, by the recording the
 * class names — never by the map's own encoding.
 *
 * The map's node size is transitive dependents and its `Z` lens is lines of code, so a big,
 * well-connected file wins every ranking whatever the symptom was. This module ranks by the
 * *class's* reading instead, and it keeps the counter-evidence beside the answer: a large file
 * the reading looked at and found nothing in is listed as `notRanked` with the reason, so it
 * is visibly not the answer rather than silently absent.
 *
 * Pure: the caller does the extraction and the I/O and hands in `FileReading`s.
 */

/** One file's recorded reading, as the caller extracted it. */
export interface FileReading {
  file: string;
  lines: number;
  /** Signals the reading recorded, with the line and detail that produced each. */
  signals: Array<{ kind: string; line: number; detail: string }>;
  /** Recorded facts the reading saw, even when none matched the class. */
  recorded: number;
}

export interface Candidate {
  rank: number;
  file: string;
  lines: number;
  score: number;
  /** Why the file is here: one line per recorded signal that matched, with its detail. */
  reasons: string[];
  signals: Array<{ kind: string; line: number; detail: string }>;
}

/** A file the reading looked at and found no matching signal in — the counter-evidence. */
export interface NotRanked {
  file: string;
  lines: number;
  reason: string;
}

export interface CandidateRanking {
  issue: string;
  ranksBy: DeclaredIssue['ranksBy'];
  candidates: Candidate[];
  notRanked: NotRanked[];
  /** What the ranking could not do, named rather than hidden. */
  unavailable: string[];
}

export interface RankOptions {
  /** A file at or above this many lines with no matching signal is listed as counter-evidence. */
  notRankedAbove?: number;
  /** Candidates kept. */
  limit?: number;
  /** A class-level note folded into `unavailable` (e.g. the reading is not wired yet). */
  note?: string;
}

const DEFAULT_NOT_RANKED_ABOVE = 300;
const DEFAULT_LIMIT = 25;
const MAX_NOT_RANKED = 10;

/**
 * Rank the files whose recorded reading matches the class's signals.
 *
 * A signal earlier in the class's `signals` list weighs more, so the order an operator
 * declared is the severity order. A class with an empty `signals` list accepts every signal
 * the reading recorded, each at weight 1. A class whose reading produced nothing returns an
 * empty ranking and says so, never an alphabetical list that reads as a ranking.
 */
export function rankCandidates(
  issue: DeclaredIssue,
  readings: readonly FileReading[],
  options: RankOptions = {},
): CandidateRanking {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const notRankedAbove = options.notRankedAbove ?? DEFAULT_NOT_RANKED_ABOVE;
  const weightOf = new Map<string, number>();
  issue.signals.forEach((kind, index) => {
    weightOf.set(kind, issue.signals.length - index);
  });

  const unavailable: string[] = [];
  if (options.note) {
    unavailable.push(options.note);
  }

  const scored: Array<Omit<Candidate, 'rank'>> = [];
  const notRanked: NotRanked[] = [];

  for (const reading of readings) {
    const matched = reading.signals.filter(
      (signal) => issue.signals.length === 0 || weightOf.has(signal.kind),
    );
    if (matched.length > 0) {
      const score = matched.reduce((total, signal) => total + (weightOf.get(signal.kind) ?? 1), 0);
      scored.push({
        file: reading.file,
        lines: reading.lines,
        score,
        reasons: matched.map((signal) => `${signal.kind} (line ${signal.line}): ${signal.detail}`),
        signals: matched,
      });
      continue;
    }
    if (reading.lines >= notRankedAbove) {
      notRanked.push({
        file: reading.file,
        lines: reading.lines,
        reason: `no recorded ${issue.ranksBy} signal, though the file is ${reading.lines} lines`,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || b.lines - a.lines || a.file.localeCompare(b.file));
  const candidates: Candidate[] = scored
    .slice(0, limit)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));

  notRanked.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));

  if (candidates.length === 0) {
    unavailable.push(
      readings.length === 0
        ? 'no file was read for this class'
        : `no file recorded a matching ${issue.ranksBy} signal`,
    );
  }

  return {
    issue: issue.name,
    ranksBy: issue.ranksBy,
    candidates,
    notRanked: notRanked.slice(0, MAX_NOT_RANKED),
    unavailable,
  };
}
