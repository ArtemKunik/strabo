/**
 * Review, risk, and analysis-overlay logic: how a review result, a change passport, a
 * risk report, and the impact / cycles / test-reach / architecture overlays become node
 * classes and panel text. Overlays annotate nodes the server already reported and never
 * invent edges or facts.
 *
 * Pure functions only: no DOM, no Cytoscape, no fetch.
 */

import { coverageAge, coverageLabel } from './strabo-functions.js';

/** The heading each analysis overlay shows in its panel. */
export const OVERLAY_TITLES = {
  impact: 'Change impact',
  cycles: 'Cycles',
  'test-reach': 'Test reach',
  architecture: 'Architecture health',
  hotspots: 'Function hotspots',
  'module-depth': 'Module depth',
  ownership: 'Ownership',
  smells: 'Smells',
  'hidden-coupling': 'Hidden coupling (co-change, no import path)',
  'declared-rules': 'Declared rules',
};

/** The analysis endpoint each overlay reads. */
export const OVERLAY_ENDPOINTS = {
  impact: '/analysis/impact',
  cycles: '/analysis/cycles',
  'test-reach': '/analysis/test-reach',
  architecture: '/analysis/architecture-health',
  hotspots: '/analysis/functions',
  'module-depth': '/analysis/module-depth',
  ownership: '/analysis/ownership',
  smells: '/analysis/smells',
  'hidden-coupling': '/analysis/co-change',
  'declared-rules': '/analysis/rules',
};

/** Overlays that annotate file nodes and therefore need Files mode. */
export const FILE_MODE_OVERLAYS = ['impact', 'cycles', 'test-reach', 'module-depth', 'ownership', 'smells', 'hidden-coupling', 'declared-rules'];

/**
 * Map a review analysis result onto node classes and a panel summary.
 *
 * A review result is the same shape as change impact — `files` with a status, plus
 * `impact.affected` — so it reuses the change/affected classes rather than inventing
 * a parallel vocabulary. Returns `{ classes, summary, items }`.
 */
export function reviewOverlay(data) {
  if (!data || data.available === false) {
    return { classes: new Map(), summary: '', items: [] };
  }
  const classes = new Map();
  for (const file of data.files ?? []) {
    if (file.inGraph) {
      classes.set(file.path, 'ov-changed');
    }
  }
  for (const entry of data.impact?.affected ?? []) {
    if (!classes.has(entry.id) && entry.distance > 0) {
      classes.set(entry.id, 'ov-affected');
    }
  }
  const totals = data.totals ?? { files: 0, insertions: 0, deletions: 0 };
  const affected = (data.impact?.affected ?? []).filter((entry) => entry.distance > 0).length;
  return {
    classes,
    summary: `${totals.files} file(s) · +${totals.insertions} −${totals.deletions} · ${affected} affected`,
    items: (data.files ?? []).map((file) => reviewFileLabel(file)),
  };
}

/** Human label for one reviewed file, including rename and binary/unreadable cases. */
export function reviewFileLabel(file) {
  const rename = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
  const counts =
    file.insertions === null || file.deletions === null
      ? 'line counts unavailable'
      : `+${file.insertions} −${file.deletions}`;
  return `${file.status} · ${rename} · ${counts}`;
}

/** Count reviewed files by group so the panel can label staged vs unstaged vs untracked. */
export function reviewGroups(files) {
  const order = ['commit', 'branch', 'staged', 'unstaged', 'untracked'];
  const groups = new Map(order.map((name) => [name, []]));
  for (const file of files ?? []) {
    const list = groups.get(file.group) ?? groups.get('unstaged');
    list.push(file);
  }
  return [...groups.entries()].filter(([, list]) => list.length > 0);
}

/**
 * The Change passport line for one file: cohesion before -> after with its direction.
 *
 * A missing side is named (new, removed, unavailable) rather than shown as a zero, because
 * cohesion is measured from recorded member wiring and an absent measurement is not a score.
 */
