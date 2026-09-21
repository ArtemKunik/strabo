/**
 * Review, risk, and analysis-overlay logic: how a review result, a change passport, a
 * risk report, and the impact / cycles / test-reach / architecture overlays become node
 * classes and panel text. Overlays annotate nodes the server already reported and never
 * invent edges or facts.
 *
 * Pure functions only: no DOM, no Cytoscape, no fetch.
 */

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
  const order = ['commit', 'staged', 'unstaged', 'untracked'];
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
    default:
      return { classes: new Map(), summary: '', items: [] };
  }
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
    summary: `${hotspots.length} hotspot(s) · ${report?.filesScanned ?? 0} file(s) scanned${skippedNote}`,
    items: hotspots.map((spot) => {
      const where = spot.owner ? `${spot.owner}.${spot.name}` : spot.name;
      const kinds = (spot.signals ?? []).map((signal) => signal.kind).join(', ');
      return `${spot.file} · ${where} (L${spot.line}) · ${kinds}`;
    }),
  };
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
  return {
    classes,
    summary: `${changed} changed · ${affected} affected`,
    items: (data?.affected ?? [])
      .slice(0, 50)
      .map((entry) => `${entry.id} · distance ${entry.distance}`),
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
    items: axes.map((axis) =>
      axis.value === null
        ? `${axis.label}: unavailable (${axis.detail})`
        : `${axis.label}: ${axis.value}/100 (${axis.detail})`,
    ),
  };
}
