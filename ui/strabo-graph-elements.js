/**
 * Cytoscape element building for the Strabo graph: node shapes, the `{ nodes, edges }`
 * pair joined from the API model, and the co-change and hidden-coupling lens edges.
 *
 * Pure functions only: no DOM, no Cytoscape, no fetch.
 */

import { isWrongWayEdge, unexplainedImports } from './strabo-graph-facts.js';
import { edgeStrokeWidth, locDiameter, nodeDiameter } from './strabo-graph-sizing.js';
import {
  isStructureStack,
  sideLabelled,
  structureEdgeBends,
  structureLabelShifts,
  structureGridRank,
  structureStackRank,
} from './strabo-structure-layout.js';

export const SHAPES = {
  module: 'round-rectangle',
  test: 'diamond',
  entry: 'star',
  service: 'hexagon',
  topic: 'ellipse',
  queue: 'rectangle',
  table: 'barrel',
  entity: 'round-tag',
  schema: 'round-diamond',
  // System-view roll-ups: a build unit is a card, its folded support shelf a footer strip.
  unit: 'round-rectangle',
  shelf: 'rectangle',
  // Structure-view roll-ups: a role-tier band/cell is a card, on par with a unit box; an
  // axis header (a unit column or tier row) is a bare label.
  tier: 'round-rectangle',
  axis: 'round-rectangle',
};

/**
 * Ids whose bare file name is shared with another file node.
 *
 * `mod.rs` or `types.rs` says nothing when a dozen directories hold one, so those labels
 * carry their parent directory. Only plain path ids qualify: a block or unit node already
 * has a server-supplied label, and a `#support` roll-up is not a file.
 */
function ambiguousFileIds(model) {
  const byName = new Map();
  for (const node of model.nodes ?? []) {
    if (node.label || model.directoryLabels?.[node.id] || node.kind === 'unit' || node.kind === 'shelf') {
      continue;
    }
    const segments = node.id.split('/');
    if (segments.length < 2) {
      continue;
    }
    const name = segments[segments.length - 1];
    const ids = byName.get(name);
    if (ids) ids.push(node.id);
    else byName.set(name, [node.id]);
  }
  return new Set([...byName.values()].filter((ids) => ids.length > 1).flat());
}

/** `parent/name` for a path id: enough to tell `portfolio/types.rs` from `market/types.rs`. */
function qualifiedName(id) {
  return id.split('/').slice(-2).join('/');
}

/** Edge label for Structure mode to display weights and violation badges on canvas. */
// Plain text, no emoji: a canvas draws colour emoji small and blurry, and differently per
// OS. The edge's own colour and dash (see the stylesheet) carry the warning.
/** `+3` / `−2`: a comparison delta with its sign always written. */
function signed(value) {
  return value > 0 ? `+${value}` : `−${Math.abs(value)}`;
}

function structureEdgeLabel(edge) {
  const delta = typeof edge.weightDelta === 'number' ? edge.weightDelta : 0;
  // An edge only the baseline had: the fix a change made, so it says what went away.
  if (edge.baselineOnly) {
    const kind = edge.tierKind === 'down' ? 'import' : edge.tierKind;
    return `${signed(delta)} ${kind} · gone`;
  }
  const label = structureEdgeText(edge);
  return delta !== 0 && label ? `${label} (${signed(delta)})` : label;
}

function structureEdgeText(edge) {
  const weight = typeof edge.weight === 'number' && edge.weight > 0 ? edge.weight : null;
  const typeOnly = typeof edge.typeOnlyCount === 'number' ? edge.typeOnlyCount : 0;
  const base = structureEdgeBase(edge, weight);
  // A wrong-way read made of type-only imports is the likely false positive the tier panel
  // warns about; say how much of it is types so the real violations stand out.
  if (base && weight && typeOnly > 0 && isWrongWayEdge(edge)) {
    return typeOnly >= weight ? `${base} · types only` : `${base} · ${typeOnly} type-only`;
  }
  return base;
}

