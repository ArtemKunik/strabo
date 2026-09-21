/**
 * The theme tokens the canvas reads from CSS.
 *
 * `styles.css` is the single definition of every colour (Phase 13 M1a R10/R11): the canvas
 * resolves the tokens at load rather than carrying a second palette in JavaScript, so the
 * two can never drift.
 */

import { TIER_ORDER } from './strabo-core.js';

/**
 * Read one CSS custom property from the document root.
 *
 * A missing token yields an empty string, which is a bug in the token set, not a value to
 * paper over with a fallback.
 */
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Canvas colours, read from the CSS custom properties so the graph follows the active theme. */
export function graphTheme() {
  return {
    ink: cssVar('--graph-ink'),
    inkOutline: cssVar('--graph-ink-outline'),
    nodeFill: cssVar('--node-fill'),
    nodeLine: cssVar('--node-line'),
    edge: cssVar('--graph-edge'),
    edgeAccent: cssVar('--graph-edge-accent'),
    edgeSelected: cssVar('--graph-edge-selected'),
    hub: cssVar('--graph-hub'),
    selected: cssVar('--graph-selected'),
    changed: cssVar('--graph-changed'),
    affected: cssVar('--graph-affected'),
    cycle: cssVar('--graph-cycle'),
    unreached: cssVar('--graph-unreached'),
    tier: Object.fromEntries(
      TIER_ORDER.filter((tier) => tier !== 'unclassified').map((tier) => [tier, cssVar(`--tier-${tier}`)]),
    ),
    tierUnclassified: cssVar('--series-other'),
  };
}
