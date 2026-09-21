/**
 * The class names the graph carries on its elements.
 *
 * Shared by the stylesheet (which styles them) and the overlay/render code (which applies
 * and clears them). Kept in its own module so neither of those has to import the other.
 */

import { TIER_ORDER } from './strabo-core.js';

/** Classes an analysis overlay can put on a node. */
export const OVERLAY_CLASSES = ['ov-changed', 'ov-affected', 'ov-cycle', 'ov-unreached', 'ov-hotspot', 'ov-wide-interface', 'ov-pass-through', 'ov-sole-owner', 'ov-cross-repo', 'ov-smell'];

/**
 * Classes the graph applies after building elements. An incremental render reuses existing
 * elements, so it clears these first to match the "fresh elements" the old rebuild produced.
 */
export const RESET_CLASSES = [
  ...OVERLAY_CLASSES,
  ...TIER_ORDER.map((tier) => `tier-${tier}`),
  'hover',
  'edge-selected',
  'dimmed',
  'edge-faded',
  'edge-kind-hidden',
  'edge-cochange-hidden',
  'edge-lod-hidden',
  'label-hidden',
  'filtered-out',
  'tier-hidden',
  'tier-upward',
  'tier-skip',
  'edge-tier-upward',
  'edge-tier-skip',
];
