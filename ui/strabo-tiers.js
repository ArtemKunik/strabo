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