function structureEdgeBase(edge, weight) {
  if (edge.tierKind === 'upward') {
    return weight ? `${weight} upward` : 'upward';
  }
  if (edge.tierKind === 'skip-layer') {
    // A declared shortcut still says it skips a tier, and which rule allows it; an edge a rule
    // covers only in part says how many of its imports that is.
    const intended =
      edge.intended === true
        ? ` · allowed (${
            edge.ruleId ?? (edge.allowedRules?.length > 1 ? `${edge.allowedRules.length} rules` : (edge.allowedRules?.[0] ?? 'rule'))
          })`
        : edge.allowedCount > 0
          ? ` · ${edge.allowedCount} allowed`
          : '';
    return `${weight ? `${weight} skip-layer` : 'skip-layer'}${intended}`;
  }
  if (edge.violation) {
    return weight ? `${weight} rule ${weight === 1 ? 'violation' : 'violations'}` : 'rule violation';
  }
  if (edge.ghost) {
    return 'intent (0)';
  }
  if (weight) {
    return `${weight} import${weight === 1 ? '' : 's'}`;
  }
  return '';
}

/** `43.6k` for a line count of 43,609; small counts stay as they are. */
function compactCount(value) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

/**
 * Wrong-way value imports leaving each tier: the upward and skip-layer edges it starts,
 * minus the type-only imports among them, which couple shapes but not runtime.
 */
function wrongWayBySource(model) {
  const counts = new Map();
  for (const edge of model.edges ?? []) {
    if (!isWrongWayEdge(edge)) continue;
    const value = unexplainedImports(edge).value;
    if (value > 0) counts.set(edge.source, (counts.get(edge.source) ?? 0) + value);
  }
  return counts;
}

/**
 * A Structure card's canvas label: its name; its files, share of the repository, and lines;
 * then, on a big enough card, the folder most of its files live in and the wrong-way imports
 * it starts. Null when the node carries no count to state.
 */
function structureCardLabel(node, wrongWay, compact = false) {
  const count = typeof node.files === 'number' ? node.files : typeof node.size === 'number' ? node.size : null;
  if (count === null) {
    return null;
  }
  const share = typeof node.fileShare === 'number' && node.fileShare > 0 ? ` (${Math.max(1, Math.round(node.fileShare * 100))}%)` : '';
  const loc = typeof node.lines === 'number' && node.lines > 0 ? ` · ${compactCount(node.lines)} loc` : '';
  const delta = typeof node.filesDelta === 'number' && node.filesDelta !== 0 ? ` ${signed(node.filesDelta)}` : '';
  const lines = [node.label ?? node.id, `${count} ${count === 1 ? 'file' : 'files'}${delta}${share}${loc}`];
  const roomy = !compact && node.kind === 'tier' && nodeDiameter(node) >= 90;
  const folder = typeof node.why === 'string' && !node.ghost ? node.why.split(', ')[0] : '';
  if (roomy && folder) {
    lines.push(folder);
  }
  // Same-tier imports are never drawn as edges (they would loop on the card), so say them.
  if (typeof node.internalImports === 'number' && node.internalImports > 0) {
    lines.push(`${node.internalImports} ${node.internalImports === 1 ? 'import' : 'imports'} within`);
  }
  if (wrongWay > 0) {
    lines.push(`${wrongWay} wrong-way ${wrongWay === 1 ? 'import' : 'imports'} out`);
  }
  return lines.join('\n');
}

/**
 * How many lines each Structure card's label runs to, keyed by node id, so the plates can
 * reach down far enough to frame it (see `islandBounds`).
 */
export function structureLabelLines(model) {
  const wrongWay = wrongWayBySource(model);
  const lines = new Map();
  for (const node of model.nodes ?? []) {
    if (node.kind !== 'tier' && node.kind !== 'shelf') continue;
    const label = structureCardLabel(node, wrongWay.get(node.id) ?? 0, model.structureLevel === 'grid');
    if (label) lines.set(node.id, label.split('\n').length);
  }
  return lines;
}