export function cohesionDelta(change) {
  const before = change?.before ?? null;
  const after = change?.after ?? null;
  if (before === null && after === null) {
    return { tone: 'none', text: `cohesion unavailable — ${change?.note ?? 'not recorded'}` };
  }
  if (before === null) {
    return { tone: 'new', text: `new · cohesion ${after}` };
  }
  if (after === null) {
    return { tone: 'removed', text: `removed · cohesion ${before}` };
  }
  const delta = after - before;
  const tone = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const marker = delta > 0 ? `+${delta}` : `${delta}`;
  return { tone, text: `cohesion ${before} → ${after} (${marker})` };
}

const SEVERITY_ORDER = ['unknown', 'low', 'moderate', 'high', 'critical'];

/**
 * Order advisories worst-first.
 *
 * Severity is the advisory's own recorded label; Strabo does not compute or downgrade it.
 * The id breaks ties so the ordering is stable between renders.
 */
export function orderAdvisories(advisories) {
  return [...(advisories ?? [])].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity) ||
      String(a.id).localeCompare(String(b.id)),
  );
}

/** One line summarising a risk report for the status bar. */
export function riskSummary(report) {
  if (!report || report.available === false) {
    return 'Risk unavailable';
  }
  const { summary, inventory } = report;
  const severity = ['critical', 'high', 'moderate', 'low']
    .map((level) => `${summary[level]} ${level}`)
    .join(' · ');
  const denied = summary.deniedLicenses > 0 ? ` · ${summary.deniedLicenses} denied license(s)` : '';
  const offline = report.online ? '' : ' · online lookup off';
  return `${inventory.total} dependencies · ${severity}${denied}${offline}`;
}

/**
 * Map a review analysis result onto node classes and a panel summary.
 *
 * Overlays never invent edges or facts; they only annotate nodes the server already
 * reported. Returns `{ classes, summary, items }`.
 */
export function overlayFor(kind, data) {
  switch (kind) {
    case 'impact':
      return impactOverlay(data);
    case 'cycles':
      return cyclesOverlay(data);
    case 'test-reach':
      return testReachOverlay(data);
    case 'architecture':
      return architectureOverlay(data);
    case 'hotspots':
      return hotspotsOverlay(data);
    case 'module-depth':
      return moduleDepthOverlay(data);
    case 'ownership':
      return ownershipOverlay(data);
    case 'smells':
      return smellsOverlay(data);
    case 'hidden-coupling':
      return hiddenCouplingOverlay(data);
    case 'declared-rules':
      return declaredRulesOverlay(data);
    default:
      return { classes: new Map(), summary: '', items: [] };
  }
}

/**
 * The declared-rules lens: the operator's rules and the observed edges that break them.
 *
 * Only the recorded violations are annotated, and each row names the rule and edge kind it
 * came from, so the overlay points at evidence rather than standing as a verdict. A report
 * with no declared rules is unavailable and annotates nothing.
 */
export function declaredRulesOverlay(report) {
  if (!report || report.available === false) {
    return { classes: new Map(), summary: '', items: [] };
  }
  const rules = report.rules ?? [];
  if (rules.length === 0) {
    return { classes: new Map(), summary: 'No rules are declared.', items: [] };
  }
  const violations = report.violations ?? [];
  const classes = new Map();
  for (const violation of violations) {
    classes.set(violation.edge.source, 'ov-declared-rule');
  }
  return {
    classes,
    summary: `${rules.length} rule(s) · ${violations.length} violation(s)`,
    items: violations.map((violation) => ({
      id: violation.edge.source,
      label: `${violation.edge.source} → ${violation.edge.target}`,
      detail: `${violation.rule}: ${violation.edge.kind}`,
    })),
  };
}

/**
 * The hidden-coupling lens: co-change pairs joined by no import path in either direction
 * (K3). This is the only overlay that annotates *edges*, so it returns the hidden edges for
 * the view to draw distinctly as well as the node classes and panel text.
 *
 * A pair with no listable commit is not drawn, and a non-hidden edge is left out entirely,
 * so the lens never shows a coupling the history or the graph did not record.
 */
