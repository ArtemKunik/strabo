/**
 * The Cytoscape stylesheet.
 *
 * Every colour comes from `graphTheme()`, i.e. from the CSS custom properties, so the
 * canvas follows the active theme without a second palette in JavaScript. The class
 * selectors here are the ones `strabo-graph-classes.js` names.
 */

import { SHAPES, TIER_ORDER } from './strabo-core.js';
import { graphTheme } from './strabo-theme.js';
import { tierIconUri } from './strabo-tier-icons.js';
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
    // A Structure-view tier band is a card too; its canvas label stays (unlike a unit card,
    // which has a side panel), so the band reads without selecting it (Phase 35 Y3).
    {
      selector: 'node.kind-tier',
      style: {
        'border-width': 2.5,
        'border-color': theme.nodeLine,
        'background-opacity': 1,
        'text-wrap': 'wrap',
        'text-max-width': 140,
        'text-valign': 'center',
        'text-halign': 'center',
        'text-margin-y': 0,
        'font-weight': 600,
        'font-size': (ele) => labelFontSize(ele.cy().zoom(), 11),
      },
    },
    // Distinct semantic tier border colors for Structure view nodes
    ...TIER_ORDER.map((tier) => ({
      selector: `node.structure-node.tier-${tier}`,
      style: {
        'border-color': tier === 'unclassified' ? theme.tierUnclassified : theme.tier[tier],
      },
    })),
    // A Structure grid axis header is a bare label: no box, just its text, so the columns and
    // rows read without competing with the cells.
    { selector: 'node.kind-axis', style: { 'background-opacity': 0, 'border-opacity': 0, 'font-weight': 700, width: 10, height: 10 } },
    // The tier lens colours the fill; the neutral node fill is the default when it is off.
    ...tierRules,
    // A Structure tier card is a tinted panel, not a solid slab: a faint wash of the tier
    // hue with its glyph centred, and the name and counts on a plate beneath the card, so a
    // small card never has text spilling over its edges. A grid axis header is not a card.
    ...TIER_ORDER.map((tier) => {
      const color = tier === 'unclassified' ? theme.tierUnclassified : theme.tier[tier];
      return {
        selector: `node.structure-node.tier-${tier}[kind != "axis"]`,
        style: {
          'background-color': color,
          'background-opacity': 0.14,
          'background-image': tierIconUri(tier, color),
          'background-fit': 'none',
          'background-clip': 'none',
          'background-width': '42%',
          'background-height': '42%',
          'background-image-opacity': 0.95,
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': (ele) => 6 / Math.max(0.0001, ele.cy().zoom()),
          'text-max-width': (ele) => 180 / Math.max(0.0001, ele.cy().zoom()),
          'text-background-color': theme.nodeFill,
          'text-background-opacity': 0.85,
          'text-background-padding': (ele) => 3 / Math.max(0.0001, ele.cy().zoom()),
          'text-background-shape': 'round-rectangle',
          'line-height': 1.3,
          // The label sits on its own plate, so the outline the map's floating labels need only smears it.
          'text-outline-width': 0,
        },
      };
    }),
    // Down a vertical stack a band's label sits to its right, leaving the gaps along the
    // stack to the edge labels.
    // A grid cell sits in a tight unit × tier lattice with no room beneath it, so its label
    // stays inside the card over a faint glyph, as a watermark rather than an icon.
    {
      selector: 'node.structure-grid-cell',
      style: {
        'text-valign': 'center',
        'text-margin-y': 0,
        'background-image-opacity': 0.22,
        'background-width': '64%',
        'background-height': '64%',
      },
    },
    {
      selector: 'node.structure-label-side',
      style: {
        'text-valign': 'center',
        'text-halign': 'right',
        'text-justification': 'left',
        'text-margin-x': (ele) => 8 / Math.max(0.0001, ele.cy().zoom()),
        'text-margin-y': 0,
      },
    },
    // The large-file lens swaps the size encoding to lines of code and hides files under
    // the threshold. `loc-sized` outranks the base `node` width/height mapping; the mark
    // is a heavier neutral ring (weight, not hue), so it never collides with a status.
    { selector: 'node.loc-sized', style: { width: 'data(locDiameter)', height: 'data(locDiameter)' } },
    { selector: 'node.large-file', style: { 'border-width': 2.5, 'border-color': theme.nodeLine } },
    // A unit/shelf draws no canvas label: its card states the name, and the box is left to
    // the card's header row. Selection is the only outline it earns (L18). Structure shelves keep labels.
    { selector: 'node.kind-unit, node.kind-shelf', style: { 'text-opacity': 0, 'border-width': 1.5 } },
    {
      selector: 'node.structure-shelf, node.kind-shelf.structure-shelf',
      style: {
        'border-width': 2,
        'border-style': 'dashed',
        'text-opacity': 1,
        'text-wrap': 'wrap',
        'font-weight': 600,
        'font-size': (ele) => labelFontSize(ele.cy().zoom(), 10),
      },
    },
    // Phase 37 data-flow reading: a hub is a dataset the stack routes recorded reads and
    // writes through. It is a neutral ellipse with the hub tone (never a status hue), labelled
    // beneath like a card; a governed hub takes a double ring, the same "governed" shape the
    // contract lens uses.
    {
      selector: 'node.kind-dataset',
      style: {
        'border-width': 2,
        'border-color': theme.hub,
        'background-color': theme.nodeFill,
        'background-opacity': 1,
        'text-wrap': 'wrap',
        'text-max-width': 120,
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': (ele) => 6 / Math.max(0.0001, ele.cy().zoom()),
        'text-background-color': theme.nodeFill,
        'text-background-opacity': 0.85,
        'text-background-padding': (ele) => 2 / Math.max(0.0001, ele.cy().zoom()),
        'text-background-shape': 'round-rectangle',
        'font-weight': 600,
        'font-size': (ele) => labelFontSize(ele.cy().zoom(), 10),
      },
    },
    { selector: 'node.structure-hub.data-governed', style: { 'border-width': 3, 'border-style': 'double' } },
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
    // The coverage overlay (Phase 34 U1): a sequential measured ramp on the accent hue (the
    // Phase 13 budget keeps hue for status and tiers, so the ramp is opacity, not new colours).
    // The four states differ by shape as well as tone: a measured bucket is a solid accent
    // fill, a measured 0% a heavy ring, `not in report` a dashed ring, `reachable only` a
    // dotted ring, and a stale figure a grey dotted ring, never presented as current.
    { selector: 'node.cov-90', style: { 'background-color': theme.edgeAccent, 'background-opacity': 0.85, 'border-color': theme.edgeAccent, 'border-width': 1.5 } },
    { selector: 'node.cov-70', style: { 'background-color': theme.edgeAccent, 'background-opacity': 0.66, 'border-color': theme.edgeAccent, 'border-width': 1.5 } },
    { selector: 'node.cov-50', style: { 'background-color': theme.edgeAccent, 'background-opacity': 0.5, 'border-color': theme.edgeAccent, 'border-width': 1.5 } },
    { selector: 'node.cov-30', style: { 'background-color': theme.edgeAccent, 'background-opacity': 0.34, 'border-color': theme.edgeAccent, 'border-width': 1.5 } },
    { selector: 'node.cov-10', style: { 'background-color': theme.edgeAccent, 'background-opacity': 0.2, 'border-color': theme.edgeAccent, 'border-width': 1.5 } },
    { selector: 'node.cov-zero', style: { 'background-color': theme.edgeAccent, 'background-opacity': 0.1, 'border-color': theme.edgeAccent, 'border-width': 3, 'border-style': 'solid' } },
    { selector: 'node.cov-noreport', style: { 'background-opacity': 0, 'border-color': theme.affected, 'border-width': 2.5, 'border-style': 'dashed' } },
    { selector: 'node.cov-reachable', style: { 'background-opacity': 0, 'border-color': theme.cycle, 'border-width': 2.5, 'border-style': 'dotted' } },
    { selector: 'node.cov-stale', style: { 'background-color': theme.unreached, 'background-opacity': 0.45, 'border-color': theme.unreached, 'border-width': 2, 'border-style': 'dotted' } },
    // Hidden coupling is a co-change pair with no import path: the status serious ring marks
    // the endpoints, and the distinct edge below carries the relationship (K3).
    { selector: 'node.ov-hidden-coupling', style: { 'border-width': 3, 'border-style': 'double', 'border-color': theme.cycle, 'background-opacity': 1 } },
    // A declared-rule violation is a serious signal, so it rides the reserved status scale:
    // a heavy solid ring in the serious hue, distinct from the changed and cycle rings.
    { selector: 'node.ov-declared-rule', style: { 'border-width': 3, 'border-style': 'solid', 'border-color': theme.cycle, 'background-opacity': 1 } },
    // The data-on-code overlay (J11): a file that touches a recorded dataset takes a dashed
    // accent ring, and one that produces a declared product's output port a heavier double
    // ring, so the product producers read apart from the plain data touch.
    { selector: 'node.ov-data', style: { 'border-width': 2.5, 'border-style': 'dashed', 'border-color': theme.edgeAccent, 'background-opacity': 1 } },
    { selector: 'node.ov-product', style: { 'border-width': 4, 'border-style': 'double', 'border-color': theme.edgeAccent, 'background-opacity': 1 } },
    // The Data contracts overlay (Phase 36 K2): a contract definition takes a solid neutral
    // accent ring. Drifting implementations reuse the serious status double ring and
    // ungoverned endpoints the dashed warning ring, so no new hue enters the budget.
    { selector: 'node.ov-contract-def', style: { 'border-width': 3, 'border-style': 'solid', 'border-color': theme.edgeAccent, 'background-opacity': 1 } },
    // Selection and the status rings above force a solid fill, which would bury a tier
    // card's glyph (drawn in the same hue); the card keeps its wash and shows them as rings.
    { selector: 'node.structure-node', style: { 'background-opacity': 0.14 } },
    { selector: 'node.node-ghost', style: { 'border-style': 'dashed', opacity: 0.6 } },
    { selector: 'node.label-hidden', style: { 'text-opacity': 0 } },
    { selector: 'node.filtered-out', style: { display: 'none' } },
    { selector: 'node.tier-hidden', style: { display: 'none' } },
    { selector: 'node.loc-hidden', style: { display: 'none' } },
    { selector: 'edge.edge-hidden', style: { display: 'none' } },
    { selector: 'edge.edge-kind-hidden', style: { display: 'none' } },
    // Level of detail: at far zoom on a large graph the unweighted edges drop from the draw
    // (see `applyEdgeLod`). Display, not opacity, so the renderer skips them entirely.
    { selector: 'edge.edge-lod-hidden', style: { display: 'none' } },
    // A co-change edge is a changed-together relationship, not a dependency: dashed so the
    // reading survives next to an import, and hidden until the off-by-default lens is on.
    { selector: 'edge[kind = "co-change"]', style: { 'line-style': 'dashed', opacity: 0.85 } },
    { selector: 'edge.edge-cochange-hidden', style: { display: 'none' } },
    // Hidden coupling is drawn distinctly: bigger dashes in the cycle status hue, so the
    // no-import-path relationship reads apart from the general co-change lens (K3).
    { selector: 'edge[kind = "hidden-coupling"]', style: { 'line-style': 'dashed', 'line-dash-pattern': [10, 6], width: 2.4, 'line-color': theme.cycle, 'target-arrow-color': theme.cycle, opacity: 0.95 } },
    { selector: 'edge.edge-hidden-coupling-hidden', style: { display: 'none' } },
    // A call is a runtime relationship, distinct from a module-tree import; dashed so the
    // reading survives even if both kinds are ever drawn together.
    { selector: 'edge[kind = "call"]', style: { 'line-style': 'dashed' } },
    // An inheritance edge is a type relation (`extends`/`implements`), not a module import:
    // a short dash in the accent hue reads it apart from a plain import and a call.
    { selector: 'edge[kind = "inheritance"]', style: { 'line-style': 'dashed', 'line-dash-pattern': [3, 3], 'line-color': theme.edgeAccent, 'target-arrow-color': theme.edgeAccent } },
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
    {
      selector: 'edge[label]',
      style: {
        label: 'data(label)',
        'font-size': (ele) => labelFontSize(ele.cy().zoom(), 10),
        'font-weight': 600,
        color: theme.ink,
        'text-background-color': theme.nodeFill,
        'text-background-opacity': 1,
        'text-background-padding': (ele) => 3 / Math.max(0.0001, ele.cy().zoom()),
        'text-background-shape': 'round-rectangle',
        'text-border-color': theme.nodeLine,
        'text-border-width': 1,
        'text-border-opacity': 0.6,
        'text-rotation': 'autorotate',
      },
    },
    // A Structure stack edge bows off the spine by its `bend`: the halves of an A⇄B pair
    // split into two arcs, and a skip-layer edge arcs around the bands it jumps. The stack
    // holds a dozen edges at most, so the curve costs nothing here.
    {
      selector: 'edge.edge-structure-stack',
      style: {
        // Level text reads crisply; text turned along a steep arc blurs at small sizes.
        'text-rotation': 'none',
        'text-margin-y': (ele) => (ele.data('labelShift') ?? 0) / Math.max(0.0001, ele.cy().zoom()),
        // A wider arc passes over the tighter ones' labels; drawing tighter arcs on top keeps
        // every label whole.
        'z-index': (ele) => Math.max(1, 9 - Math.round(Math.abs(ele.data('bend') ?? 0) / 80)),
      },
    },
    // Only a bowed edge is a bezier: with a zero control distance the renderer draws the
    // arrowheads and no line between adjacent cards, so an unbowed edge stays straight.
    {
      selector: 'edge.edge-structure-stack[bend != 0]',
      style: {
        'curve-style': 'unbundled-bezier',
        'control-point-distances': (ele) => ele.data('bend') ?? 0,
        'control-point-weights': 0.5,
      },
    },
    {
      selector: 'edge.edge-tier-upward',
      style: {
        width: 3.25,
        'line-style': 'dashed',
        'line-dash-pattern': [8, 5],
        'line-color': theme.cycle,
        'target-arrow-color': theme.cycle,
        'text-border-color': theme.cycle,
        'text-border-width': 1.5,
        'text-border-opacity': 1,
        opacity: 1,
      },
    },
    {
      selector: 'edge.edge-tier-skip',
      style: {
        width: 2.75,
        'line-style': 'dashed',
        'line-color': theme.affected,
        'target-arrow-color': theme.affected,
        'text-border-color': theme.affected,
        'text-border-width': 1.5,
        'text-border-opacity': 1,
        opacity: 1,
      },
    },
    // A wrong-way edge made only of type imports is erased at compile time: it keeps its
    // hue so it still reads as wrong-way, but fades and thins, so real violations lead.
    { selector: 'edge.edge-type-only', style: { opacity: 0.45, width: 1.75, 'line-dash-pattern': [3, 5] } },
    // A comparison: an edge the baseline had and the change removed is a faint dotted trace;
    // a wrong-way edge that grew gets a heavier, glowing plate, so the regression is found first.
    { selector: 'edge.edge-baseline-only', style: { width: 1.5, 'line-style': 'dotted', opacity: 0.5, 'target-arrow-shape': 'none' } },
    { selector: 'edge.edge-wrong-way-grew', style: { width: 4, 'text-border-width': 2.5, 'underlay-color': theme.cycle, 'underlay-opacity': 0.18, 'underlay-padding': 4 } },
    { selector: 'edge.edge-ghost', style: { width: 1.75, 'line-style': 'dashed', opacity: 0.45, 'line-color': theme.edge, 'target-arrow-color': theme.edge } },
    { selector: 'edge.edge-violation', style: { width: 3, 'line-color': theme.cycle, 'target-arrow-color': theme.cycle, 'text-border-color': theme.cycle, 'text-border-width': 1.5, 'text-border-opacity': 1, opacity: 1 } },
    // A Structure grid edge that crosses a unit boundary is a relationship between services,
    // not only a wrong-way read: a thick accent line, distinct from the status hues.
    { selector: 'edge.edge-structure-cross-unit', style: { width: 3, 'line-color': theme.edgeAccent, 'target-arrow-color': theme.edgeAccent, opacity: 1 } },
    // Phase 37 data-flow reading: a write/produce is solid and accent-coloured (data leaving a
    // tier), a read/consume is dashed in the hub tone (data entering a tier), and a lineage
    // derive is dotted. Read vs write is never left to hue alone — the dash carries it too.
    { selector: 'edge.edge-flow', style: { width: 2.25, 'line-color': theme.edge, 'target-arrow-color': theme.edge, opacity: 0.9 } },
    { selector: 'edge.edge-flow-writes, edge.edge-flow-produces', style: { width: 2.75, 'line-color': theme.edgeAccent, 'target-arrow-color': theme.edgeAccent, opacity: 1 } },
    { selector: 'edge.edge-flow-reads, edge.edge-flow-consumes', style: { 'line-style': 'dashed', 'line-dash-pattern': [6, 4], 'line-color': theme.hub, 'target-arrow-color': theme.hub, opacity: 0.95 } },
    { selector: 'edge.edge-flow-derives', style: { 'line-style': 'dotted', 'line-color': theme.edge, 'target-arrow-color': theme.edge, opacity: 0.8 } },
    { selector: 'edge.edge-flow-governed', style: { 'text-border-color': theme.selected, 'text-border-width': 1.5, 'text-border-opacity': 1 } },
    { selector: 'edge.edge-flow-drifting', style: { 'line-color': theme.cycle, 'target-arrow-color': theme.cycle, 'text-border-color': theme.cycle, 'text-border-width': 1.5, 'text-border-opacity': 1, opacity: 1 } },
    { selector: 'edge.edge-flow-unverified', style: { 'line-style': 'dotted', opacity: 0.7 } },
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
