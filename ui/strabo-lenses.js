/**
 * The class-toggling lenses the map applies on top of a render.
 *
 * Each function clears its own classes and reapplies them, so lenses compose: the review
 * overlay, the cross-repo ring, the text filter, and the tier lens can be on screen at
 * once without clearing each other. These touch a live Cytoscape instance; the pure
 * overlay *data* logic lives in `strabo-overlays.js`.
 */

import { TIER_ORDER } from './strabo-core.js';
import { OVERLAY_CLASSES } from './strabo-graph-classes.js';
import { edgeLodHidden } from './strabo-perf.js';

/**
 * Dim everything outside `ids`; pass null to clear.
 *
 * An edge is only part of the focus when both ends are: an edge crossing out of the
 * neighbourhood is the boundary, not the structure being read.
 */
export function dimOutside(cy, ids) {
  const keep = ids ? new Set(ids) : null;
  cy.batch(() => {
    cy.elements().removeClass('dimmed');
    if (keep) {
      cy.nodes().forEach((node) => {
        if (!keep.has(node.id())) node.addClass('dimmed');
      });
      cy.edges().forEach((edge) => {
        const inside = keep.has(edge.source().id()) && keep.has(edge.target().id());
        if (!inside) edge.addClass('dimmed');
      });
    }
  });
}

/** Annotate nodes from a review analysis. Pass null to clear. */
export function overlayNodes(cy, classesByNode) {
  cy.batch(() => {
    cy.nodes().removeClass(OVERLAY_CLASSES.join(' '));
    for (const [id, className] of classesByNode ?? []) {
      const node = cy.getElementById(id);
      if (node.nonempty()) node.addClass(className);
    }
  });
}

/**
 * Ring the nodes that take part in a recorded cross-repo interaction. Pass null to clear.
 *
 * This is separate from the review overlay because it is driven by the workspace report,
 * not by a graph analysis, and the two can be on screen at once.
 */
export function ringCrossRepo(cy, ids) {
  cy.batch(() => {
    cy.nodes().removeClass('ov-cross-repo');
    for (const id of ids ?? []) {
      const node = cy.getElementById(id);
      if (node.nonempty()) node.addClass('ov-cross-repo');
    }
  });
}

/**
 * Show one kind of edge at a time: import coupling or recorded function calls.
 *
 * `mode` is `'imports'` (hide call edges) or `'calls'` (hide every other kind). A call edge
 * always parallels an import edge, so switching is a change of reading, not of reachability.
 * The class is separate from the edge-focus `edge-hidden`, so the two compose: a focused
 * file's in-unit wiring is still filtered by whichever kind is being read.
 */
export function applyEdgeKind(cy, mode) {
  const wantCalls = mode === 'calls';
  cy.batch(() => {
    for (const edge of cy.edges()) {
      const isCall = edge.data('kind') === 'call';
      edge.toggleClass('edge-kind-hidden', wantCalls ? !isCall : isCall);
    }
  });
}

/**
 * Show or hide the co-change coupling lens. Off by default; `on` reveals the dashed
 * co-change edges an `/analysis/co-change` report already recorded. Their `coChange` data
 * flag is the source of truth, so this only toggles visibility and never invents an edge.
 */
export function applyCoChange(cy, on) {
  const visible = on === true;
  cy.batch(() => {
    for (const edge of cy.edges()) {
      if (edge.data('coChange') !== true) {
        continue;
      }
      edge.toggleClass('edge-cochange-hidden', !visible);
    }
  });
}

/**
 * Show or hide the hidden-coupling lens (K3). Off by default; `on` reveals the co-change
 * edges whose files share commits with no import path in either direction, drawn distinctly
 * from the general co-change lens. Their `hiddenCoupling` data flag is the source of truth,
 * so this only toggles visibility and never invents an edge.
 */
export function applyHiddenCoupling(cy, on) {
  const visible = on === true;
  cy.batch(() => {
    for (const edge of cy.edges()) {
      if (edge.data('hiddenCoupling') !== true) {
        continue;
      }
      edge.toggleClass('edge-hidden-coupling-hidden', !visible);
    }
  });
}

/**
 * Thin the edges by level of detail at far zoom on a large graph.
 *
 * The rule is pure ({@link edgeLodHidden}); this walks the live edges and applies it. It
 * runs on a render and after a zoom settles, never per frame, because toggling a class on
 * every edge is itself per-element work.
 */
