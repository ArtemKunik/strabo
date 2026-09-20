/**
 * Review data shapes shared by the review and change-passport analyses.
 *
 * These live apart from `review.ts` so `change-passport.ts` can name a `ReviewFile`
 * without importing `review.ts`, which itself needs `ChangePassport`. That type-only
 * import in both directions registers as a strongly connected component in the repository
 * graph, so the shared shapes are extracted here instead.
 */

/** How a path differs between the two sides of a review. */
export type ReviewStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'unmerged'
  | 'untracked';

/** Which side of a review a path belongs to. Commit reviews report `commit`. */
export type ReviewGroup = 'commit' | 'staged' | 'unstaged' | 'untracked';

/** One path in a change set, with the line counts Git recorded for it. */
export interface ReviewFile {
  path: string;
  /** Source path for a rename or copy. Absent otherwise. */
  previousPath?: string;
  status: ReviewStatus;
  group: ReviewGroup;
  /** `null` when Git reported no line counts (binary or untracked). */
  insertions: number | null;
  deletions: number | null;
  /** True when the path is a node in the scanned graph, so impact can reach it. */
  inGraph: boolean;
}

/** Cohesion of one changed file on each side of the review, from recorded member wiring. */
export interface CohesionChange {
  path: string;
  /** Source path for a rename or copy. Absent otherwise. */
  previousPath?: string;
  status: ReviewStatus;
  /** Cohesion of the base version; null when there is no baseline or it cannot be read. */
  before: number | null;
  /** Cohesion of the reviewed version; null when the file was deleted or is unreadable. */
  after: number | null;
  /** Why a side is missing, stated rather than left to imply a zero. */
  note: string;
}

/** Cohesion before and after a change, from the member wiring the symbol extractor records. */
export interface ChangePassport {
  files: CohesionChange[];
  /** The revision the working copy was compared against, or null when there is none. */
  baseline: string | null;
  /** True when there were more changed files than were measured. */
  capped: boolean;
}