export function hiddenCouplingOverlay(report) {
  if (!report || report.unavailable === true) {
    return {
      classes: new Map(),
      edges: [],
      summary: 'no Git history read',
      items: [],
      emptyNote: report?.detail ?? 'Co-change is unavailable: no Git history was read.',
    };
  }
  const edges = (report.edges ?? []).filter(
    (edge) => edge.hidden === true && Array.isArray(edge.commits) && edge.commits.length > 0,
  );
  const classes = new Map();
  for (const edge of edges) {
    classes.set(edge.source, 'ov-hidden-coupling');
    classes.set(edge.target, 'ov-hidden-coupling');
  }
  return {
    classes,
    edges,
    summary: `${edges.length} hidden co-change pair(s) · no import path either way`,
    items: edges.map(
      (edge) =>
        `${edge.source} ↔ ${edge.target} · ${edge.commitsShared ?? edge.commits.length} shared commit(s) · ratio ${edge.ratio}`,
    ),
  };
}

/**
 * Surface modules whose interface is wide relative to their implementation.
 *
 * The endpoint returns one record per scanned file; a file with no signal (`ok`) is not
 * annotated, so the map shows only the pass-throughs and wide interfaces the server
 * flagged. Nothing is inferred from the record; its own recorded counts are the label.
 */
export function moduleDepthOverlay(signals) {
  const list = Array.isArray(signals) ? signals : [];
  const flagged = list.filter((entry) => entry.signal && entry.signal !== 'ok');
  const classes = new Map();
  for (const entry of flagged) {
    classes.set(entry.file, entry.signal === 'pass-through' ? 'ov-pass-through' : 'ov-wide-interface');
  }
  const passThrough = flagged.filter((entry) => entry.signal === 'pass-through').length;
  return {
    classes,
    summary: `${flagged.length} flagged · ${passThrough} pass-through · ${list.length} file(s)`,
    items: flagged.map(
      (entry) =>
        `${entry.file} · ${entry.signal} · ${entry.implementationLines} impl line(s) · interface width ${entry.interfaceWidth}`,
    ),
  };
}

/**
 * Surface files whose recorded history and dependency reach sit at one author.
 *
 * A single recorded author with dependents is a bus-factor signal, not a verdict: the
 * panel states the recorded author count, commit count, and dependent count it came from.
 */
export function ownershipOverlay(contexts) {
  const list = Array.isArray(contexts) ? contexts : [];
  const classes = new Map();
  let sole = 0;
  for (const entry of list) {
    if (entry.distinctAuthors === 1 && entry.transitiveDependents > 0) {
      classes.set(entry.file, 'ov-sole-owner');
      sole += 1;
    }
  }
  return {
    classes,
    summary: `${sole} single-author module(s) with dependents · ${list.length} file(s) with history`,
    items: list
      .slice(0, 200)
      .map(
        (entry) =>
          `${entry.file} · ${entry.distinctAuthors} author(s) · ${entry.commits} commit(s) · ${entry.transitiveDependents} dependent(s)`,
      ),
  };
}

/**
 * Map the repository smells report onto the files that carry a smell.
 *
 * A smell is a signal, not a verdict: the panel names the rules and the inputs that tripped
 * them, so the overlay points at evidence rather than standing as a judgement.
 */
export function smellsOverlay(report) {
  const files = Array.isArray(report?.files) ? report.files : [];
  const classes = new Map();
  for (const entry of files) {
    classes.set(entry.file, 'ov-smell');
  }
  const counts = Object.entries(report?.summary ?? {})
    .filter(([, count]) => Number(count) > 0)
    .map(([rule, count]) => `${count} ${rule}`)
    .join(' · ');
  return {
    classes,
    summary: `${files.length} file(s) with a smell${counts ? ` · ${counts}` : ''}`,
    items: files
      .slice(0, 200)
      .map((entry) => `${entry.file} · ${(entry.smells ?? []).map((smell) => smell.rule).join(', ')}`),
  };
}

