import type { CodeSymbol, FunctionCall, FunctionMetrics } from '../scan/languages/symbols.ts';
import type { FunctionEntryMark } from '../scan/languages/entry.ts';
import type { MeasuredFunctionCoverage } from './measured-coverage.ts';
import { computeSignals, type FunctionSignal } from './signals.ts';

/** One recorded call made by a function, inside the same file. */
export interface FunctionCallSite {
  /** The callee name as authored. */
  name: string;
  kind: FunctionCall['kind'];
  /** The receiver for `self`/type-qualified calls. */
  receiver?: string;
  line: number;
}

/** One function or method with its body metrics and recorded call relationships. */
export interface FunctionEntry {
  name: string;
  /** Enclosing type (`Outer.Inner`), or empty for a module function. */
  owner: string;
  visibility: string;
  /** Declared return type, when the language records one. */
  type?: string;
  parameters?: number;
  line: number;
  /** Body measurements; absent for a signature without a body. */
  metrics?: FunctionMetrics;
  /** Calls made from this function that resolve to a function in this file. */
  calls: FunctionCallSite[];
  /** Functions in this file that call this one, as `Owner.name` or `name`. */
  callers: string[];
  /** Why the function runs without an in-file caller, with its evidence. */
  entry?: FunctionEntryMark;
  /** Deterministic cost signals from the recorded metrics. */
  signals: FunctionSignal[];
  /**
   * Measured coverage when a report names this function. Absent when the report does not,
   * so the UI says `unavailable` rather than 0%.
   */
  coverage?: MeasuredFunctionCoverage;
}

/**
 * The functions of one file: every method or function symbol, its recorded body metrics,
 * and the calls that resolve inside the file.
 *
 * Nothing is inferred across files. A function whose body the extractor could not read
 * keeps `metrics` absent rather than a fabricated zero, and a call site only appears when
 * the scan proved its target is declared here.
 */
export interface FunctionsReport {
  file: string;
  available: boolean;
  functions: FunctionEntry[];
}

/**
 * Build the function list for a file from its extracted symbols and recorded calls.
 *
 * `coverage` is the measured per-function coverage the report records for this file, when
 * one was read; a function it does not name keeps no `coverage`, which the UI reads as
 * `unavailable` rather than 0%.
 */
export function buildFunctions(
  file: string,
  symbols: CodeSymbol[],
  calls: FunctionCall[] = [],
  coverage: readonly MeasuredFunctionCoverage[] = [],
): FunctionsReport {
  const methods = symbols.filter((symbol) => symbol.kind === 'method');

  const functions: FunctionEntry[] = methods.map((symbol) => {
    const measured = coverageMark(symbol, coverage);
    return {
      name: symbol.name,
      owner: symbol.owner,
      visibility: symbol.visibility,
      type: symbol.type,
      parameters: symbol.parameters,
      line: symbol.line,
      metrics: symbol.metrics,
      calls: callsOf(symbol, calls),
      callers: callersOf(symbol, methods, calls),
      ...(symbol.entry ? { entry: symbol.entry } : {}),
      signals: computeSignals(symbol),
      ...(measured ? { coverage: measured } : {}),
    };
  });

  // Worst signals first, then busiest; source order breaks ties, and signatures
  // without a body sort last.
  functions.sort(
    (a, b) =>
      b.signals.length - a.signals.length ||
      complexity(b) - complexity(a) ||
      a.line - b.line ||
      a.name.localeCompare(b.name),
  );

  return { file, available: true, functions };
}

/**
 * Match a symbol to its measured coverage by name, preferring the report's line when it
 * agrees with the declaration. A name with no recorded entry returns undefined.
 */
function coverageMark(
  symbol: CodeSymbol,
  coverage: readonly MeasuredFunctionCoverage[],
): MeasuredFunctionCoverage | undefined {
  const candidates = coverage.filter((entry) => entry.name === symbol.name);
  if (candidates.length === 0) {
    return undefined;
  }
  return candidates.find((entry) => entry.line > 0 && entry.line === symbol.line) ?? candidates[0];
}

function complexity(entry: FunctionEntry): number {
  return entry.metrics?.decisionPoints ?? -1;
}

function callsOf(symbol: CodeSymbol, calls: FunctionCall[]): FunctionCallSite[] {
  return calls
    .filter((call) => call.owner === symbol.owner && call.method === symbol.name)
    .map((call) => ({
      name: call.callee,
      kind: call.kind,
      ...(call.receiver ? { receiver: call.receiver } : {}),
      line: call.line,
    }))
    .sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

function callersOf(target: CodeSymbol, methods: CodeSymbol[], calls: FunctionCall[]): string[] {
  const callers = new Set<string>();
  for (const call of calls) {
    if (call.callee !== target.name || !targetsOwner(call, target, methods)) {
      continue;
    }
    callers.add(call.owner ? `${call.owner}.${call.method}` : call.method);
  }
  return [...callers].sort();
}

/**
 * Whether a call's target is this symbol's owner.
 *
 * A proven receiver (`targetOwner`) matches directly. A bare call can name a module
 * function or a method of the caller's own type: when its name is unique in the file it is
 * attributed to that sole definition, otherwise it is claimed only for the caller's own
 * owner, so a same-named method elsewhere is not.
 */
function targetsOwner(call: FunctionCall, target: CodeSymbol, methods: CodeSymbol[]): boolean {
  if (call.targetOwner !== undefined) {
    return call.targetOwner === target.owner;
  }
  const sameName = methods.filter((candidate) => candidate.name === call.callee);
  if (sameName.length === 1) {
    return sameName[0]?.owner === target.owner;
  }
  return target.owner === call.owner;
}
