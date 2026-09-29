/**
 * Glyphs for the Structure view's tier cards.
 *
 * Each role tier draws a small outline icon naming what the tier does (a screen for the
 * frontend, a plug for the API surface, a cylinder for data...), so a card reads at a
 * glance before its label does. The paths are Lucide icons (ISC licence), drawn on a
 * 24-unit grid with a round 2-unit stroke.
 *
 * Pure: the stylesheet passes the resolved tier colour in, and gets a data URI back.
 */

const TIER_GLYPHS = {
  // monitor
  frontend: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  // plug
  api: '<path d="M12 22v-5M9 8V2M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  // box: the core model
  domain:
    '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
  // database
  data: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  // arrow-left-right: traffic with the outside world
  integration: '<path d="M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4"/>',
  // server
  infra: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
  // wrench
  build:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  // flask-conical
  tests:
    '<path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2M8.5 2h7M7 16h10"/>',
  // circle-help
  unclassified: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>',
};

/** The glyph for a tier as an SVG data URI stroked in `color`; unknown tiers get the `?`. */
export function tierIconUri(tier, color) {
  const glyph = TIER_GLYPHS[tier] ?? TIER_GLYPHS.unclassified;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24" fill="none" ` +
    `stroke="${color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
