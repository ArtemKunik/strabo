/**
 * The Cytoscape stylesheet.
 *
 * Every colour comes from `graphTheme()`, i.e. from the CSS custom properties, so the
 * canvas follows the active theme without a second palette in JavaScript. The class
 * selectors here are the ones `strabo-graph-classes.js` names.
 */

import { SHAPES, TIER_ORDER } from './strabo-core.js';
import { graphTheme } from './strabo-theme.js';
import { HUB_LABEL_DEVICE_PX, labelFontSize } from './strabo-labels.js';

export function stylesheet() {
  const theme = graphTheme();
  const kindRules = Object.entries(SHAPES).map(([kind, shape]) => ({
    selector: `node.kind-${kind}`,
    style: { shape },
  }));
  const tierRules = TIER_ORDER.map((tier) => ({
    selector: `node.tier-${tier}`,
    style: {
      'background-color': tier === 'unclassified' ? theme.tierUnclassified : theme.tier[tier],
    },
  }));

  return [
    {
      selector: 'node',
      style: {
        shape: 'round-rectangle',
        // One neutral fill for every node: directory is carried by position (island
        // plates), and hue on the map is reserved for status. See Phase 13 M1 R3.
        'background-color': theme.nodeFill,
        'background-opacity': 1,
        width: 'data(diameter)',
        height: 'data(diameter)',
        label: 'data(label)',
        // Functions of the live zoom: Cytoscape re-evaluates them on `style().update()`,
        // which the zoom handler calls. See `LABEL_DEVICE_PX`.
        'font-size': (ele) => labelFontSize(ele.cy().zoom()),
        'font-weight': 500,
        color: theme.ink,
        'text-valign': 'bottom',
        'text-margin-y': (ele) => 4 / Math.max(0.0001, ele.cy().zoom()),
        'text-opacity': 1,
        'text-outline-color': theme.inkOutline,
        'text-outline-width': (ele) => 2 / Math.max(0.0001, ele.cy().zoom()),
        'text-outline-opacity': 0.9,
        'border-width': 1.5,
        'border-color': theme.nodeLine,
        'border-opacity': 1,
      },
    },
    ...kindRules,
    // A System-view unit is a card: a heavier neutral ring reads as a container, and the
    // selection ring (`node:selected`, below) is the only highlight one takes. Its folded
    // support shelf is drawn as a muted dashed strip, never a peer box.
    { selector: 'node.kind-unit', style: { 'border-width': 2, 'border-color': theme.nodeLine, 'background-opacity': 1 } },
    { selector: 'node.kind-shelf', style: { 'border-width': 1.5, 'border-style': 'dashed', 'border-color': theme.nodeLine, opacity: 0.85 } },
    // The tier lens colours the fill; the neutral node fill is the default when it is off.
    ...tierRules,
    // A unit/shelf draws no canvas label: its card states the name, and the box is left to
    // the card's header row. Selection is the only outline it earns (L18).
    { selector: 'node.kind-unit, node.kind-shelf', style: { 'text-opacity': 0, 'border-width': 1.5 } },
    { selector: 'node:selected', style: { 'border-width': 3, 'border-color': theme.selected, 'background-opacity': 1 } },
    { selector: 'node[?hub]', style: { 'border-width': 2.5, 'border-color': theme.hub, 'font-size': (ele) => labelFontSize(ele.cy().zoom(), HUB_LABEL_DEVICE_PX), 'font-weight': 700 } },
    // Status never rides on hue alone (R6): changed is a solid heavy ring, affected a
    // dotted one, cycle a double one, unreached a light dashed one, hotspot a dotted
    // warning ring. The changed/affected pair co-occurs, so its shape differs too.
    { selector: 'node.ov-changed', style: { 'border-width': 4, 'border-style': 'solid', 'border-color': theme.changed, 'background-opacity': 1 } },
    { selector: 'node.ov-affected', style: { 'border-width': 3, 'border-style': 'dotted', 'border-color': theme.affected, 'background-opacity': 1 } },
    { selector: 'node.ov-cycle', style: { 'border-width': 4, 'border-style': 'double', 'border-color': theme.cycle, 'background-opacity': 1 } },
    { selector: 'node.ov-unreached', style: { 'border-width': 2.5, 'border-style': 'dashed', 'border-color': theme.unreached, 'background-opacity': 0.7 } },
    { selector: 'node.ov-hotspot', style: { 'border-width': 3, 'border-style': 'dotted', 'border-color': theme.affected, 'background-opacity': 1 } },
    { selector: 'node.ov-wide-interface', style: { 'border-width': 3, 'border-style': 'solid', 'border-color': theme.affected, 'background-opacity': 1 } },
    { selector: 'node.ov-pass-through', style: { 'border-width': 2.5, 'border-style': 'dashed', 'border-color': theme.unreached, 'background-opacity': 0.7 } },
    { selector: 'node.ov-sole-owner', style: { 'border-width': 3, 'border-style': 'dotted', 'border-color': theme.cycle, 'background-opacity': 1 } },
    // Cross-repo is a relationship, not a status, so it rides on the accent hue: a heavy
    // dotted ring that reads as "part of a workspace flow" without entering the status set.
    { selector: 'node.ov-cross-repo', style: { 'border-width': 4, 'border-style': 'dotted', 'border-color': theme.edgeAccent, 'background-opacity': 1 } },
    // The tier direction check: a wrong-way dependency is a signal, so it rides on the
    // reserved status scale and differs by shape (double vs dashed), never hue alone.
    { selector: 'node.tier-upward', style: { 'border-width': 4, 'border-style': 'double', 'border-color': theme.cycle, 'background-opacity': 1 } },
    { selector: 'node.tier-skip', style: { 'border-width': 3, 'border-style': 'dashed', 'border-color': theme.affected, 'background-opacity': 1 } },
    // Smells are a signal, so they ride the reserved status scale; the panel names the rule.
    { selector: 'node.ov-smell', style: { 'border-width': 3, 'border-style': 'dotted', 'border-color': theme.affected, 'background-opacity': 1 } },
    { selector: 'node.label-hidden', style: { 'text-opacity': 0 } },
    { selector: 'node.filtered-out', style: { display: 'none' } },
    { selector: 'node.tier-hidden', style: { display: 'none' } },
    { selector: 'edge.edge-hidden', style: { display: 'none' } },
    { selector: '.dimmed', style: { opacity: 0.12 } },
    {
      selector: 'edge',
      style: {
        // Straight, not bezier. A bezier is the most expensive edge the renderers
        // draw: the WebGL path emits a mitre-joined segment strip per edge where a
        // straight edge is one stretched quad, and the 2D path recomputes control
        // points on every restyle. The cost buys only the arc that separates a
        // bidirectional pair, so an import cycle now draws as a single line with a
        // head at each end rather than two bowed ones.
        'curve-style': 'straight',
        'target-arrow-shape': 'triangle',
        // A System-view unit edge rolls up a file count, so its stroke carries the weight;
        // a file edge stays the base hairline. See `edgeStrokeWidth`.
        width: 'data(edgeWidth)',
        // `--graph-edge` clears 3:1 on `--bg-1`; the old #3a4a5e read as haze when the
        // whole repository was fitted. Non-neighbourhood edges dim on hover (R9).
        opacity: 1,
        'line-color': theme.edge,
        'target-arrow-color': theme.edge,
        'arrow-scale': 0.9,
      },
    },
    { selector: 'edge.edge-tier-upward', style: { width: 2.75, 'line-color': theme.cycle, 'target-arrow-color': theme.cycle, opacity: 1 } },
    { selector: 'edge.edge-tier-skip', style: { width: 2.25, 'line-color': theme.affected, 'target-arrow-color': theme.affected, opacity: 1 } },
    { selector: 'edge.edge-faded', style: { opacity: 0.1 } },
    { selector: 'edge.dimmed', style: { opacity: 0.05 } },
    {
      selector: 'edge.edge-selected',
      style: {
        width: 2.75,
        opacity: 1,
        'line-color': theme.edgeSelected,
        'target-arrow-color': theme.edgeSelected,
        'arrow-scale': 1.1,
        'z-index': 10,
      },
    },
    {
      selector: 'edge.hover',
      style: {
        width: 2,
        opacity: 0.9,
        'line-color': theme.edgeAccent,
        'target-arrow-color': theme.edgeAccent,
      },
    },
  ];
}