export function applyEdgeLod(cy, { edgeCount = 0, zoom = 1 } = {}) {
  cy.batch(() => {
    for (const edge of cy.edges()) {
      edge.toggleClass('edge-lod-hidden', edgeLodHidden(edge.data('weight'), zoom, edgeCount));
    }
  });
}

/**
 * Hide nodes that do not match; returns the id set that stayed visible (null for all).
 */
export function filterNodes(cy, ids) {
  const keep = ids ? new Set(ids) : null;
  cy.batch(() => {
    cy.nodes().forEach((node) => {
      const visible = !keep || keep.has(node.id());
      node.toggleClass('filtered-out', !visible);
    });
  });
  return keep;
}

/**
 * Colour nodes by tier and optionally hide every other tier.
 *
 * `tierByFile` is a file → tier map, or null to clear the lens. A tier of `all` colours
 * without filtering. `tier-hidden` is separate from the text filter's `filtered-out`, so
 * the two filters compose instead of clearing each other.
 */
export function applyTier(cy, tierByFile, filterTier = 'all') {
  const enabled = tierByFile instanceof Map;
  cy.batch(() => {
    for (const node of cy.nodes()) {
      for (const tier of TIER_ORDER) {
        node.removeClass(`tier-${tier}`);
      }
      if (!enabled) {
        node.removeClass('tier-hidden');
        continue;
      }
      const tier = tierByFile.get(node.id());
      if (tier) {
        node.addClass(`tier-${tier}`);
      }
      const keep = filterTier === 'all' || tier === filterTier;
      node.toggleClass('tier-hidden', !keep);
    }
  });
}

/**
 * The large-file lens: keep only files at or above `threshold` lines and size them by lines.
 *
 * Off by default and file-mode only. `loc-hidden` is separate from the text filter's
 * `filtered-out` and the tier lens's `tier-hidden`, so the three compose instead of
 * clearing each other; `loc-sized` swaps the width/height mapping to `data(locDiameter)`,
 * and `large-file` marks a survivor so it reads as large even when its neighbours differ.
 * Pass `on: false` to clear the lens and restore the default blast-radius encoding.
 */
export function applyLocLens(cy, threshold, on) {
  const enabled = on === true;
  const min = Number.isFinite(threshold) && threshold > 0 ? threshold : 0;
  cy.batch(() => {
    for (const node of cy.nodes()) {
      const kind = node.data('kind');
      const lines = node.data('lines');
      const isFile = kind !== 'unit' && kind !== 'shelf';
      if (!enabled || !isFile || typeof lines !== 'number') {
        node.removeClass('loc-hidden');
        node.removeClass('large-file');
        node.removeClass('loc-sized');
        continue;
      }
      const large = lines >= min;
      node.toggleClass('loc-hidden', !large);
      node.toggleClass('large-file', large);
      node.addClass('loc-sized');
    }
  });
}

/**
 * Mark the files and edges in a wrong-way dependency. Pass null to clear.
 *
 * `byNode` maps a file to its classes and `edges` names the endpoints to mark. Upward
 * and skip-layer use different classes, so the two differ by border/line shape, not hue.
 */
export function applyTierDirections(cy, directions) {
  const nodes = directions?.byNode instanceof Map ? directions.byNode : null;
  const edges = Array.isArray(directions?.edges) ? directions.edges : [];
  cy.batch(() => {
    for (const node of cy.nodes()) {
      node.removeClass('tier-upward');
      node.removeClass('tier-skip');
    }
    for (const edge of cy.edges()) {
      edge.removeClass('edge-tier-upward');
      edge.removeClass('edge-tier-skip');
    }
    if (!nodes) {
      return;
    }
    for (const [id, classes] of nodes) {
      const node = cy.getElementById(id);
      if (node.nonempty()) {
        for (const cls of classes) {
          node.addClass(cls);
        }
      }
    }
    for (const direction of edges) {
      const cls = direction.kind === 'upward' ? 'edge-tier-upward' : 'edge-tier-skip';
      cy.edges()
        .filter(
          (edge) =>
            edge.data('source') === direction.source && edge.data('target') === direction.target,
        )
        .addClass(cls);
    }
  });
}