/** Join API nodes to metrics and positions. */
export function buildElements(model) {
  const positions = new Map((model.positions ?? []).map((position) => [position.id, position]));
  // The stack and the grid both bow their edges off the column (see `structureEdgeBends`).
  const stackRank = isStructureStack(model)
    ? structureStackRank(model)
    : model.structureLevel === 'grid'
      ? structureGridRank(model)
      : null;
  const bends = stackRank ? structureEdgeBends(model, stackRank, structureLabelLines(model)) : null;
  const labelShifts = stackRank ? structureLabelShifts(model, stackRank) : null;
  const hubs = new Set(model.hubs ?? []);
  const ambiguous = ambiguousFileIds(model);
  const wrongWay = model.structure ? wrongWayBySource(model) : new Map();
  const nodes = (model.nodes ?? []).map((node) => {
    let label =
      node.label ??
      model.directoryLabels?.[node.id] ??
      (ambiguous.has(node.id) ? qualifiedName(node.id) : node.id.split('/').pop());

    if (model.structure && (node.kind === 'tier' || node.kind === 'shelf')) {
      label = structureCardLabel(node, wrongWay.get(node.id) ?? 0, model.structureLevel === 'grid') ?? label;
    }

    return {
      group: 'nodes',
      classes: [
        `kind-${node.kind}`,
        node.ghost === true ? 'node-ghost' : '',
        model.structure ? 'structure-node' : '',
        model.structure && node.kind === 'tier' ? 'structure-tier' : '',
        model.structure && node.kind === 'shelf' ? 'structure-shelf' : '',
        sideLabelled(model, node) ? 'structure-label-side' : '',
        model.structureLevel === 'grid' && (node.kind === 'tier' || node.kind === 'shelf') ? 'structure-grid-cell' : '',
        model.structure && node.tier ? `tier-${node.tier}` : '',
      ]
        .filter(Boolean)
        .join(' '),
      data: {
        id: node.id,
        label,
        path: node.id,
        kind: node.kind,
        tier: node.tier,
        ghost: node.ghost === true,
        // Fill is one neutral surface for every node; directory is carried by position
        // (the island plates), never by hue. See Phase 13 M1. A System-view unit sizes by
        // its component count instead of blast radius; the hub ring is reserved for files,
        // so a unit's only outline is selection (L18).
        diameter: nodeDiameter(node),
        // The large-file lens reads these: `lines` is the file's line count (absent on
        // aggregate nodes), `locDiameter` its size when the lens swaps the encoding.
        lines: typeof node.lines === 'number' ? node.lines : null,
        files: typeof node.files === 'number' ? node.files : null,
        fileShare: typeof node.fileShare === 'number' ? node.fileShare : null,
        locDiameter: locDiameter(node.lines),
        hub: hubs.has(node.id) && node.kind !== 'unit' && node.kind !== 'shelf',
      },
      position: positionOf(positions.get(node.id)),
    };
  });

  const edges = (model.edges ?? []).map((edge, index) => ({
    group: 'edges',
    // A Structure-view edge states how it runs through the layer order; the stylesheet
    // draws a wrong-way one apart (Phase 35 Y3), and a cell edge crossing a unit boundary
    // (Y4) apart from a same-unit one.
    classes: [
      edge.tierKind === 'upward'
        ? 'edge-tier-upward'
        : edge.tierKind === 'skip-layer' && isWrongWayEdge(edge)
          ? 'edge-tier-skip'
          : '',
      edge.crossUnitEdge === true ? 'edge-structure-cross-unit' : '',
      edge.ghost === true ? 'edge-ghost' : '',
      edge.violation === true ? 'edge-violation' : '',
      bends ? 'edge-structure-stack' : '',
      edge.baselineOnly === true ? 'edge-baseline-only' : '',
      model.structure && !edge.baselineOnly && edge.tierKind && edge.tierKind !== 'down' && (edge.weightDelta ?? 0) > 0
        ? 'edge-wrong-way-grew'
        : '',
      model.structure && (edge.weight ?? 0) > 0 && (edge.typeOnlyCount ?? 0) >= edge.weight ? 'edge-type-only' : '',
    ]
      .filter(Boolean)
      .join(' '),
    data: {
      id: `e${index}`,
      source: edge.source,
      target: edge.target,
      semanticSource: edge.semanticSource ?? edge.source,
      semanticTarget: edge.semanticTarget ?? edge.target,
      kind: edge.kind,
      tierKind: edge.tierKind,
      ghost: edge.ghost === true,
      intended: edge.intended === true,
      violation: edge.violation === true,
      ruleId: edge.ruleId,
      label: model.structure ? structureEdgeLabel(edge) : undefined,
      // How far a Structure stack edge bows off the spine (see `structureEdgeBends`).
      bend: bends ? bends[index] : 0,
      labelShift: labelShifts ? labelShifts[index] : 0,
      // A System-view unit edge rolls up a file count; the stroke widens with it.
      weight: edge.weight ?? 1,
      edgeWidth: edgeStrokeWidth(edge.weight),
      evidenceLine: edge.evidence?.line,
      evidenceSpecifier: edge.evidence?.specifier,
      // In a System drill-down, `unit` edges are hidden until their file is selected;
      // `outside` edges are the L17 links and stay visible.
      scope: edge.scope,
      // A co-change edge is drawn only in the off-by-default coupling lens, as a dashed
      // relationship; the true value keeps the lens able to hide it without dropping it.
      coChange: edge.coChange === true,
    },
  }));

  return { nodes, edges };
}