/**
 * Map the repository hotspot report onto the files that carry a hotspot.
 *
 * Only functions with a recorded signal become hotspots; the panel names each one and the
 * signals it tripped, so the overlay points at evidence rather than a score.
 */
function hotspotsOverlay(report) {
  const hotspots = report?.hotspots ?? [];
  const classes = new Map();
  for (const spot of hotspots) {
    if (!classes.has(spot.file)) {
      classes.set(spot.file, 'ov-hotspot');
    }
  }
  const skipped = report?.filesSkipped ?? 0;
  const skippedNote = skipped > 0 ? ` · ${skipped} skipped` : '';
  return {
    classes,
    summary:
      `${hotspots.length} hotspot(s) · ${report?.filesScanned ?? 0} file(s) scanned${skippedNote}` +
      coverageSummary(report?.coverage),
    items: hotspots.map((spot) => {
      const where = spot.owner ? `${spot.owner}.${spot.name}` : spot.name;
      const kinds = (spot.signals ?? []).map((signal) => signal.kind).join(', ');
      return `${spot.file} · ${where} (L${spot.line}) · ${kinds} · coverage ${coverageLabel(spot.coverage)}`;
    }),
  };
}

/** The measured-coverage provenance for a hotspots summary, or that it is unavailable. */
function coverageSummary(coverage) {
  if (!coverage) {
    return '';
  }
  if (!coverage.available) {
    return ` · coverage unavailable (${coverage.reason ?? 'no report'})`;
  }
  const age =
    coverage.reportAgeMs === null || coverage.reportAgeMs === undefined
      ? ''
      : ` (report ${coverageAge(coverage.reportAgeMs)} old)`;
  const stale = coverage.stale?.length ? `, ${coverage.stale.length} stale` : '';
  return ` · coverage measured${age}${stale}`;
}

function impactOverlay(data) {
  const classes = new Map();
  for (const change of data?.changed ?? []) {
    classes.set(change.path, 'ov-changed');
  }
  for (const entry of data?.affected ?? []) {
    if (!classes.has(entry.id) && entry.distance > 0) {
      classes.set(entry.id, 'ov-affected');
    }
  }
  const changed = (data?.changed ?? []).length;
  const affected = (data?.affected ?? []).filter((entry) => entry.distance > 0).length;
  const listed = (data?.affected ?? []).slice(0, 50);
  const itemFor = (entry) => `${entry.id} · distance ${entry.distance}`;
  return {
    classes,
    summary: `${changed} changed · ${affected} affected`,
    items: listed.map(itemFor),
    // The panel can hide the dependents: `changed` is the file itself (distance 0),
    // `affected` the dependents it can reach (distance > 0), which read as the negative side.
    changedItems: new Set(listed.filter((entry) => entry.distance === 0).map(itemFor)),
    affectedItems: new Set(listed.filter((entry) => entry.distance > 0).map(itemFor)),
  };
}

function cyclesOverlay(groups) {
  const classes = new Map();
  for (const group of groups ?? []) {
    for (const member of group.members ?? []) {
      classes.set(member, 'ov-cycle');
    }
  }
  return {
    classes,
    summary: `${(groups ?? []).length} cycle(s)`,
    items: (groups ?? []).map((group) => (group.members ?? []).join(' ↔ ')),
  };
}

function testReachOverlay(data) {
  const unreached = data?.unreachedWithDependents ?? [];
  const testFiles = data?.testFiles ?? [];
  const reached = data?.reached ?? [];
  const classes = new Map();
  for (const id of unreached) {
    classes.set(id, 'ov-unreached');
  }
  if (testFiles.length === 0) {
    return {
      classes,
      summary: 'no test files identified',
      items: [],
      meta: { testFiles: 0, reached: reached.length, unreached: unreached.length },
      emptyNote: 'No test files matched the scan heuristics, so reachability cannot be derived.',
    };
  }
  if (unreached.length === 0) {
    return {
      classes,
      summary: `all used modules reached · ${reached.length} reached · ${testFiles.length} test files`,
      items: [],
      meta: { testFiles: testFiles.length, reached: reached.length, unreached: 0 },
      emptyNote: 'Every module with dependents is reachable from a test.',
    };
  }
  return {
    classes,
    summary: `${unreached.length} unreached · ${reached.length} reached · ${testFiles.length} test files`,
    items: [...unreached],
    meta: { testFiles: testFiles.length, reached: reached.length, unreached: unreached.length },
  };
}

