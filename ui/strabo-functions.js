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

/** The callees recorded in this file, each with its call-site line. */
export function functionCalls(entry) {
  const calls = entry?.calls ?? [];
  if (calls.length === 0) {
    return 'no same-file calls recorded';
  }
  return calls.map((call) => `${call.name} (L${call.line})`).join(', ');
}

/** The functions in this file recorded as calling this one. */
export function functionCallers(entry) {
  const callers = entry?.callers ?? [];
  if (callers.length === 0) {
    return 'no callers recorded in this file';
  }
  return callers.join(', ');
}

/** The cost signals recorded for the function, each with the value that tripped it. */
export function functionSignals(entry) {
  const signals = entry?.signals ?? [];
  if (signals.length === 0) {
    return 'no cost signals';
  }
  return signals.map((signal) => `${signal.kind} (${signal.detail})`).join('; ');
}