/**
 * Build the `{ nodes, edges }` pair for the co-change lens from an `/analysis/co-change`
 * report. Edges run between files already in the graph; a report naming a file outside it
 * is skipped rather than inventing a node. The commit count rides on the stroke and the
 * evidence rides on the data, so an edge is never drawn without a listable commit.
 */
export function buildCoChangeElements(model, report, startIndex = 0) {
  const ids = new Set((model.nodes ?? []).map((node) => node.id));
  const edges = [];
  (report?.edges ?? []).forEach((edge, offset) => {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      return;
    }
    if (!Array.isArray(edge.commits) || edge.commits.length === 0) {
      return;
    }
    edges.push({
      group: 'edges',
      data: {
        id: `coh${startIndex + offset}`,
        source: edge.source,
        target: edge.target,
        semanticSource: edge.source,
        semanticTarget: edge.target,
        kind: 'co-change',
        weight: edge.commitsShared ?? edge.commits.length,
        edgeWidth: edgeStrokeWidth(edge.commitsShared ?? edge.commits.length),
        evidenceLine: null,
        evidenceSpecifier: `${edge.commitsShared} shared commit(s)`,
        scope: undefined,
        coChange: true,
        hidden: edge.hidden === true,
        ratio: edge.ratio,
        commitsShared: edge.commitsShared,
        commits: edge.commits,
      },
    });
  });
  return edges;
}

/**
 * Build the hidden-coupling-only edge set for the K3 lens.
 *
 * Only pairs the co-change report flagged `hidden` (no import path in either direction) and
 * that carry a listable commit are drawn, with a distinct `kind` so the stylesheet can draw
 * them differently from the general co-change lens. Off by default: it is applied only when
 * the hidden-coupling review overlay is the active lens.
 */
export function buildHiddenCouplingElements(model, report, startIndex = 0) {
  const ids = new Set((model.nodes ?? []).map((node) => node.id));
  const edges = [];
  (report?.edges ?? []).forEach((edge, offset) => {
    if (edge.hidden !== true) {
      return;
    }
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      return;
    }
    if (!Array.isArray(edge.commits) || edge.commits.length === 0) {
      return;
    }
    edges.push({
      group: 'edges',
      data: {
        id: `hid${startIndex + offset}`,
        source: edge.source,
        target: edge.target,
        semanticSource: edge.source,
        semanticTarget: edge.target,
        kind: 'hidden-coupling',
        weight: edge.commitsShared ?? edge.commits.length,
        edgeWidth: edgeStrokeWidth(edge.commitsShared ?? edge.commits.length),
        evidenceLine: null,
        evidenceSpecifier: `${edge.commitsShared} shared commit(s), no import path`,
        scope: undefined,
        coChange: true,
        hiddenCoupling: true,
        hidden: true,
        ratio: edge.ratio,
        commitsShared: edge.commitsShared,
        commits: edge.commits,
      },
    });
  });
  return edges;
}

/** Cytoscape positions are `{ x, y }`; never leak the `id` field from the API. */
function positionOf(position) {
  return position ? { x: position.x, y: position.y } : { x: 0, y: 0 };
}
