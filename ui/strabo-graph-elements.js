/**
 * Cytoscape element building for the Strabo graph: node shapes, the `{ nodes, edges }`
 * pair joined from the API model, and the co-change and hidden-coupling lens edges.
 *
 * Pure functions only: no DOM, no Cytoscape, no fetch.
 */

import { edgeStrokeWidth, locDiameter, nodeDiameter } from './strabo-graph-sizing.js';

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
function structureEdgeLabel(edge) {
  const weight = typeof edge.weight === 'number' && edge.weight > 0 ? edge.weight : null;
  if (edge.tierKind === 'upward') {
    return weight ? `⚠️ ${weight} upward` : '⚠️ upward';
  }
  if (edge.tierKind === 'skip-layer') {
    return weight ? `↷ ${weight} skip` : '↷ skip';
  }
  if (edge.violation) {
    return weight ? `⚠️ ${weight} violation` : '⚠️ violation';
  }
  if (edge.ghost) {
    return 'intent (0)';
  }
  if (weight) {
    return `${weight} import${weight === 1 ? '' : 's'}`;
  }
  return '';
}

/** Join API nodes to metrics and positions. */
export function buildElements(model) {
  const positions = new Map((model.positions ?? []).map((position) => [position.id, position]));
  const hubs = new Set(model.hubs ?? []);
  const ambiguous = ambiguousFileIds(model);
  const nodes = (model.nodes ?? []).map((node) => {
    let label =
      node.label ??
      model.directoryLabels?.[node.id] ??
      (ambiguous.has(node.id) ? qualifiedName(node.id) : node.id.split('/').pop());

    if (model.structure && (node.kind === 'tier' || node.kind === 'shelf')) {
      const title = node.label ?? node.id;
      const count = typeof node.files === 'number' ? node.files : (typeof node.size === 'number' ? node.size : null);
      if (count !== null) {
        const fileStr = `${count} ${count === 1 ? 'file' : 'files'}`;
        const lineStr =
          typeof node.lines === 'number' && node.lines > 0
            ? ` · ${node.lines >= 1000 ? `${(node.lines / 1000).toFixed(1)}k` : node.lines} loc`
            : '';
        label = `${title}\n${fileStr}${lineStr}`;
      }
    }

    return {
      group: 'nodes',
      classes: [
        `kind-${node.kind}`,
        node.ghost === true ? 'node-ghost' : '',
        model.structure ? 'structure-node' : '',
        model.structure && node.kind === 'tier' ? 'structure-tier' : '',
        model.structure && node.kind === 'shelf' ? 'structure-shelf' : '',
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
        : edge.tierKind === 'skip-layer'
          ? 'edge-tier-skip'
          : '',
      edge.crossUnitEdge === true ? 'edge-structure-cross-unit' : '',
      edge.ghost === true ? 'edge-ghost' : '',
      edge.violation === true ? 'edge-violation' : '',
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