/** Architecture health is repository-level, so it annotates no nodes. */
function architectureOverlay(report) {
  const axes = report?.axes ?? [];
  return {
    classes: new Map(),
    summary: `score ${report?.score ?? 'n/a'}/100`,
    items: axes.map((axis) => {
      // A coverage figure says whether it is measured or the static reach.
      const basis = axis.basis ? ` [${axis.basis}]` : '';
      return axis.value === null
        ? `${axis.label}${basis}: unavailable (${axis.detail})`
        : `${axis.label}${basis}: ${axis.value}/100 (${axis.detail})`;
    }),
  };
}

/**
 * A signed delta with its reading. For complexity and coupling more is worse, so a rise is
 * `worse` and a fall `better`; an unmeasured side stays `none` rather than reading as zero.
 */
export function metricDelta(before, after, { moreIsWorse = true } = {}) {
  if (before === null || before === undefined || after === null || after === undefined) {
    return { tone: 'none', delta: null, text: '—' };
  }
  const delta = after - before;
  if (delta === 0) {
    return { tone: 'flat', delta, text: '±0' };
  }
  const rising = delta > 0;
  return {
    tone: rising === moreIsWorse ? 'worse' : 'better',
    delta,
    text: rising ? `+${delta}` : `−${-delta}`,
  };
}

/**
 * The one-line quantitative summary of a change set: complexity gained and shed across
 * functions, the net move, function and signal counts, and import edges added or removed.
 */
export function changeMetricSummary(totals) {
  if (!totals) {
    return 'Change metrics unavailable.';
  }
  const parts = [];
  if (totals.measured > 0) {
    const { before, after, added, removed } = totals.complexity;
    parts.push(`complexity +${added} −${removed} (${before} → ${after})`);
    if (totals.functions.before !== totals.functions.after) {
      parts.push(`functions ${totals.functions.before} → ${totals.functions.after}`);
    }
    const signals = metricDelta(totals.signals.before, totals.signals.after);
    if (signals.delta) {
      parts.push(`signals ${signals.text}`);
    }
  } else {
    parts.push('complexity not measured');
  }
  parts.push(`coupling +${totals.coupling.added} −${totals.coupling.removed} import(s)`);
  return parts.join(' · ');
}

/** The compact per-commit badge the timeline shows: net complexity and net coupling. */
export function commitMetricBadge(totals) {
  if (!totals) {
    return null;
  }
  const complexity = totals.measured > 0 ? metricDelta(totals.complexity.before, totals.complexity.after) : null;
  const couplingNet = totals.coupling.added - totals.coupling.removed;
  const coupling = metricDelta(0, couplingNet);
  const complexityText = complexity ? `cx ${complexity.text}` : 'cx —';
  return {
    text: `${complexityText} · cpl ${coupling.text}`,
    title: `${changeMetricSummary(totals)} · ${totals.files} file(s)`,
    tone: complexity?.tone === 'worse' || coupling.tone === 'worse' ? 'worse' : complexity?.tone === 'better' ? 'better' : 'flat',
  };
}

/**
 * Order changed files by how much they moved: complexity churn first, then import edges,
 * then fan-in, so the files that shifted structure most lead the list.
 */
export function orderMetricFiles(files) {
  const weight = (file) =>
    (file.complexityChange ? file.complexityChange.added + file.complexityChange.removed : 0) +
    (file.importsAdded?.length ?? 0) +
    (file.importsRemoved?.length ?? 0) +
    Math.abs(file.fanInDelta ?? 0);
  return [...(files ?? [])].sort((a, b) => weight(b) - weight(a) || a.path.localeCompare(b.path));
}
