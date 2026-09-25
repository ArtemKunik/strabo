/**
 * Text the Strabo chrome shows about the graph: the header summary, the tests / components
 * strip, the map legend, the shortcut sheet, and the diagnostics panel summary.
 *
 * Pure functions only: no DOM, no Cytoscape, no fetch.
 */

import { topLevelDirectory } from './strabo-graph-ids.js';

/** Counts for the tests / components strip, in file, block, or system mode. */
export function mapCounts(model) {
  const isBlock = model.prefixLength !== undefined || model.system === true;
  const byKey = new Map();
  let tests = 0;
  let modules = 0;

  for (const node of model.nodes ?? []) {
    if (node.kind === 'test') {
      tests += 1;
    } else {
      modules += 1;
    }
    // A System drill-down lists the open unit's layers, not one chip per file.
    const key = model.systemUnit
      ? node.collapsed
        ? 'outside units'
        : node.systemLayer ?? 'unit'
      : isBlock
        ? String(node.id)
        : topLevelDirectory(node.id);
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }

  const entries = [...byKey.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({
      label: key,
      count,
      // Block ids are whole directories; file ids filter by their directory prefix.
      filter: key === '.' ? '' : isBlock && !model.systemUnit ? key : `${key}/`,
    }));

  return { tests, modules, entries };
}

/**
 * Text for the "Reading the map" visual key.
 *
 * Keyboard gestures moved to the shortcut sheet (`?`), so this box states only what the
 * drawing encodes and how to read it.
 */
export function readingLegend(model, locLens = false) {
  if (model?.systemUnit) {
    return [
      'box = unit frame',
      'lane = layer',
      'edge = selected file import',
      'badge = files in another unit',
      'tag = support shelf',
    ];
  }
  if (model?.system) {
    return [
      'box = build unit',
      'size = files',
      'edge = import between units',
      'support = unit footer',
    ];
  }
  return [
    locLens ? 'size = lines of code' : 'size = dependents',
    'island = directory',
    'diamond = test',
    'star = entry',
  ];
}

/** The shortcut sheet shown on `?`: gestures, not encodings. */
export function shortcutSheet() {
  return [
    { keys: 'F', action: 'Center the selection' },
    { keys: 'I', action: 'Show change impact' },
    { keys: 'O', action: 'Show the selected file’s links to other units' },
    { keys: 'P', action: 'Trace a path between two nodes' },
    { keys: 'B', action: 'Toggle directories / files' },
    { keys: 'L', action: 'Show a file name under every file' },
    { keys: 'Z', action: 'Show only files above the line-count threshold, sized by lines' },
    { keys: 'C', action: 'Show recorded function calls instead of imports' },
    { keys: 'H', action: 'Show co-change coupling (commits that changed files together)' },
    { keys: 'S', action: 'View the selected file’s source' },
    { keys: 'T', action: 'Timeline' },
    { keys: 'N', action: 'Branches' },
    { keys: 'R', action: 'Review working-tree changes' },
    { keys: 'V', action: 'Dependency risk' },
    { keys: 'G', action: 'Delegate the selected files' },
    { keys: '⌘K / ctrl-K', action: 'Filter paths' },
    { keys: 'Esc', action: 'Clear the selection or close a panel' },
    { keys: '?', action: 'Show this sheet' },
    { keys: 'hover a node', action: 'Report its blast radius' },
    { keys: '⌘/ctrl-click, shift-drag', action: 'Select a group' },
  ];
}

/** Summarise diagnostics and exclusions for the diagnostics panel. */
export function summarizeDiagnostics(model) {
  const byKind = {};
  for (const diagnostic of model.diagnostics ?? []) {
    byKind[diagnostic.kind] = (byKind[diagnostic.kind] ?? 0) + 1;
  }
  const excludedByReason = {};
  for (const exclusion of model.excluded ?? []) {
    excludedByReason[exclusion.reason] = (excludedByReason[exclusion.reason] ?? 0) + 1;
  }
  return {
    diagnostics: (model.diagnostics ?? []).length,
    excluded: (model.excluded ?? []).length,
    byKind,
    excludedByReason,
    samples: (model.diagnostics ?? []).slice(0, 50),
    // Runtime vocabulary the header no longer carries; shown in the Diagnostics panel.
    cache: model.cache?.status ?? 'unknown',
    stale: Boolean(model.cache?.stale),
  };
}

/**
 * Counts for the header.
 *
 * Internal vocabulary (`cache: miss`, renderer, excluded/diagnostic counts) lives in the
 * Diagnostics panel; the header states what the map holds and stops there.
 */
export function graphSummary(model) {
  const nodes = (model?.nodes ?? []).length;
  const edges = (model?.edges ?? []).length;
  // A System L0 map is units, not files; the drill-down and the file map are nodes. Naming
  // the unit is what stops "45 nodes" reading as if the shelves were still peers.
  const nodeWord =
    model?.system && !model?.systemUnit
      ? nodes === 1
        ? 'unit'
        : 'units'
      : nodes === 1
        ? 'node'
        : 'nodes';
  const edgeWord = edges === 1 ? 'edge' : 'edges';
  return `${nodes} ${nodeWord} · ${edges} ${edgeWord}`;
}
