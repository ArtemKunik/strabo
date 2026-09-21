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

/** A metric or signal change on one function. */
export interface FunctionChange {
  /** The function name. */
  name: string;
  /** Enclosing type, or empty for a module function. */
  owner: string;
  /** 1-based line of the function declaration. */
  line: number;
  /** Decision points before the change; null when the base cannot be read. */
  decisionPointsBefore: number | null;
  /** Decision points after the change; null when the reviewed copy cannot be read. */
  decisionPointsAfter: number | null;
  /** Max nesting depth before. */
  nestingBefore: number | null;
  /** Max nesting depth after. */
  nestingAfter: number | null;
  /** Signals present before the change. */
  signalsBefore: string[];
  /** Signals present after the change. */
  signalsAfter: string[];
  /** True when a new signal was introduced. */
  signalIntroduced: boolean;
  /** True when an existing signal was resolved. */
  signalResolved: boolean;
  /** Body line count; null when the function has no body. */
  linesBefore: number | null;
  linesAfter: number | null;
}

/** A symbol added, removed, or with a changed signature. */
export interface SymbolChange {
  /** The symbol name. */
  name: string;
  /** Enclosing type, or empty for a module-level symbol. */
  owner: string;
  /** What happened to the symbol. */
  change: 'added' | 'removed' | 'changed-signature' | 'unchanged';
  /** The type signature before; null when added or no type recorded. */
  typeBefore: string | null;
  /** The type signature after; null when removed or no type recorded. */
  typeAfter: string | null;
  /** Parameters before; null when not recorded. */
  parametersBefore: number | null;
  /** Parameters after; null when not recorded. */
  parametersAfter: number | null;
}

/** The public surface diff for one changed file, per extractor language. */
export interface PublicSurfaceChange {
  /** The language of the extractor used. */
  language: string;
  /** Symbols added, removed, or with changed signatures. */
  symbols: SymbolChange[];
}

/** Tiered impact of a change on the dependency graph. */
export interface TieredImpact {
  /** Importers whose recorded specifier names a changed symbol — definite impact. */
  definite: string[];
  /** Other direct importers — possible impact. */
  possible: string[];
  /** The transitive set over use edges — reachable impact. */
  reachable: string[];
}

/** The pending-change risk and the inputs it multiplies, so the number can be checked. */
export interface ChangeRisk {
  /** linesTouched × touchedComplexity × definiteImpact × untestedShare. */
  score: number;
  inputs: {
    /** Lines in the touched functions on the reviewed side. */
    linesTouched: number;
    /** Sum of decision points in the touched functions. */
    touchedComplexity: number;
    /** Size of the definite-impact set. */
    definiteImpact: number;
    /** Share of the change and its definite dependents that no test reaches. */
    untestedShare: number;
  };
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
  /** Functions touched by the change, with before → after metrics and signals. */
  functions: FunctionChange[];
  /** Public surface diff (exported/pub symbols added, removed, changed). */
  publicSurface: PublicSurfaceChange[];
  /** Tiered impact: definite (specifier names a changed symbol), possible (other direct importers), reachable (transitive). */
  impact: TieredImpact | null;
  /** Test files whose forward closure reaches this file: the tests to run. */
  testsToRun: string[];
  /** Direct dependents that no test reaches. */
  untestedDependents: string[];
  /** The pending-change risk, or null when nothing measurable was touched. */
  risk: ChangeRisk | null;
}

/** Cohesion before and after a change, from the member wiring the symbol extractor records. */
export interface ChangePassport {
  files: CohesionChange[];
  /** The revision the working copy was compared against, or null when there is none. */
  baseline: string | null;
  /** True when there were more changed files than were measured. */
  capped: boolean;
}
