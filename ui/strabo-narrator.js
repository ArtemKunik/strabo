/**
 * Pure helpers for the narrator affordance: the Functions tab, the System-view group
 * naming, and the Member map.
 *
 * The narrator returns model-generated narrative, which is not recorded evidence; these
 * helpers build the evidence that is sent and keep that distinction in the captions and in
 * what the reply renders, including when the narrator is unavailable.
 */

/** Attribution shown under any narrative, so it is never mistaken for recorded evidence. */
export const NARRATOR_ATTRIBUTION = 'Model-generated narrative — not recorded evidence.';

/**
 * A short status caption for the narrator endpoint.
 *
 * The unconfigured case is one line, "Narrator is off.", with the "Set up →" call to action
 * rendered as a button beside it; the old two-line "not configured" / "unavailable" pair is
 * gone, so the operator sees exactly one thing to do.
 */
export function narratorStatusLabel(status) {
  if (!status || status.configured !== true) {
    return 'Narrator is off.';
  }
  const remaining = status.remaining ?? 0;
  const budget = status.requestBudget ?? 0;
  return `Narrator ready · ${status.model} · ${remaining}/${budget} requests left`;
}

/** True when the narrator is off and the affordance should offer "Set up →". */
export function narratorNeedsSetup(status) {
  return !status || status.configured !== true;
}

/**
 * Why the Narrate / Name group buttons are disabled, or null when they are usable.
 *
 * The buttons are disabled with this reason as their tooltip rather than being clickable and
 * failing. `detail` carries a configured-but-failing explanation when the server supplies one.
 */
export function narratorDisabledReason(status) {
  if (narratorNeedsSetup(status)) {
    return 'Narrator is off — set it up in Settings.';
  }
  if (status.detail && status.reason) {
    return `Narrator unavailable: ${status.reason} — ${status.detail}`;
  }
  return null;
}

/** The plain-words result of a Test connection call, for the Settings panel. */
export function narratorTestLabel(result) {
  if (!result) {
    return 'Test the connection to see the model reply and its latency.';
  }
  if (result.ok === true) {
    const latency = typeof result.latencyMs === 'number' ? `${result.latencyMs} ms` : 'an unknown time';
    return `Connected · ${result.model} replied in ${latency}.`;
  }
  const reason = result.reason ?? 'provider-error';
  const detail = result.detail ? ` — ${result.detail}` : '';
  return `Not connected: ${reason}${detail}`;
}

/** The models listed by the provider, or the reason none could be listed. */
export function narratorModelsLabel(result) {
  if (result?.error) {
    return result.error;
  }
  const models = result?.models ?? [];
  if (models.length === 0) {
    return 'The provider listed no models; type the model id instead.';
  }
  return `${models.length} model${models.length === 1 ? '' : 's'} listed.`;
}

/** How the key source reads to the operator: never the key itself. */
export function narratorKeyLabel(key) {
  if (!key) {
    return 'No key source.';
  }
  if (key.source === 'env') {
    return `Key found in ${key.envVar} (value never shown).`;
  }
  if (key.source === 'stored') {
    return `Key stored on this machine for ${key.host ?? 'this host'}.`;
  }
  if (key.host && key.envSet === false) {
    return `No key set. Store one for ${key.host}, or name an environment variable.`;
  }
  return `Key missing: set ${key.envVar}, or store one on this machine.`;
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
 * The instruction for explaining a file's member map. The narrator describes the recorded
 * members and data flow only; it never claims wiring the scan did not record.
 */
export const MEMBER_NARRATION_INSTRUCTION =
  'Explain this type\'s recorded members and data flow in plain language, using only the ' +
  'recorded evidence. Do not infer behaviour from names, and say when something is not recorded.';

/** A recorded list as prose, or an explicit "none recorded" rather than an empty string. */
function recordedList(items) {
  return Array.isArray(items) && items.length > 0 ? items.join(', ') : 'none recorded';
}

/**
 * Build the recorded evidence sent to the narrator from a file's member map.
 *
 * Only recorded facts are included: each type's fields and methods with their visibility and
 * recorded read/write wiring, and the data-flow panels. An unrecorded type, member, or flow
 * is named as such rather than guessed at.
 */
export function buildMemberNarratorEvidence(memberMap) {
  const types = memberMap?.types ?? [];
  if (types.length === 0) {
    return 'No type is recorded for this file.';
  }
  const lines = [];
  for (const type of types) {
    lines.push(`Type: ${type.name} (${type.visibility ?? 'visibility not recorded'})`);
    lines.push(`Fields: ${(type.fields ?? []).length}`);
    for (const field of type.fields ?? []) {
      const mutable = field.mutable === false ? 'readonly' : 'mutable';
      const declared = field.declaredIn ? ` · declared in ${field.declaredIn}` : '';
      lines.push(
        `- ${field.name}: ${field.type ?? 'unrecorded type'} · ${field.visibility ?? 'unknown'} · ` +
          `${mutable} · reads ${field.reads ?? 0} · writes ${field.writes ?? 0}${declared}`,
      );
    }
    lines.push(`Methods: ${(type.methods ?? []).length}`);
    for (const method of type.methods ?? []) {
      const params = method.parameters ?? 0;
      const typeName = method.type ? `: ${method.type}` : '';
      lines.push(`- ${method.name}(${params})${typeName} · ${method.visibility ?? 'unknown'}`);
      lines.push(`  reads: ${recordedList(method.reads)}`);
      lines.push(`  writes: ${recordedList(method.writes)}`);
    }
  }

  const flow = memberMap?.dataFlow;
  if (!flow || flow.available === false) {
    lines.push(`Data flow: not recorded${flow?.detail ? ` — ${flow.detail}` : ''}`);
  } else {
    lines.push(`Data flow sources: ${recordedList(flow.sources)}`);
    lines.push(`Data flow resources: ${recordedList(flow.resources)}`);
    lines.push(`Data flow transforms: ${recordedList(flow.transforms)}`);
    lines.push(`Data flow sinks: ${recordedList(flow.sinks)}`);
  }
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
