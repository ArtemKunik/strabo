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

/** Which side of a review a path belongs to. Commit reviews report `commit`, branch reviews `branch`. */
export type ReviewGroup = 'commit' | 'branch' | 'staged' | 'unstaged' | 'untracked';

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

/**
 * How risky the current state of one file is, bounded to 0-100.
 *
 * A product of normalised inputs, each named so the number can be checked. The band is a
 * coarse reading of the score, not a second measure.
 */
export type RiskBand = 'low' | 'moderate' | 'high' | 'critical';

export interface ImpactRisk {
  /** 0-100, rounded. A bounded heuristic, not a repository percentile. */
  score: number;
  band: RiskBand;
  /** The raw values the score normalised, kept so the reading is inspectable. */
  inputs: {
    /** Most complex function's decision points in the reviewed state. */
    maxComplexity: number;
    /** Blast radius over use edges in the current graph. */
    blastRadius: number;
    /** Recorded function signals in the reviewed state. */
    signals: number;
    /** Share of direct dependents no test reaches, 0-1. */
    untestedShare: number;
    directImporters: number;
  };
}

/** Complexity of one file on each side of a change, and what did not move. */
export interface ComplexitySummary {
  maxBefore: number | null;
  maxAfter: number | null;
  /** Mean decision points per measured function. */
  averageBefore: number | null;
  averageAfter: number | null;
  sumBefore: number | null;
  sumAfter: number | null;
  functionCountBefore: number | null;
  functionCountAfter: number | null;
  /** Functions present on both sides whose decision points did not move. */
  functionsUnchanged: number | null;
  /** Declared types present on both sides with the same member count. */
  classesUnchanged: number | null;
}

/** How concentrated the changed symbols are within the file. */
export interface CoherenceSummary {
  /** 0-100: the largest connected component of changed symbols over their count. */
  score: number;
  changedSymbols: number;
  detail: string;
}

/** One cost signal, named and with the value that tripped it. */
export interface ImpactSignal {
  kind: string;
  label: string;
  detail: string;
}

/** A function ranked into a passport's most-complex list. */
export interface ImpactFunction {
  name: string;
  owner: string;
  /** Decision points in the reviewed state. */
  complexity: number;
  /** Decision points before the change; null when not measured or not a change. */
  before: number | null;
  /** complexity − before; null when before is null. */
  delta: number | null;
}

/** The current-graph counts a passport reports. */
export interface ImpactSnapshot {
  /** Transitive dependents over use edges. */
  blastRadius: number;
  directImporters: number;
  directImports: number;
}

/**
 * The Change impact passport for one file: the current state plus, when a baseline exists,
 * the deltas the change produced. Every field is read from the scan or Git; a value a side
 * cannot provide is null and named in `note`, never a fabricated zero.
 */
export interface FileImpactPassport {
  path: string;
  previousPath?: string;
  status: ReviewStatus;
  /** Current-state risk, or null when the file has no measurable state. */
  risk: ImpactRisk | null;
  complexity: ComplexitySummary;
  /** Concentration of the changed symbols; null when the file is not a change. */
  coherence: CoherenceSummary | null;
  snapshot: ImpactSnapshot;
  signals: ImpactSignal[];
  mostComplex: ImpactFunction[];
  /** Tiered impact when the file was reviewed against a baseline; null otherwise. */
  impact: TieredImpact | null;
  testsToRun: string[];
  untestedDependents: string[];
  note?: string;
}

/** The passport rolled up over every file in a change set or revision. */
export interface ImpactTotals {
  files: number;
  risk: { score: number; band: RiskBand } | null;
  maxComplexity: number | null;
  averageComplexity: number | null;
  /** Mean of the files' coherence scores, or null when none is a change. */
  coherence: number | null;
  /** Summed changed-symbol count across the files. */
  changedSymbols: number;
  /** Distinct files reachable from any changed file over use edges. */
  blastRadius: number;
  directImporters: number;
  directImports: number;
  signals: ImpactSignal[];
  mostComplex: ImpactFunction[];
  functionsUnchanged: number;
  classesUnchanged: number;
}

/** A passport at one of three scopes: one file, a change set, or a whole revision. */
export interface ImpactPassportSet {
  scope: 'file' | 'change-set' | 'revision';
  baseline: string | null;
  files: FileImpactPassport[];
  totals: ImpactTotals;
  capped: boolean;
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
  /**
   * The Change impact passport for this file: the current-state snapshot plus the deltas
   * this change produced. Always present, even when no baseline could be read.
   */
  impactPassport: FileImpactPassport;
}

/** Cohesion before and after a change, from the member wiring the symbol extractor records. */
export interface ChangePassport {
  files: CohesionChange[];
  /** The revision the working copy was compared against, or null when there is none. */
  baseline: string | null;
  /** True when there were more changed files than were measured. */
  capped: boolean;
}

/**
 * How a branch stands against the base it is compared with.
 *
 * Every field is read from Git or from the scanned graph. `conflicts` comes from a real
 * trial merge (`git merge-tree --write-tree`), never from guessing at overlapping paths;
 * when the installed Git cannot run one it is reported as unavailable.
 */
export interface BranchDivergence {
  branch: string;
  base: string;
  tipHash: string;
  baseHash: string;
  mergeBase: string;
  /** Commits on the branch that the base does not have. */
  ahead: number;
  /** Commits on the base that the branch does not have. */
  behind: number;
  /** Paths the base changed since the merge base; bounded, see `baseChangedCapped`. */
  baseChanged: string[];
  baseChangedCapped: boolean;
  /** Paths both sides changed since the merge base. */
  overlap: string[];
  conflicts:
    | { available: true; clean: boolean; paths: string[] }
    | { available: false; detail: string };
  /**
   * Base-side changes the branch's changed files depend on, through the checked-out graph:
   * code that moved underneath the branch. `via` is the nearest branch file that reaches it.
   */
  movedUnderneath: Array<{ id: string; via: string; distance: number }>;
  /** True when the branch tip is what is checked out, so the map is the branch's own graph. */
  checkedOut: boolean;
}
