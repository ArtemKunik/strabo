/**
 * Pure helpers for the narrator affordance in the Functions tab.
 *
 * The narrator returns model-generated narrative, which is not recorded evidence; these
 * helpers build the evidence that is sent and keep that distinction in the captions and in
 * what the reply renders, including when the narrator is unavailable.
 */

/** Attribution shown under any narrative, so it is never mistaken for recorded evidence. */
export const NARRATOR_ATTRIBUTION = 'Model-generated narrative — not recorded evidence.';

/** A short status caption for the narrator endpoint; the unconfigured case is named plainly. */
export function narratorStatusLabel(status) {
  if (!status || status.configured !== true) {
    return 'Narrator is not configured. Set an endpoint and model to enable it.';
  }
  const remaining = status.remaining ?? 0;
  const budget = status.requestBudget ?? 0;
  return `Narrator ready · ${status.model} · ${remaining}/${budget} requests left`;
}

/** The narrative text when available, or the reason and detail when it is not. */
export function narratorReplyLabel(reply) {
  if (reply?.available === true) {
    return reply.text ?? '';
  }
  const reason = reply?.reason ?? 'provider-error';
  const detail = reply?.detail ? ` — ${reply.detail}` : '';
  return `Narrator unavailable: ${reason}${detail}`;
}

/**
 * The instruction for proposing a group name. The narrator may only name and describe; it
 * never creates, merges, or splits a group, because a group is recorded structure, not a
 * suggestion.
 */
export const GROUP_NAMING_INSTRUCTION =
  'Propose one short name and a one-line purpose for this build unit, using only the recorded ' +
  'evidence. Do not create, merge, or split groups, and do not claim relationships the ' +
  'evidence does not show.';

/**
 * Build the recorded evidence sent to the narrator for one System-view unit.
 *
 * Only recorded facts are included: the unit's manifest name, its file and support counts,
 * the reason it is grouped, and its recorded import edges. Unrecorded values are named as
 * such rather than guessed at.
 */
export function buildGroupNamingEvidence(model, id) {
  const node = (model?.nodes ?? []).find((candidate) => candidate.id === id);
  if (!node) {
    return 'No unit is recorded for this selection.';
  }
  const edges = model?.edges ?? [];
  const imports = edges
    .filter((edge) => edge.source === id)
    .map((edge) => {
      const targetNode = (model.nodes ?? []).find((candidate) => candidate.id === edge.target);
      return targetNode?.label ?? edge.target;
    });
  const usedBy = edges
    .filter((edge) => edge.target === id)
    .map((edge) => {
      const sourceNode = (model.nodes ?? []).find((candidate) => candidate.id === edge.source);
      return sourceNode?.label ?? edge.source;
    });

  const lines = [
    `Unit: ${node.label ?? id}`,
    `Directory: ${id}`,
    `Grouped by: ${node.why ?? 'not recorded'}`,
    `Component files: ${node.files ?? 'not recorded'}`,
    `Support files folded into its shelf: ${node.periphery ?? 0}`,
    `Recorded imports: ${imports.length > 0 ? imports.join(', ') : 'none recorded'}`,
    `Recorded used-by: ${usedBy.length > 0 ? usedBy.join(', ') : 'none recorded'}`,
  ];
  return lines.join('\n');
}

/**
 * Build the recorded evidence sent to the narrator from a file's functions report.
 *
 * Only recorded facts are included: each function's line, metrics, signals, and same-file
 * calls. Nothing is inferred from names, and an unrecorded inventory says so.
 */
export function buildNarratorEvidence(result) {
  const report = result?.functions;
  if (
    !report ||
    report.available === false ||
    !Array.isArray(report.functions) ||
    report.functions.length === 0
  ) {
    return 'No function inventory is recorded for this file.';
  }
  const lines = [`File: ${report.file ?? 'unknown'}`, `Functions: ${report.functions.length}`];
  for (const entry of report.functions) {
    const owner = entry.owner ? `${entry.owner}.` : '';
    lines.push(`- ${owner}${entry.name} (line ${entry.line})`);
    if (entry.metrics) {
      lines.push(
        `  metrics: complexity ${entry.metrics.decisionPoints}, ` +
          `nesting ${entry.metrics.maxNestingDepth}, lines ${entry.metrics.lines}`,
      );
    }
    if (Array.isArray(entry.signals) && entry.signals.length > 0) {
      lines.push(`  signals: ${entry.signals.map((signal) => `${signal.kind} (${signal.detail})`).join('; ')}`);
    }
    if (Array.isArray(entry.calls) && entry.calls.length > 0) {
      lines.push(`  calls: ${entry.calls.map((call) => `${call.name} (L${call.line})`).join(', ')}`);
    }
  }
  return lines.join('\n');
}
