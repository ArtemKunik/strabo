/**
 * Pure helpers for the tier lens on the file map.
 *
 * Tiers cut across build units and answer "what role does this code play". These helpers
 * turn a `/analysis/tiers` report into the file → tier map, the filter set, the legend rows,
 * and the CSS class/variable a node or chip uses. Colour is a variable reference only, never
 * a literal, so every hue is defined once in `styles.css` (Phase 13 R10).
 */

/** Dependency order: the upper layers first, `unclassified` last. */
export const TIER_ORDER = [
  'frontend',
  'api',
  'domain',
  'data',
  'integration',
  'infra',
  'build',
  'tests',
  'unclassified',
];

export const TIER_LABELS = {
  frontend: 'Frontend',
  api: 'API surface',
  domain: 'Domain/service',
  data: 'Data',
  integration: 'Integration',
  infra: 'Infra/config',
  build: 'Build/tooling',
  tests: 'Tests',
  unclassified: 'Unclassified',
};

/** The CSS class a node or chip takes for a tier. */
export function tierClass(tier) {
  return `tier-${TIER_ORDER.includes(tier) ? tier : 'unclassified'}`;
}

/** The CSS variable a tier draws with; `unclassified` is the neutral categorical token. */
export function tierColorVar(tier) {
  return tier === 'unclassified' ? 'var(--series-other)' : `var(--tier-${tier})`;
}

/** A file → tier map from a `/analysis/tiers` report. */
export function tierOfFile(report) {
  const map = new Map();
  for (const entry of report?.files ?? []) {
    map.set(entry.file, entry.tier);
  }
  return map;
}

/**
 * The node ids a tier filter keeps. `all` (or an unknown tier) keeps every id, so an empty
 * report never blanks the map.
 */
export function tierFilterIds(tierByFile, tier) {
  if (!tier || tier === 'all') {
    return new Set(tierByFile.keys());
  }
  return new Set([...tierByFile].filter(([, value]) => value === tier).map(([file]) => file));
}

/** Legend/filter rows with their label, count, and colour, largest tier first. */
export function tierSummaryRows(report) {
  const summary = report?.summary ?? {};
  return TIER_ORDER.filter((tier) => Number(summary[tier] ?? 0) > 0)
    .map((tier) => ({
      tier,
      label: TIER_LABELS[tier],
      count: Number(summary[tier] ?? 0),
      color: tierColorVar(tier),
    }))
    .sort((a, b) => b.count - a.count || TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
}

/**
 * Matrix rows for the tier × unit panel: one row per tier that has files, with a cell per
 * unit. Rows keep dependency order; empty rows and empty cells are kept so an absent tier
 * reads as information rather than disappearing.
 */
export function tierMatrixRows(report) {
  const matrix = report?.matrix;
  if (!matrix) {
    return [];
  }
  const units = matrix.units ?? [];
  return (matrix.tiers ?? [])
    .map((tier) => {
      const cells = units.map((unit) => {
        const cell = (matrix.cells ?? []).find((entry) => entry.unit === unit && entry.tier === tier);
        return { unit, files: cell?.files ?? 0, lines: cell?.lines ?? 0 };
      });
      return {
        tier,
        label: TIER_LABELS[tier],
        color: tierColorVar(tier),
        cells,
        files: cells.reduce((total, cell) => total + cell.files, 0),
        lines: cells.reduce((total, cell) => total + cell.lines, 0),
      };
    })
    .filter((row) => row.files > 0);
}

/** The per-tier shares, largest tier first, for the "Data: 12% of files" caption. */
export function tierPerTierRows(report) {
  return (report?.matrix?.perTier ?? [])
    .slice()
    .sort((a, b) => b.files - a.files || TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier))
    .map((entry) => ({
      tier: entry.tier,
      label: TIER_LABELS[entry.tier],
      color: tierColorVar(entry.tier),
      files: entry.files,
      lines: entry.lines,
      fileShare: entry.fileShare,
      shareLabel: `${Math.round((entry.fileShare ?? 0) * 100)}%`,
    }));
}

/** A one-line summary of the wrong-way edges, or an explicit all-clear. */
export function tierDirectionLabel(report) {
  const directions = report?.directions ?? [];
  if (directions.length === 0) {
    return 'No upward or skip-layer edges recorded.';
  }
  const upward = directions.filter((entry) => entry.kind === 'upward').length;
  const skip = directions.filter((entry) => entry.kind === 'skip-layer').length;
  return `${upward} upward · ${skip} skip-layer`;
}

/**
 * The classes the direction check puts on the map.
 *
 * Both endpoints of a wrong-way edge are marked (the source for making the call, the target
 * for taking it), and the edge itself is returned so the view can style it. `upward` and
 * `skip-layer` are different classes, so the two read apart by shape, not hue alone.
 */
export function tierDirectionClasses(report) {
  const byNode = new Map();
  const edges = [];
  for (const entry of report?.directions ?? []) {
    const nodeClass = entry.kind === 'upward' ? 'tier-upward' : 'tier-skip';
    byNode.set(entry.source, [...(byNode.get(entry.source) ?? []), nodeClass]);
    byNode.set(entry.target, [...(byNode.get(entry.target) ?? []), nodeClass]);
    edges.push({
      source: entry.source,
      target: entry.target,
      kind: entry.kind,
      line: entry.line,
    });
  }
  return { byNode, edges };
}

/** The tables a trace can start from, most-referenced first. */
export function tierTables(report) {
  const counts = new Map();
  for (const entry of report?.tables ?? []) {
    counts.set(entry.table, (counts.get(entry.table) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([table, count]) => ({ table, count }))
    .sort((a, b) => b.count - a.count || a.table.localeCompare(b.table));
}

/**
 * The files that reference a table, each with its tier and unit: the bottom half of the
 * end-to-end trace. `unavailable` is not invented here; a table with no recorded reference
 * returns an empty list.
 */
export function tierTableTrace(report, table) {
  return (report?.tableTrace ?? [])
    .filter((entry) => entry.table === table)
    .slice()
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** The outbound calls a trace can start from, one row per call site, file then line. */
export function tierCallSites(report) {
  return (report?.calls ?? [])
    .slice()
    .sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.target.localeCompare(b.target),
    );
}

/** Declared HTTP endpoints, one row per operation, with the tier and unit of the document. */
export function tierEndpointSites(report) {
  return (report?.endpoints ?? [])
    .slice()
    .sort(
      (a, b) =>
        a.file.localeCompare(b.file) || a.method.localeCompare(b.method) || a.path.localeCompare(b.path),
    );
}

/**
 * The top half of the end-to-end trace: each call site and the endpoint it reaches here, or
 * `null` when no document in this repository declares it (an outbound call to another repo).
 */
export function tierTraces(report) {
  return (report?.traces ?? []).slice();
}

/** The one-line caption for the tier filter, or an explicit no-evidence note. */
export function tierSummaryLabel(report) {
  const total = Number(report?.summary?.total ?? 0);
  if (total === 0) {
    return 'No files were classified into a tier.';
  }
  const unclassified = Number(report?.summary?.unclassified ?? 0);
  const mixed = Number(report?.summary?.mixed ?? 0);
  const parts = [`${total} file(s) classified`];
  if (mixed > 0) {
    parts.push(`${mixed} mixed`);
  }
  parts.push(`${unclassified} unclassified`);
  return parts.join(' · ');
}
