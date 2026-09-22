import type { CodeSymbol } from '../scan/languages/symbols.ts';

/**
 * A deterministic "this function is doing something costly" signal.
 *
 * Each signal is a recorded value crossing a documented threshold, or a recorded recursion.
 * It is a signal, not a verdict: a deeply nested function may be correct, and a linear scan
 * may be over a handful of items. The `detail` names the value that tripped it.
 */
export type FunctionSignalKind =
  | 'nested-loops'
  | 'linear-scan-in-loop'
  | 'sort-in-loop'
  | 'deep-nesting'
  | 'high-complexity'
  | 'long-function'
  | 'many-parameters'
  | 'recursion';

export interface FunctionSignal {
  kind: FunctionSignalKind;
  /** 1-based line of the function declaration the signal is attributed to. */
  line: number;
  /** The recorded value and the threshold, so the signal is explainable. */
  detail: string;
}

/** Thresholds for the metric-derived signals. Fixed, so a signal is reproducible. */
export const SIGNAL_THRESHOLDS = {
  nestedLoops: 2,
  deepNesting: 4,
  highComplexity: 10,
  longFunction: 50,
  manyParameters: 5,
} as const;

/**
 * Thresholds for the change-risk signals.
 *
 * A change-risk signal reuses the metric-derived threshold where one applies — a touched
 * function past the long-function or high-complexity line — and names the rest, so every
 * signal the risk shows carries the value and the threshold that produced it.
 */
export const CHANGE_RISK_THRESHOLDS = {
  linesTouched: SIGNAL_THRESHOLDS.longFunction,
  touchedComplexity: SIGNAL_THRESHOLDS.highComplexity,
  /** Importers whose recorded specifier names a changed symbol. */
  recordedReferences: 5,
  /** Share of the change and its references no test reaches, 0-1. */
  untestedShare: 1,
} as const;

/** Human-readable label per change-risk signal, so the value is never shown alone. */
export const CHANGE_RISK_SIGNAL_LABELS = {
  'lines-touched': 'Lines touched',
  'touched-complexity': 'Touched complexity',
  'recorded-references': 'Recorded references',
  'untested-share': 'Untested share',
} as const;

/** Human-readable label per signal kind, for a passport or panel. */
export const FUNCTION_SIGNAL_LABELS: Record<FunctionSignalKind, string> = {
  'nested-loops': 'Nested loops',
  'linear-scan-in-loop': 'Linear scan in a loop',
  'sort-in-loop': 'Sort in a loop',
  'deep-nesting': 'Deep nesting',
  'high-complexity': 'High complexity logic',
  'long-function': 'Long function',
  'many-parameters': 'Many parameters',
  recursion: 'Recursion',
};

/**
 * Derive signals from a function's recorded facts.
 *
 * A signature without a body records no metrics, so it yields no signals rather than
 * guessed ones. Only recorded values are used; nothing is inferred from names or text.
 */
export function computeSignals(symbol: CodeSymbol): FunctionSignal[] {
  const metrics = symbol.metrics;
  if (!metrics) {
    return [];
  }
  const line = symbol.line;
  const signals: FunctionSignal[] = [];

  if (metrics.loopNestingDepth >= SIGNAL_THRESHOLDS.nestedLoops) {
    signals.push({
      kind: 'nested-loops',
      line,
      detail: `loop nesting ${metrics.loopNestingDepth} (threshold ${SIGNAL_THRESHOLDS.nestedLoops})`,
    });
  }
  if (metrics.loopScans.length > 0) {
    signals.push({
      kind: 'linear-scan-in-loop',
      line,
      detail: `${metrics.loopScans.join(', ')} inside a loop`,
    });
  }
  if (metrics.loopSorts.length > 0) {
    signals.push({
      kind: 'sort-in-loop',
      line,
      detail: `${metrics.loopSorts.join(', ')} inside a loop`,
    });
  }
  if (metrics.maxNestingDepth >= SIGNAL_THRESHOLDS.deepNesting) {
    signals.push({
      kind: 'deep-nesting',
      line,
      detail: `nesting depth ${metrics.maxNestingDepth} (threshold ${SIGNAL_THRESHOLDS.deepNesting})`,
    });
  }
  if (metrics.decisionPoints >= SIGNAL_THRESHOLDS.highComplexity) {
    signals.push({
      kind: 'high-complexity',
      line,
      detail: `decision points ${metrics.decisionPoints} (threshold ${SIGNAL_THRESHOLDS.highComplexity})`,
    });
  }
  if (metrics.lines >= SIGNAL_THRESHOLDS.longFunction) {
    signals.push({
      kind: 'long-function',
      line,
      detail: `${metrics.lines} lines (threshold ${SIGNAL_THRESHOLDS.longFunction})`,
    });
  }
  if ((symbol.parameters ?? 0) >= SIGNAL_THRESHOLDS.manyParameters) {
    signals.push({
      kind: 'many-parameters',
      line,
      detail: `${symbol.parameters} parameters (threshold ${SIGNAL_THRESHOLDS.manyParameters})`,
    });
  }
  if (metrics.recursive) {
    signals.push({ kind: 'recursion', line, detail: 'calls itself' });
  }

  return signals;
}
