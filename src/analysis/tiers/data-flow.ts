import type { DataEdge, DataReport, DataStrength, DatasetKind, DatasetNode } from '../../types.ts';
import type { Tier, TierReport } from './types.ts';

/**
 * The data-flow reading of the Structure view (Phase 37).
 *
 * The Structure view draws recorded imports rolled up by role tier. This module reads the
 * *other* graph Strabo records — the Data layer (Phase 33) — and routes it through the same
 * tiers: a file's `reads`/`writes` edge becomes a tier → data hub (or hub → tier) edge, and a
 * dataset-to-dataset lineage edge becomes a hub → hub edge. Nothing is inferred from a name:
 * a hub exists because a recorded edge names it, and a flow edge exists because a classified
 * file records the access. A file with no tier is a diagnostic, never a fabricated band.
 */

export type TierFlowKind = 'reads' | 'writes' | 'produces' | 'consumes' | 'derives';

export type TierGovernance = 'conforming' | 'drifting' | 'unverified';

/** One recorded place a file touches a hub, kept for the edge panel. */
export interface TierDataFlowEvidence {
  file: string;
  line: number;
  detail: string;
}

/** A data hub the stack routes through: a table, view, topic, queue, path, or API resource. */
export interface TierDataHub {
  /** The Data layer's own id: `db:<repo>/<table>`, `topic:<name>`, `path:<literal>`. */
  id: string;
  kind: DatasetKind;
  label: string;
  repository: string | null;
  strength: DataStrength;
  /** The role tiers whose files touch this hub, most to least recorded access. */
  tiers: Tier[];
  /** A contract governs the hub through a recorded `governs` edge. */
  governed: boolean;
  /** The hub's contract health, when it is governed. */
  conformance?: TierGovernance;
}

/**
 * One drawn flow edge: `writes`/`produces` run tier → hub, `reads`/`consumes` run hub → tier,
 * and `derives` runs hub → hub. `tier` is null for a pure lineage edge, which has no file.
 */
export interface TierDataFlowEdge {
  /** Stable id: `<source>|<direction>|<target>`. */
  id: string;
  tier: Tier | null;
  hub: string;
  direction: TierFlowKind;
  source: string;
  target: string;
  strength: DataStrength;
  governed: boolean;
  conformance?: TierGovernance;
  evidence: TierDataFlowEvidence[];
}

/** A writer tier and a reader tier joined through one hub, for the panel and summary. */
export interface TierDataFlowPair {
  source: Tier;
  target: Tier;
  hub: string;
  hubLabel: string;
  governed: boolean;
}

export type TierDataFlowDiagnosticKind = 'unclassified-file' | 'truncated';

/** A fact the reading could not turn into an edge, named rather than dropped silently. */
export interface TierDataFlowDiagnostic {
  kind: TierDataFlowDiagnosticKind;
  detail: string;
}

export interface TierDataFlowSummary {
  hubs: number;
  reads: number;
  writes: number;
  flowEdges: number;
  /** Writer tier and reader tier that differ, joined through a hub. */
  crossTier: number;
  governed: number;
  /** Hubs with a writer and a reader tier and no governing contract. */
  uncontracted: number;
  /** Files that record a data use but have no tier evidence, so no band could be drawn. */
  unclassified: number;
}

export interface TierDataFlow {
  repository: string;
  hubs: TierDataHub[];
  edges: TierDataFlowEdge[];
  /** Cross-tier writer → reader pairs through a hub, most actionable first. */
  pairs: TierDataFlowPair[];
  summary: TierDataFlowSummary;
  diagnostics: TierDataFlowDiagnostic[];
  /** Sections the caller could not assemble, named rather than shown empty. */
  unavailable: string[];
}

const MAX_HUB_EVIDENCE = 50;
const MAX_HUBS = 200;
const MAX_DIAGNOSTICS = 20;

/** The bare name a reader recognises from a qualified dataset id. */
export function hubLabelOf(id: string): string {
  const withoutScheme = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  const slash = withoutScheme.lastIndexOf('/');
  return slash >= 0 ? withoutScheme.slice(slash + 1) : withoutScheme;
}

