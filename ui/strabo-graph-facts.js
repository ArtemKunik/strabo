/**
 * The per-node and per-edge facts the inspector shows: the Module Passport, co-change
 * partners, unit and shelf hover text, and the recorded evidence behind an edge.
 *
 * Pure functions only: no DOM, no Cytoscape, no fetch.
 */

/**
 * Everything the Module Passport shows for a node.
 *
 * Metrics come from the server-computed view model; imports and used-by come from the
 * evidence edges. Per-function detail is loaded separately from `/symbols` (see
 * `renderFunctions`), because it is extracted on demand rather than during the scan.
 */
export function passportFor(model, id) {
  const node = (model.nodes ?? []).find((candidate) => candidate.id === id);
  if (!node) {
    return null;
  }
  const edges = model.edges ?? [];
  // One row per file, not per recorded edge: a call edge sits beside its import, and a file
  // may be imported on several lines. Counting edges would report references as importers,
  // so a count could outrun the distinct-file blast radius it is meant to sit under. A
  // `declare` edge (a barrel re-export) is left out, matching the server's use-edge metrics.
  const imports = distinctByFile(
    edges.filter((edge) => edge.source === id).map((edge) => edgeEntry(edge.target, edge)),
  );
  const usedBy = distinctByFile(
    edges.filter((edge) => edge.target === id).map((edge) => edgeEntry(edge.source, edge)),
  );

  const metrics = [{ label: 'Direct importers', value: usedBy.length, unit: 'files' }];
  if (typeof node.systemUnit === 'string' && !node.id.endsWith('#support')) {
    // L17: at L1 the blast radius reports the in-unit count first, the outside count apart.
    metrics.push(
      { label: 'Blast radius in unit', value: node.inUnitDependents ?? 0 },
      { label: 'Blast radius outside', value: node.outsideDependents ?? 0 },
    );
  } else {
    metrics.push({ label: 'Blast radius', value: node.transitiveDependents ?? 0, unit: 'files' });
  }
  metrics.push(
    { label: 'Direct imports', value: imports.length, unit: 'files' },
    { label: 'Depends on (all)', value: node.transitiveDependencies ?? 0, unit: 'files' },
  );
  if (typeof node.lines === 'number') {
    metrics.push({ label: 'Lines', value: node.lines });
  }
  // A System-view unit carries its component and shelf counts where a file carries none.
  if (typeof node.files === 'number') {
    metrics.push({ label: 'Files', value: node.files });
  }
  if (typeof node.periphery === 'number' && node.periphery > 0) {
    metrics.push({ label: 'Support files', value: node.periphery });
  }
  // A unit card carries facts a file does not: its size, layers, reach, and coupling (L22).
  const card = node.kind === 'unit' ? (model.unitCards ?? []).find((entry) => entry.id === node.id) : undefined;
  if (card) {
    metrics.push(
      { label: 'Lines', value: card.loc },
      { label: 'Layers', value: card.layers.length },
      { label: 'Test reach', value: `${card.testReach.reached}/${card.testReach.total}` },
      { label: 'Depends on units', value: card.dependsOn },
      { label: 'Used by units', value: card.usedBy },
    );
    if (card.coverage) {
      const { value, linesHit, linesFound, notInReport } = card.coverage;
      metrics.push({
        label: 'Measured coverage',
        value: value === null ? 'no line counts' : `${value}% (${linesHit}/${linesFound} lines)`,
      });
      if (notInReport > 0) {
        metrics.push({ label: 'Not in report', value: notInReport });
      }
    }
    if (card.hotspots !== null) {
      metrics.push({ label: 'Hotspots', value: card.hotspots });
    }
  }
  if (node.shelf) {
    metrics.push({ label: 'Tests', value: node.shelf.test }, { label: 'Scripts', value: node.shelf.script });
  }

  return {
    id: node.id,
    kind: node.kind,
    // The "why grouped" caption a System-view unit carries; absent on file nodes.
    why: node.why,
    metrics,
    imports,
    usedBy,
  };
}

/** One dependency row: the neighbour file plus the edge's recorded evidence. */
function edgeEntry(id, edge) {
  return {
    id,
    line: edge.evidence?.line,
    specifier: edge.evidence?.specifier,
    role: edge.role,
  };
}

/**
 * Collapse dependency rows to one per file, over use edges only.
 *
 * `declare` edges (a barrel re-export) describe the module tree rather than a dependency,
 * so they are left out to keep the rows and the counts on the same footing as blast radius.
 */
function distinctByFile(entries) {
  const byFile = new Map();
  for (const entry of entries) {
    if (entry.role === 'declare' || byFile.has(entry.id)) {
      continue;
    }
    byFile.set(entry.id, entry);
  }
  return [...byFile.values()];
}

/**
 * The "Changes with" partners for one file, from an `/analysis/co-change` report.
 *
 * Only edges with a listable commit are returned, heavy pairs first, and every partner
 * carries the exact commits behind it. A pair outside the report yields an empty list, so
 * the passport can say so rather than showing an invented relationship.
 */
