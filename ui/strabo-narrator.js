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
 * The instruction for narrating one file from its recorded members, wiring, and neighbours.
 *
 * The reply is short prose about what the file is for and what a reviewer should know, not a
 * restatement of the counts already on screen. Paths, names, and import relationships are
 * recorded, so the narrator may read meaning from them, but it must word that as a reading
 * ("appears to") and never claim wiring or behaviour the recorded evidence does not show.
 */
export const MEMBER_NARRATION_INSTRUCTION =
  'In three to five sentences of plain prose, say what this file appears to be for, what ' +
  'relies on it, and anything a reviewer should know. Do not use lists, headings, or ' +
  'markdown, and do not repeat counts the reader can already see. The path, member names, ' +
  'and import relationships are recorded and may be read for meaning; word that as a reading ' +
  '("appears to"), not as fact. Use only the recorded evidence: never invent behaviour, and ' +
  'say so briefly when something is not recorded.';

/** The file's base name without its extension, which the scan uses to name module-level members. */
function fileStem(file) {
  const base = String(file ?? '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** A recorded list as prose, or an explicit "none recorded" rather than an empty string. */
function recordedList(items) {
  return Array.isArray(items) && items.length > 0 ? items.join(', ') : 'none recorded';
}

/**
 * Build the recorded evidence sent to the narrator from a file's member map.
 *
 * Only recorded facts are included: the file and its recorded neighbours, each type's fields
 * and methods with their visibility and recorded read/write wiring, and the data-flow panels.
 * An unrecorded type, member, or flow is named as such rather than guessed at.
 *
 * `context` carries what the member map alone cannot say: `file`, the recorded `imports` and
 * `usedBy` ids, and the file's `functions` report. Members declared straight in the file, not
 * in a class, are recorded under a name derived from the file; they are described as
 * module-level so the narrator does not mistake that name for a declared type.
 */
export function buildMemberNarratorEvidence(memberMap, context = {}) {
  const types = memberMap?.types ?? [];
  if (types.length === 0) {
    return 'No type is recorded for this file.';
  }
  const file = context.file ?? memberMap?.file;
  const moduleName = file ? fileStem(file) : null;
  const lines = [];
  if (file) {
    lines.push(`File: ${file}`);
  }
  // Two edges from one file (an import and a re-export) are one neighbour.
  for (const [label, ids] of [['imports', context.imports], ['used-by', context.usedBy]]) {
    if (Array.isArray(ids)) {
      const distinct = [...new Set(ids)];
      lines.push(`Recorded ${label} (${distinct.length}): ${recordedList(distinct.slice(0, 12))}`);
    }
  }
  for (const type of types) {
    const isModule = Boolean(moduleName) && type.name === moduleName;
    lines.push(
      isModule
        ? 'Module-level members (declared directly in the file, not in a class):'
        : `Type: ${type.name} (${type.visibility ?? 'visibility not recorded'})`,
    );
    if (!isModule || (type.fields ?? []).length > 0) {
      lines.push(`Fields: ${(type.fields ?? []).length}`);
    }
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
  const inventory = context.functions ? buildNarratorEvidence({ functions: context.functions }) : '';
  if (inventory && !inventory.startsWith('No function inventory')) {
    lines.push('', 'Function metrics, signals, and same-file calls:', inventory);
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

/**
 * The instruction for narrating one change set from its recorded files, sizes, and impact.
 *
 * The reply is prose about what the change appears to do for the app, not a restatement of the
 * counts already on screen. Changed paths, their statuses, and the recorded dependents are
 * evidence, so the narrator may read meaning from them, but it must word that as a reading
 * ("appears to") and never claim behaviour the recorded evidence does not show.
 */
export const REVIEW_NARRATION_INSTRUCTION =
  'In three to six sentences of plain prose, explain this change set as a function of the app: ' +
  'what capability or behaviour it appears to add, change, or remove for a user of the app, ' +
  'not just which files and lines moved. Do not use lists, headings, or markdown, and do not ' +
  'repeat counts the reader can already see. The changed paths, their statuses, and the ' +
  'recorded dependents are evidence and may be read for meaning; word that as a reading ' +
  '("appears to"), not as fact. Use only the recorded evidence: never invent behaviour, and ' +
  'say so briefly when something is not recorded.';

/** One changed file as a recorded line, with a rename spelled out and missing counts named. */
function reviewFileLine(file) {
  const shown = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
  const counts =
    file.insertions === null || file.deletions === null
      ? 'line counts unavailable'
      : `+${file.insertions} −${file.deletions}`;
  return `- ${shown} (${file.status}, ${counts}, ${file.inGraph ? 'in graph' : 'outside the scanned graph'})`;
}

/**
 * Build the recorded evidence sent to the narrator for one Git review.
 *
 * Only recorded facts are included: the review kind and revision, the commit metadata, the
 * totals, each changed file's path, status, line counts, and graph membership, the recorded
 * impact distances, and the change metrics and cohesion when the caller computed them. Long
 * lists are bounded with a stated remainder, and unrecorded values are named as such rather
 * than guessed at.
 */
export function buildReviewNarrationEvidence(result) {
  const files = Array.isArray(result?.files) ? result.files : [];
  const lines = [];
  const kind =
    result?.kind === 'branch'
      ? 'Branch review'
      : result?.kind === 'working-tree'
        ? 'Working-tree review'
        : 'Commit review';
  lines.push(kind);
  if (result?.commit) {
    lines.push(
      `Commit: ${result.commit.subject} (${result.commit.shortHash} by ${result.commit.author}, ${String(result.commit.date ?? '').slice(0, 10)})`,
    );
  }
  if (result?.ref) {
    lines.push(`Revision: ${result.ref}`);
  }
  if (result?.branch) {
    lines.push(
      `Branch "${result.branch.branch}" is ${result.branch.ahead} commit(s) ahead of and ` +
        `${result.branch.behind} behind ${result.branch.base}`,
    );
    if (result.branch.conflicts?.available === true) {
      lines.push(
        result.branch.conflicts.clean
          ? `A trial merge with ${result.branch.base} is clean`
          : `A trial merge with ${result.branch.base} conflicts in ${result.branch.conflicts.paths.length} file(s)`,
      );
    }
  }

  const totals = result?.totals;
  if (totals) {
    const uncounted = totals.uncounted > 0 ? `, ${totals.uncounted} uncounted` : '';
    lines.push(
      `Changed: ${totals.files} file(s), +${totals.insertions} −${totals.deletions} lines${uncounted}`,
    );
  }

  lines.push(`Changed files (${files.length}):`);
  if (files.length === 0) {
    lines.push('- none recorded');
  }
  for (const file of files.slice(0, 50)) {
    lines.push(reviewFileLine(file));
  }
  if (files.length > 50) {
    lines.push(`- … and ${files.length - 50} more.`);
  }

  const affected = (result?.impact?.affected ?? []).filter((entry) => entry.distance > 0);
  lines.push(`Recorded dependents the change can reach: ${affected.length}`);
  for (const entry of affected.slice(0, 20)) {
    lines.push(`- ${entry.id} (distance ${entry.distance})`);
  }
  if (affected.length > 20) {
    lines.push(`- … and ${affected.length - 20} more.`);
  }
  const outside = result?.impact?.outsideGraph ?? [];
  if (outside.length > 0) {
    lines.push(`Changed paths outside the scanned graph: ${outside.length}`);
  }

  const totalsMetrics = result?.metrics?.totals;
  if (totalsMetrics) {
    const complexity =
      totalsMetrics.measured > 0
        ? `complexity +${totalsMetrics.complexity.added} −${totalsMetrics.complexity.removed} ` +
          `(${totalsMetrics.complexity.before} → ${totalsMetrics.complexity.after})`
        : 'complexity not measured';
    lines.push(`Change metrics: ${complexity}; coupling +${totalsMetrics.coupling.added} −${totalsMetrics.coupling.removed} import(s)`);
  }

  const cohesionFiles = result?.cohesion?.files ?? [];
  if (cohesionFiles.length > 0) {
    const baseline = result.cohesion.baseline ? ` compared with ${result.cohesion.baseline}` : '';
    lines.push(`Cohesion from recorded member wiring${baseline}:`);
    for (const file of cohesionFiles.slice(0, 20)) {
      const before = file.before === null ? '—' : file.before;
      const after = file.after === null ? '—' : file.after;
      lines.push(`- ${file.path}: cohesion ${before} → ${after}${file.note ? ` (${file.note})` : ''}`);
    }
  }

  return lines.join('\n');
}

/**
 * The instruction for explaining one file's place in the reading route. The narrator reads the
 * recorded position and wiring; it never reorders the route or claims a fact it was not given.
 */
export const ROUTE_STEP_INSTRUCTION =
  'Explain in one short paragraph why this file sits where it does in the repository reading ' +
  'route, using only the recorded evidence. Name what reaches it and what it depends on only ' +
  'when that is recorded, and say plainly when a fact is not recorded.';

/**
 * Build the recorded evidence sent to the narrator for one reading-route step.
 *
 * Only the step's recorded facts and the route's own summary are included; an absent step is
 * stated as such rather than filled in, and no ordering claim is made beyond what was recorded.
 */
export function buildRouteStepEvidence(step, routeSummary) {
  if (!step) {
    return 'no route step is recorded';
  }
  const lines = [];
  lines.push(`file: ${step.file}`);
  lines.push(`unit: ${step.unit ?? 'not recorded'}`);
  lines.push(
    `reached: ${step.from ? `from ${step.from}` : 'this is a declared entry point'}`,
  );
  lines.push(`depth from its entry point: ${step.depth ?? 'not recorded'}`);
  lines.push(`recorded importers: ${step.fanIn ?? 0}`);
  lines.push(`tier: ${step.tier ?? 'not recorded'}`);
  if (routeSummary) {
    lines.push(
      `route: ${routeSummary.entryPoints ?? 0} entry point(s), ${routeSummary.routed ?? 0} routed, ` +
        `${routeSummary.unreached ?? 0} no entry point reaches, ${routeSummary.units ?? 0} unit(s)`,
    );
  }
  return lines.join('\n');
}

/**
 * Split a model reply into displayable blocks: paragraphs, and ordered or bulleted lists.
 *
 * Small models return light markdown even when told not to. Each block is a list of inline
 * runs, `{ text }` or `{ text, code: true }` (backticked) or `{ text, strong: true }`, so the
 * renderer builds text nodes and elements only and never parses the reply as HTML.
 */
export function narrativeBlocks(text) {
  const inline = (value) => {
    const runs = [];
    const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
    let last = 0;
    for (const match of value.matchAll(pattern)) {
      if (match.index > last) {
        runs.push({ text: value.slice(last, match.index) });
      }
      runs.push(match[1] !== undefined ? { text: match[1], code: true } : { text: match[2], strong: true });
      last = match.index + match[0].length;
    }
    if (last < value.length) {
      runs.push({ text: value.slice(last) });
    }
    return runs;
  };

  const blocks = [];
  let paragraph = [];
  let list = null;
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'p', runs: inline(paragraph.join(' ')) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push(list);
      list = null;
    }
  };

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    const item = /^(?:(\d+)[.)]|[-*•])\s+(.*)$/.exec(line);
    if (line === '') {
      flushParagraph();
      flushList();
    } else if (item) {
      flushParagraph();
      const type = item[1] !== undefined ? 'ol' : 'ul';
      if (list && list.type !== type) {
        flushList();
      }
      list = list ?? { type, items: [] };
      list.items.push(inline(item[2]));
    } else {
      flushList();
      paragraph.push(line.replace(/^#{1,6}\s+/, ''));
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

/**
 * Whether the right-click Narrate item is usable, and the tooltip explaining why not.
 *
 * It is offered on the same footing as the Narrate button: inactive, with the reason, while
 * the narrator is off or failing, rather than clickable and failing.
 */
export function narratorMenuState(status) {
  const reason = narratorDisabledReason(status);
  return reason ? { enabled: false, hint: reason } : { enabled: true, hint: null };
}
