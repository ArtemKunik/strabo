/**
 * Pure functions that format a `/symbols` `functions` report for the Module Passport.
 *
 * No DOM, no fetch. Every caption is derived from recorded evidence; a function without a
 * body, or with no recorded calls, says so rather than showing an empty statement.
 */

/** `Owner.name`, or just the name for a module-level function. */
export function functionLabel(entry) {
  return entry?.owner ? `${entry.owner}.${entry.name}` : (entry?.name ?? '');
}

/** A one-line signature: visibility, name, parameter count, and return type. */
export function functionSignature(entry) {
  if (!entry) return '';
  const visibility = entry.visibility ? `${entry.visibility} ` : '';
  const parameters = entry.parameters ?? 0;
  const plural = parameters === 1 ? '' : 's';
  const returns = entry.type ? `: ${entry.type}` : '';
  return `${visibility}${entry.name}(${parameters} param${plural})${returns}`;
}

/** The recorded body metrics, or that the function is a signature without a body. */
export function functionMetrics(entry) {
  const metrics = entry?.metrics;
  if (!metrics) {
    return 'signature only; no body recorded';
  }
  const parts = [
    `L${entry.line}-${metrics.endLine}`,
    `${metrics.lines} line${metrics.lines === 1 ? '' : 's'}`,
    `complexity ${metrics.decisionPoints}`,
    `nesting ${metrics.maxNestingDepth}`,
    `loops ${metrics.loops}`,
  ];
  if (metrics.recursive) {
    parts.push('recursive');
  }
  return parts.join(' · ');
}

/** The entry badge for a function the runtime or a framework invokes, with its evidence. */
export function functionEntryBadge(entry) {
  const mark = entry?.entry;
  if (!mark) {
    return '';
  }
  return `entry: ${mark.kind} (${mark.evidence})`;
}

/** True when the recorded visibility can be used from another file. */
export function isPublicVisibility(visibility) {
  const value = String(visibility ?? '').toLowerCase();
  return value === 'public' || value === 'crate' || value.startsWith('pub') || value === 'export';
}

/** The functions of one report, worst signals first, then busiest. */
export function orderFunctions(entries) {
  return [...(entries ?? [])].sort(
    (a, b) =>
      (b?.signals?.length ?? 0) - (a?.signals?.length ?? 0) ||
      (b?.metrics?.decisionPoints ?? -1) - (a?.metrics?.decisionPoints ?? -1) ||
      (a?.line ?? 0) - (b?.line ?? 0) ||
      String(a?.name ?? '').localeCompare(String(b?.name ?? '')),
  );
}

/** One summary line for the file: counts plus the totals the table sorts by. */
export function functionSummary(report) {
  const functions = report?.functions ?? [];
  let totalComplexity = 0;
  let maxComplexity = 0;
  let maxNesting = 0;
  let signalCount = 0;
  for (const entry of functions) {
    totalComplexity += entry?.metrics?.decisionPoints ?? 0;
    maxComplexity = Math.max(maxComplexity, entry?.metrics?.decisionPoints ?? 0);
    maxNesting = Math.max(maxNesting, entry?.metrics?.maxNestingDepth ?? 0);
    signalCount += entry?.signals?.length ?? 0;
  }
  return (
    `${functions.length} function${functions.length === 1 ? '' : 's'}` +
    ` · total complexity ${totalComplexity} · max complexity ${maxComplexity}` +
    ` · max nesting ${maxNesting} · ${signalCount} signal${signalCount === 1 ? '' : 's'}`
  );
}
/** The callees recorded in this file, each with its call-site line. */
export function functionCalls(entry) {
  const calls = entry?.calls ?? [];
  if (calls.length === 0) {
    return 'no same-file calls recorded';
  }
  return calls.map((call) => `${call.name} (L${call.line})`).join(', ');
}

/**
 * The functions in this file recorded as calling this one.
 *
 * An entry keeps its badge instead of "no callers": a test, `main`, or handler has
 * no in-file caller by design. A public function without callers says the scope is
 * the file only, because cross-file calls are not resolved.
 */
export function functionCallers(entry) {
  const callers = entry?.callers ?? [];
  const badge = functionEntryBadge(entry);
  if (callers.length > 0) {
    return badge ? `${callers.join(', ')} · ${badge}` : callers.join(', ');
  }
  if (badge) {
    return badge;
  }
  if (isPublicVisibility(entry?.visibility)) {
    return 'no callers in this file (cross-file not resolved)';
  }
  return 'no callers recorded in this file';
}

/** The cost signals recorded for the function, each with the value that tripped it. */
export function functionSignals(entry) {
  const signals = entry?.signals ?? [];
  if (signals.length === 0) {
    return 'no cost signals';
  }
  return signals.map((signal) => `${signal.kind} (${signal.detail})`).join('; ');
}