/**
 * Compose the data-flow reading from the tier report and the repository's Data layer.
 *
 * Pure over its inputs so a unit test can hand it fixtures. The tier report says what role
 * each file plays; the Data layer says what each file reads and writes and which datasets
 * lineage connects. A dataset nothing classified touches is not a hub, and a file with a data
 * use but no tier is a diagnostic.
 */
export function buildTierDataFlow(
  report: TierReport,
  data: DataReport,
  options: { repository?: string } = {},
): TierDataFlow {
  const tierOf = new Map<string, Tier>();
  for (const file of report.files) {
    tierOf.set(file.file, file.tier);
  }

  const datasetById = new Map<string, DatasetNode>();
  for (const dataset of data.datasets) {
    datasetById.set(dataset.id, dataset);
  }

  // Governance is read from the Data layer's own contracts, never guessed from the hub name:
  // a recorded `governs` edge, and a conformance finding keyed by dataset id.
  const governed = new Set<string>();
  for (const edge of data.edges) {
    if (edge.kind === 'governs') {
      governed.add(edge.target);
    }
  }
  const drifting = new Set<string>();
  for (const finding of data.conformance) {
    if (finding.dataset) {
      drifting.add(finding.dataset);
    }
  }

  const hubMap = new Map<string, TierDataHub>();
  const edgeMap = new Map<string, TierDataFlowEdge>();
  const unclassified = new Set<string>();

  const hubFor = (id: string): TierDataHub => {
    const existing = hubMap.get(id);
    if (existing) {
      return existing;
    }
    const dataset = datasetById.get(id);
    const isGoverned = governed.has(id);
    const hub: TierDataHub = {
      id,
      kind: dataset?.kind ?? 'table',
      label: dataset?.label ?? hubLabelOf(id),
      repository: dataset?.repository ?? null,
      strength: dataset?.strength ?? 'weak',
      tiers: [],
      governed: isGoverned,
      ...(isGoverned ? { conformance: drifting.has(id) ? 'drifting' : 'conforming' } : {}),
    };
    hubMap.set(id, hub);
    return hub;
  };

  const noteTier = (hub: TierDataHub, tier: Tier): void => {
    if (!hub.tiers.includes(tier)) {
      hub.tiers.push(tier);
    }
  };

  const pushEdge = (edge: TierDataFlowEdge, item: TierDataFlowEvidence): void => {
    const key = `${edge.source}\u0000${edge.direction}\u0000${edge.target}`;
    const existing = edgeMap.get(key);
    if (existing) {
      if (existing.evidence.length < MAX_HUB_EVIDENCE) {
        existing.evidence.push(item);
      }
      return;
    }
    edgeMap.set(key, { ...edge, evidence: [item] });
  };

  const evidenceOf = (edge: DataEdge, detail: string): TierDataFlowEvidence => ({
    file: edge.evidence?.file ?? edge.source,
    line: edge.evidence?.line ?? 0,
    detail: edge.detail ? `${detail} · ${edge.detail}` : detail,
  });

  for (const edge of data.edges) {
    if (edge.kind === 'reads' || edge.kind === 'writes') {
      const tier = tierOf.get(edge.source);
      if (!tier) {
        unclassified.add(edge.source);
        continue;
      }
      const hub = hubFor(edge.target);
      noteTier(hub, tier);
      const isTopic = hub.kind === 'topic' || hub.kind === 'queue';
      const direction: TierFlowKind = isTopic ? (edge.kind === 'writes' ? 'produces' : 'consumes') : edge.kind;
      const source = edge.kind === 'writes' ? tier : hub.id;
      const target = edge.kind === 'writes' ? hub.id : tier;
      pushEdge(
        {
          id: `${source}|${direction}|${target}`,
          tier,
          hub: hub.id,
          direction,
          source,
          target,
          strength: edge.strength,
          governed: hub.governed,
          ...(hub.conformance ? { conformance: hub.conformance } : {}),
          evidence: [],
        },
        evidenceOf(edge, `${direction} ${hub.label}`),
      );
    }
  }

  // Lineage: a dataset-to-dataset edge the Data layer recorded (SQL, views, dbt). It has no
  // file of its own, so it is a hub → hub edge with no tier.
  for (const lineage of data.lineage) {
    const sourceHub = hubFor(lineage.source);
    const targetHub = hubFor(lineage.target);
    pushEdge(
      {
        id: `${sourceHub.id}|derives|${targetHub.id}`,
        tier: null,
        hub: targetHub.id,
        direction: 'derives',
        source: sourceHub.id,
        target: targetHub.id,
        strength: lineage.strength,
        governed: targetHub.governed,
        ...(targetHub.conformance ? { conformance: targetHub.conformance } : {}),
        evidence: [],
      },
      { file: lineage.evidence.file, line: lineage.evidence.line, detail: lineage.detail },
    );
  }

  // Cap the hub list, busiest first, so a large schema cannot flood the stack. Dropped hubs
  // and their edges are named in a diagnostic, never silently lost.
  const allHubs = [...hubMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  const keptHubs = allHubs.slice(0, MAX_HUBS);
  const keptIds = new Set(keptHubs.map((hub) => hub.id));
  const droppedHubs = allHubs.length - keptHubs.length;

  for (const hub of keptHubs) {
    hub.tiers.sort((a, b) => a.localeCompare(b));
  }

  const edges = [...edgeMap.values()]
    .filter((edge) => keptIds.has(edge.hub) && (edge.direction !== 'derives' || keptIds.has(edge.source)))
    .sort((a, b) => a.source.localeCompare(b.source) || a.direction.localeCompare(b.direction) || a.target.localeCompare(b.target));

  const pairs: TierDataFlowPair[] = [];
  const byHub = new Map<string, TierDataFlowEdge[]>();
  for (const edge of edges) {
    if (edge.direction === 'derives' || edge.tier === null) {
      continue;
    }
    const list = byHub.get(edge.hub) ?? [];
    list.push(edge);
    byHub.set(edge.hub, list);
  }
  for (const [hubId, hubEdges] of byHub) {
    const writers = [...new Set(hubEdges.filter((edge) => edge.direction === 'writes' || edge.direction === 'produces').map((edge) => edge.tier as Tier))];
    const readers = [...new Set(hubEdges.filter((edge) => edge.direction === 'reads' || edge.direction === 'consumes').map((edge) => edge.tier as Tier))];
    const hub = hubMap.get(hubId);
    for (const source of writers) {
      for (const target of readers) {
        if (source === target) {
          continue;
        }
        pairs.push({ source, target, hub: hubId, hubLabel: hub?.label ?? hubLabelOf(hubId), governed: hub?.governed ?? false });
      }
    }
  }
  pairs.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.hub.localeCompare(b.hub));

  const diagnostics: TierDataFlowDiagnostic[] = [];
  if (unclassified.size > 0) {
    const sample = [...unclassified].sort().slice(0, 3).join(', ');
    diagnostics.push({
      kind: 'unclassified-file',
      detail: `${unclassified.size} file(s) record a data use but have no tier evidence (${sample}${unclassified.size > 3 ? ', …' : ''}); they are not drawn on a band.`,
    });
  }
  if (droppedHubs > 0) {
    diagnostics.push({
      kind: 'truncated',
      detail: `${droppedHubs} more hub(s) are not drawn; the stack keeps the first ${MAX_HUBS}.`,
    });
  }

  const reads = edges.filter((edge) => edge.direction === 'reads' || edge.direction === 'consumes').length;
  const writes = edges.filter((edge) => edge.direction === 'writes' || edge.direction === 'produces').length;
  const uncontracted = [...byHub.entries()].filter(([hubId, hubEdges]) => {
    if (hubMap.get(hubId)?.governed) {
      return false;
    }
    const hasWriter = hubEdges.some((edge) => edge.direction === 'writes' || edge.direction === 'produces');
    const hasReader = hubEdges.some((edge) => edge.direction === 'reads' || edge.direction === 'consumes');
    return hasWriter && hasReader;
  }).length;

  return {
    repository: options.repository ?? '',
    hubs: keptHubs,
    edges,
    pairs,
    summary: {
      hubs: keptHubs.length,
      reads,
      writes,
      flowEdges: edges.length,
      crossTier: pairs.length,
      governed: keptHubs.filter((hub) => hub.governed).length,
      uncontracted,
      unclassified: unclassified.size,
    },
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
    unavailable: [...data.unavailable],
  };
}
