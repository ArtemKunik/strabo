/**
 * Pure helpers for the Change impact passport card.
 *
 * The card renders the same facts the server computed; nothing here derives a new number.
 * A missing measure is a dash with a reason, never a zero.
 */

const BAND_LABELS = {
  low: 'LOW',
  moderate: 'MODERATE',
  high: 'HIGH',
  critical: 'CRITICAL',
};

/** The uppercase band name for a risk band. */
export function riskBandLabel(band) {
  return BAND_LABELS[band] ?? String(band ?? '').toUpperCase();
}

/** The status tone for a risk band, mapped to the shared status scale. */
export function riskTone(band) {
  if (band === 'critical') return 'critical';
  if (band === 'high') return 'serious';
  if (band === 'moderate') return 'warning';
  return 'good';
}

/** `C35`, or a dash when nothing was measured. */
export function complexityValue(value) {
  return value === null || value === undefined ? '—' : `C${value}`;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * A before → after move: `grown +C3`, `shed −C2`, `unchanged`, `new`, `removed`, or a
 * named reason when neither side was measured.
 */
export function moveText(before, after, format = (value) => String(value)) {
  if ((before === null || before === undefined) && (after === null || after === undefined)) {
    return { tone: 'none', text: 'not measured' };
  }
  if (before === null || before === undefined) {
    return { tone: 'grown', text: `new · ${format(after)}` };
  }
  if (after === null || after === undefined) {
    return { tone: 'shed', text: `removed · ${format(before)}` };
  }
  const delta = round2(after - before);
  if (delta === 0) return { tone: 'flat', text: 'unchanged' };
  if (delta > 0) return { tone: 'grown', text: `grown +${format(delta)}` };
  return { tone: 'shed', text: `shed −${format(-delta)}` };
}

/**
 * How a current-graph figure is labelled: a cell read from a graph older than the working
 * tree says so, and where a revision's own graph is unavailable the reading is named an
 * approximation. `approximate` is the caller's knowledge that no per-revision graph was
 * built; `provenance` carries the served graph's own freshness.
 */
function graphDetail(provenance, approximate = false) {
  const stale = provenance?.stale === true;
  if (approximate) {
    return {
      detail: stale ? 'approximation: current graph · stale' : 'approximation: current graph',
      stale,
    };
  }
  return { detail: stale ? 'current graph · stale' : 'current graph', stale };
}

function riskCell(risk, provenance) {
  if (!risk) {
    return { key: 'risk', label: 'Risk', value: '—', detail: 'not measurable', tone: 'none' };
  }
  return {
    key: 'risk',
    label: 'Risk',
    value: `${riskBandLabel(risk.band)} ${risk.score}/100`,
    detail: graphDetail(provenance).detail,
    tone: riskTone(risk.band),
  };
}

/** The grid cells for one file's passport. */
export function filePassportCells(card) {
  const complexity = card?.complexity ?? {};
  const snapshot = card?.snapshot ?? {};
  const provenance = card?.provenance;
  const cells = [riskCell(card?.risk, provenance)];

  const maxMove = moveText(complexity.maxBefore, complexity.maxAfter, (value) => `C${value}`);
  cells.push({
    key: 'max-complexity',
    label: 'Max complexity',
    value: complexityValue(complexity.maxAfter ?? complexity.maxBefore),
    detail: maxMove.text,
    tone: maxMove.tone,
  });

  const coherence = card?.coherence;
  cells.push({
    key: 'coherence',
    label: 'Change coherence',
    value: coherence ? `${coherence.score}/100` : '—',
    detail: coherence ? coherence.detail : card?.status === 'added' ? 'new file' : 'no changed symbols',
    tone: coherence ? (coherence.score >= 67 ? 'flat' : 'grown') : 'none',
  });

  const blastGraph = graphDetail(provenance, card?.graphApproximation === true);
  cells.push({
    key: 'blast',
    label: 'Blast radius',
    value: String(snapshot.blastRadius ?? 0),
    detail: blastGraph.detail,
    tone: 'none',
  });

  // "Direct importers" and "Direct imports" are two directions of one relationship, so they
  // stay separate rows: one count can never stand in for the other.
  cells.push({
    key: 'importers',
    label: 'Direct importers',
    value: String(snapshot.directImporters ?? 0),
    detail: 'files',
    tone: 'none',
  });
  cells.push({
    key: 'imports',
    label: 'Direct imports',
    value: String(snapshot.directImports ?? 0),
    detail: 'files',
    tone: 'none',
  });

  const symbolReferences = symbolReferenceCell(card?.symbolReferences);
  if (symbolReferences) {
    cells.push(symbolReferences);
  }

  const averageMove = moveText(complexity.averageBefore, complexity.averageAfter, (value) => String(round2(value)));
  cells.push({
    key: 'average-complexity',
    label: 'Average complexity',
    value: complexity.averageAfter === null || complexity.averageAfter === undefined ? '—' : String(complexity.averageAfter),
    detail: `${averageMove.text} · ${complexity.functionsUnchanged ?? 0} function(s) unchanged · ${complexity.classesUnchanged ?? 0} class(es) unchanged`,
    tone: averageMove.tone,
  });

  return cells;
}

/** The grid cells for the change-set or revision roll-up. */
export function totalsPassportCells(totals) {
  const provenance = totals?.provenance;
  const approximate = totals?.graphApproximation === true;
  const cells = [riskCell(totals?.risk, provenance)];
  cells.push({
    key: 'max-complexity',
    label: 'Max complexity',
    value: complexityValue(totals?.maxComplexity),
    detail: `${totals?.files ?? 0} file(s)`,
    tone: 'none',
  });
  cells.push({
    key: 'coherence',
    label: 'Change coherence',
    value: totals?.coherence === null || totals?.coherence === undefined ? '—' : `${totals.coherence}/100`,
    detail: `${totals?.changedSymbols ?? 0} changed symbol(s)`,
    tone: totals?.coherence === null || totals?.coherence === undefined ? 'none' : 'flat',
  });
  cells.push({
    key: 'blast',
    label: 'Blast radius',
    value: String(totals?.blastRadius ?? 0),
    detail: graphDetail(provenance, approximate).detail,
    tone: 'none',
  });
  cells.push({
    key: 'importers',
    label: 'Direct importers',
    value: String(totals?.directImporters ?? 0),
    detail: 'files',
    tone: 'none',
  });
  cells.push({
    key: 'imports',
    label: 'Direct imports',
    value: String(totals?.directImports ?? 0),
    detail: 'files',
    tone: 'none',
  });
  const symbolReferences = symbolReferenceCell(totals?.symbolReferences);
  if (symbolReferences) {
    cells.push(symbolReferences);
  }
  cells.push({
    key: 'average-complexity',
    label: 'Average complexity',
    value: totals?.averageComplexity === null || totals?.averageComplexity === undefined ? '—' : String(totals.averageComplexity),
    detail: `${totals?.functionsUnchanged ?? 0} function(s) unchanged · ${totals?.classesUnchanged ?? 0} class(es) unchanged`,
    tone: 'none',
  });
  return cells;
}

/**
 * The symbol-references row: "N references to M files", or null when the passport recorded
 * no per-symbol reference count. Never invented — a caller without the measure gets no row.
 */
function symbolReferenceCell(references) {
  const total = references?.total;
  const files = references?.files;
  if (typeof total !== 'number') {
    return null;
  }
  return {
    key: 'symbol-references',
    label: 'Symbol references',
    value: `${total} reference${total === 1 ? '' : 's'} to ${typeof files === 'number' ? files : 0} file${files === 1 ? '' : 's'}`,
    detail: 'recorded',
    tone: 'none',
  };
}

/**
 * One contributing change-risk signal as a row: the label, its value, its threshold, and its
 * weighted contribution — so a score can never be read without the components it summed.
 */
export function riskSignalEntries(signals) {
  return (signals ?? []).map((signal) => ({
    kind: signal.kind,
    label: signal.label,
    value: signal.value,
    threshold: signal.threshold,
    contribution: signal.contribution,
    detail: `value ${signal.value} / threshold ${signal.threshold} · contribution ${signal.contribution}`,
  }));
}

/**
 * The line naming the additive score and the components it summed. `weights` is the server's
 * weight per signal kind when it was carried; otherwise the components are named without them.
 */
export function riskScoreText(risk) {
  if (!risk) {
    return null;
  }
  const components = (risk.signals ?? [])
    .map((signal) => `${signal.label.toLowerCase()} ${signal.value}/${signal.threshold}`)
    .join(' + ');
  const suffix = components ? ` = ${components}` : '';
  return `Risk ${risk.score}/100${suffix}`;
}

/** `owner.name`, or the bare name for a module function. */
export function impactFunctionLabel(fn) {
  return fn?.owner ? `${fn.owner}.${fn.name}` : String(fn?.name ?? '');
}

/** The heading for a passport scope. */
export function passportHeading(scope) {
  if (scope === 'file') return 'Change impact passport';
  if (scope === 'revision') return 'Revision impact passport';
  return 'Change impact passport';
}

/** A one-line reading of the whole card, for a status bar or a summary. */
export function impactPassportSummary(set) {
  if (!set || !set.totals) return 'Impact passport unavailable.';
  const risk = set.totals.risk ? `${riskBandLabel(set.totals.risk.band)} risk ${set.totals.risk.score}/100` : 'risk not measurable';
  const scope = set.scope === 'revision' ? 'revision' : set.scope === 'file' ? 'file' : 'change set';
  return `${scope}: ${set.totals.files} file(s) · ${risk} · blast radius ${set.totals.blastRadius}`;
}