export function coChangePartnersFor(report, file, limit = 20) {
  const edges = (report?.edges ?? []).filter(
    (edge) =>
      (edge.source === file || edge.target === file) &&
      Array.isArray(edge.commits) &&
      edge.commits.length > 0,
  );
  return edges
    .sort(
      (a, b) =>
        (b.commitsShared ?? 0) - (a.commitsShared ?? 0) ||
        (a.source === file ? a.target : a.source).localeCompare(
          b.source === file ? b.target : b.source,
        ),
    )
    .slice(0, limit)
    .map((edge) => ({
      file: edge.source === file ? edge.target : edge.source,
      hidden: edge.hidden === true,
      ratio: edge.ratio,
      commitsShared: edge.commitsShared ?? edge.commits.length,
      commits: edge.commits,
    }));
}

/** Text for a unit's hover card: unit vocabulary, no blast radius, no `#` ids (L20). */
export function unitHoverFacts(model, id) {
  const card = (model?.unitCards ?? []).find((entry) => entry.id === id);
  if (!card) {
    return null;
  }
  return {
    title: `${card.ecosystem} package \`${card.name}\``,
    rows: [
      `${card.files} files`,
      `depends on ${card.dependsOn} unit${card.dependsOn === 1 ? '' : 's'}`,
      `used by ${card.usedBy} unit${card.usedBy === 1 ? '' : 's'}`,
      `why: ${card.manifest ?? card.why}`,
    ],
  };
}

/** A shelf's hover card: "74 test files, 6 scripts: folded support" (L20). */
export function shelfHoverText(shelf) {
  if (!shelf) {
    return 'support files';
  }
  const tests = `${shelf.test} test file${shelf.test === 1 ? '' : 's'}`;
  const scripts = `${shelf.script} script${shelf.script === 1 ? '' : 's'}`;
  return `${tests}, ${scripts}: folded support`;
}

/** The shelf footer strip caption; empty when the unit folds no support (L21). */
export function shelfStripText(shelf) {
  if (!shelf || shelf.total === 0) {
    return '';
  }
  const parts = [];
  if (shelf.test) parts.push(`${shelf.test} test${shelf.test === 1 ? '' : 's'}`);
  if (shelf.script) parts.push(`${shelf.script} script${shelf.script === 1 ? '' : 's'}`);
  if (shelf.generated) parts.push(`${shelf.generated} generated`);
  if (shelf.fixture) parts.push(`${shelf.fixture} fixture${shelf.fixture === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/**
 * Fill each card's hotspot count from the function hotspot report (L22).
 *
 * Hotspots need the function analysis, so the server leaves them null; the browser joins
 * the report it already fetches for the hotspot overlay. A hotspot belongs to the longest
 * unit id that prefixes its file (the root unit `.` is the fallback).
 */
export function withUnitHotspots(cards, report) {
  const list = cards ?? [];
  const byPrefix = list.map((card) => card.id).sort((a, b) => b.length - a.length);
  const counts = new Map(list.map((card) => [card.id, 0]));
  for (const spot of report?.hotspots ?? []) {
    const owner = byPrefix.find(
      (id) => id === '.' || spot.file === id || spot.file.startsWith(`${id}/`),
    );
    if (owner !== undefined) {
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
  }
  return list.map((card) => ({ ...card, hotspots: counts.get(card.id) ?? 0 }));
}

/**
 * Why an edge exists, from the evidence the scanner recorded.
 *
 * Returns null for an unknown id so the caller can stay silent instead of inventing an
 * explanation. `resolution` is rendered as a human label, never re-derived.
 */
export function edgeEvidenceFor(model, edgeId) {
  const edge = (model.edges ?? []).find((candidate, index) => `e${index}` === edgeId);
  if (!edge) {
    return null;
  }
  const evidence = edge.evidence ?? {};
  return {
    id: edgeId,
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    line: evidence.line ?? null,
    specifier: evidence.specifier ?? null,
    resolution: evidence.resolution ?? null,
    resolutionLabel: RESOLUTION_LABELS[evidence.resolution] ?? 'not recorded',
    provenance: graphProvenanceFromModel(model),
  };
}

/**
 * The fingerprint and scan time behind a served graph, read from the model's cache metadata.
 *
 * The graph route carries `cache.fingerprint`, `cache.generatedAt`, and `cache.stale`; an
 * absent fingerprint yields null rather than an invented revision (T6).
 */
export function graphProvenanceFromModel(model) {
  const cache = model?.cache;
  if (!cache || !cache.fingerprint) {
    return null;
  }
  return {
    fingerprint: cache.fingerprint,
    revision: String(cache.fingerprint).split(':')[0] || null,
    scannedAt: cache.generatedAt ?? null,
    currentFingerprint: null,
    behind: null,
    stale: cache.stale === true,
  };
}

const RESOLUTION_LABELS = {
  exact: 'exact match',
  extension: 'extension added',
  index: 'index file',
  'index-of-package': 'package member',
  'module-tree': 'module tree',
  'index-packed': 'packed index',
  alias: 'path alias',
  root: 'repo root',
  'subpath-import': 'package subpath',
};
