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

function riskCell(risk) {
  if (!risk) {
    return { key: 'risk', label: 'Risk', value: '—', detail: 'not measurable', tone: 'none' };
  }
  return {
    key: 'risk',
    label: 'Risk',
    value: `${riskBandLabel(risk.band)} ${risk.score}/100`,
    detail: 'current snapshot',
    tone: riskTone(risk.band),
  };
}

/** The grid cells for one file's passport. */
export function filePassportCells(card) {
  const complexity = card?.complexity ?? {};
  const snapshot = card?.snapshot ?? {};
  const cells = [riskCell(card?.risk)];

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

  cells.push({
    key: 'blast',
    label: 'Blast radius',
    value: String(snapshot.blastRadius ?? 0),
    detail: 'current graph',
    tone: 'none',
  });

  cells.push({
    key: 'imports',
    label: 'Importers / imports',
    value: `${snapshot.directImporters ?? 0} / ${snapshot.directImports ?? 0}`,
    detail: 'current graph',
    tone: 'none',
  });

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
  const cells = [riskCell(totals?.risk)];
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
    detail: 'current graph',
    tone: 'none',
  });
  cells.push({
    key: 'imports',
    label: 'Importers / imports',
    value: `${totals?.directImporters ?? 0} / ${totals?.directImports ?? 0}`,
    detail: 'current graph',
    tone: 'none',
  });
  cells.push({
    key: 'average-complexity',
    label: 'Average complexity',
    value: totals?.averageComplexity === null || totals?.averageComplexity === undefined ? '—' : String(totals.averageComplexity),
    detail: `${totals?.functionsUnchanged ?? 0} function(s) unchanged · ${totals?.classesUnchanged ?? 0} class(es) unchanged`,
    tone: 'none',
  });
  return cells;
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
