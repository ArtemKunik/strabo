import { isSourceExtension } from '../../scan/scan.ts';
import type { Graph } from '../../types.ts';
import { extractCallsFromContent, extractServiceEndpoints } from '../../workspace/services.ts';
import { fileCoverage, summariseFileCoverage } from '../file-coverage.ts';
import type { MeasuredCoverageSummary } from '../measured-coverage.ts';
import { assignUnits, detectUnits } from '../units.ts';
import { classifyTierContent, classifyTiers } from './classify.ts';
import { readDeclaredTiers } from './declared.ts';
import { propagateTiers, unitRole } from './propagate.ts';
import { readText } from './read.ts';
import {
  TIER_ORDER,
  TIER_RANK,
  type TableTraceEntry,
  type Tier,
  type TierCallSite,
  type TierDirection,
  type TierEndpointSite,
  type TierMatrixCell,
  type TierReport,
  type TierTrace,
  type TierUnitReport,
} from './types.ts';

/** Bound on files read for classification, so a huge repository cannot stall the request. */
export const MAX_TIER_FILES = 2000;

function emptyTierCounts(): Record<Tier, number> {
  return {
    frontend: 0,
    api: 0,
    domain: 0,
    data: 0,
    integration: 0,
    infra: 0,
    build: 0,
    tests: 0,
    unclassified: 0,
  };
}

/** Classify a repository's files and roll the result up per build unit. */
export function buildTierReport(
  root: string,
  repositoryName: string,
  graph: {
    nodes: Array<{ id: string; kind?: string; directory?: string }>;
    edges?: Array<{
      source: string;
      target: string;
      kind?: string;
      evidence?: { line: number; specifier: string };
    }>;
  },
  measured: MeasuredCoverageSummary | null = null,
): TierReport {
  const all = graph.nodes.map((node) => node.id).sort();
  const selected = all.slice(0, MAX_TIER_FILES);
  const declared = readDeclaredTiers(root);
  const classified = classifyTiers(root, selected, declared);
  const files = propagateTiers(classified.files, graph.edges ?? []);
  const { skipped } = classified;
  const tierOf = new Map(files.map((entry) => [entry.file, entry.tier]));
  // Every matrix cell and per-tier stat reads this one source instead of its own reach count.
  // The caller may pass a structural graph (tests do); normalise the edge list the helper walks.
  const coverage = fileCoverage(
    { nodes: graph.nodes, edges: graph.edges ?? [], diagnostics: [], excluded: [] } as unknown as Graph,
    measured,
  );

  const units = detectUnits(root, selected, repositoryName);
  // Endpoint documents (OpenAPI) are not graph nodes, but they still sit in a unit; assign
  // them alongside the nodes so a trace's endpoint carries a real unit.
  const endpointDocs = extractServiceEndpoints(root, repositoryName);
  const assignment = assignUnits(
    [...new Set([...selected, ...endpointDocs.map((endpoint) => endpoint.source)])],
    units,
  );
  const byUnit = new Map<string, string[]>();
  for (const file of selected) {
    const unit = assignment.get(file) ?? '.';
    byUnit.set(unit, [...(byUnit.get(unit) ?? []), file]);
  }

  const summary = emptyTierCounts();
  let mixed = 0;
  for (const entry of files) {
    summary[entry.tier] += 1;
    if (entry.mixed) {
      mixed += 1;
    }
  }

  const unitReports: TierUnitReport[] = units
    .map((unit) => {
      const members = byUnit.get(unit.id) ?? [];
      const tiers = emptyTierCounts();
      for (const file of members) {
        tiers[tierOf.get(file) ?? 'unclassified'] += 1;
      }
      const role = unitRole(unit, members, (file) => tierOf.get(file) ?? 'unclassified');
      return {
        id: unit.id,
        name: unit.name,
        role: role.role,
        roleEvidence: role.evidence,
        files: members.length,
        tiers,
      };
    })
    .filter((unit) => unit.files > 0);

  const unitIds = [...new Set(selected.map((file) => assignment.get(file) ?? '.'))].sort();
  const cellMap = new Map<string, { files: number; lines: number; members: string[] }>();
  const unitTiers = new Map<string, Set<Tier>>();
  for (const entry of files) {
    const unit = assignment.get(entry.file) ?? '.';
    const key = `${unit}\u0000${entry.tier}`;
    const cell = cellMap.get(key) ?? { files: 0, lines: 0, members: [] };
    cell.files += 1;
    cell.lines += entry.lines;
    cell.members.push(entry.file);
    cellMap.set(key, cell);
    const tiers = unitTiers.get(unit) ?? new Set<Tier>();
    tiers.add(entry.tier);
    unitTiers.set(unit, tiers);
  }

  const cells: TierMatrixCell[] = [];
  for (const tier of TIER_ORDER) {
    for (const unit of unitIds) {
      const cell = cellMap.get(`${unit}\u0000${tier}`);
      if (cell) {
        cells.push({
          unit,
          tier,
          files: cell.files,
          lines: cell.lines,
          coverage: summariseFileCoverage(cell.members, coverage),
        });
      }
    }
  }
  const perTier = TIER_ORDER.map((tier) => {
    const matching = files.filter((entry) => entry.tier === tier);
    return {
      tier,
      files: matching.length,
      lines: matching.reduce((total, entry) => total + entry.lines, 0),
      fileShare: files.length > 0 ? Number((matching.length / files.length).toFixed(3)) : 0,
      coverage: summariseFileCoverage(matching.map((entry) => entry.file), coverage),
    };
  }).filter((entry) => entry.files > 0);

  const tierOfFile = new Map(files.map((entry) => [entry.file, entry.tier]));
  const directions: TierDirection[] = [];
  for (const edge of graph.edges ?? []) {
    // A call edge parallels an import edge, so counting it would double a wrong-way pair.
    if (edge.kind === 'call') {
      continue;
    }
    const sourceTier = tierOfFile.get(edge.source);
    const targetTier = tierOfFile.get(edge.target);
    if (!sourceTier || !targetTier) {
      continue;
    }
    const unit = assignment.get(edge.source) ?? '.';
    if ((assignment.get(edge.target) ?? '.') !== unit) {
      continue;
    }
    const sourceRank = TIER_RANK[sourceTier];
    const targetRank = TIER_RANK[targetTier];
    if (sourceRank === undefined || targetRank === undefined) {
      continue;
    }
    const base = {
      unit,
      source: edge.source,
      target: edge.target,
      sourceTier,
      targetTier,
      line: edge.evidence?.line ?? 0,
      specifier: edge.evidence?.specifier ?? '',
    };
    if (sourceRank < targetRank) {
      // A lower tier depends on an upper one: the arrow runs the wrong way.
      directions.push({ ...base, kind: 'upward' });
    } else if (sourceRank - targetRank > 1) {
      const intermediate = [...(unitTiers.get(unit) ?? [])].some((tier) => {
        const rank = TIER_RANK[tier];
        return rank !== undefined && rank < sourceRank && rank > targetRank;
      });
      // A skip is only a violation when the unit actually has a tier in between to use.
      if (intermediate) {
        directions.push({ ...base, kind: 'skip-layer' });
      }
    }
  }
  directions.sort(
    (a, b) => a.unit.localeCompare(b.unit) || a.line - b.line || a.source.localeCompare(b.source),
  );

  const tables = files
    .flatMap((entry) => entry.tables)
    .sort(
      (a, b) => a.table.localeCompare(b.table) || a.file.localeCompare(b.file) || a.line - b.line,
    );

  const tableTrace: TableTraceEntry[] = files
    .flatMap((entry) =>
      entry.tables.map((reference) => ({
        table: reference.table,
        file: entry.file,
        tier: entry.tier,
        unit: assignment.get(entry.file) ?? '.',
        line: reference.line,
        evidence: reference.evidence,
      })),
    )
    .sort(
      (a, b) => a.table.localeCompare(b.table) || a.file.localeCompare(b.file) || a.line - b.line,
    );

  // The top half of the trace. Calls are read from the files just classified (a second read,
  // bounded by the ceiling); endpoints come from the repository's OpenAPI documents, which are
  // not graph nodes, so their tier is classified from disk.
  const selectedSet = new Set(selected);
  const calls: TierCallSite[] = [];
  for (const file of selected) {
    if (!isSourceExtension(file)) {
      continue;
    }
    const content = readText(root, file);
    if (content === null) {
      continue;
    }
    for (const call of extractCallsFromContent(file, content)) {
      calls.push({
        file,
        tier: tierOfFile.get(file) ?? 'unclassified',
        unit: assignment.get(file) ?? '.',
        line: call.line,
        method: call.method,
        target: call.target,
        host: call.host,
        path: call.path,
      });
    }
  }
  calls.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.target.localeCompare(b.target),
  );

  const endpoints: TierEndpointSite[] = endpointDocs
    .map((endpoint) => {
      let tier = tierOfFile.get(endpoint.source) ?? 'unclassified';
      if (!selectedSet.has(endpoint.source)) {
        const content = readText(root, endpoint.source);
        if (content !== null) {
          tier = classifyTierContent(endpoint.source, content, declared).tier;
        }
      }
      return {
        file: endpoint.source,
        tier,
        unit: assignment.get(endpoint.source) ?? '.',
        method: endpoint.method,
        path: endpoint.path,
      };
    })
    .sort(
      (a, b) =>
        a.file.localeCompare(b.file) || a.method.localeCompare(b.method) || a.path.localeCompare(b.path),
    );

  const endpointByKey = new Map<string, TierEndpointSite>();
  for (const endpoint of endpoints) {
    const key = `${endpoint.method}\u0000${endpoint.path}`;
    if (!endpointByKey.has(key)) {
      endpointByKey.set(key, endpoint);
    }
  }
  const traces: TierTrace[] = calls.map((call) => ({
    call,
    endpoint:
      call.method && call.path ? endpointByKey.get(`${call.method}\u0000${call.path}`) ?? null : null,
  }));

  return {
    files,
    units: unitReports,
    matrix: {
      tiers: TIER_ORDER,
      units: unitIds,
      cells,
      perTier,
      coverage: summariseFileCoverage(files.map((entry) => entry.file), coverage),
    },
    directions,
    tables,
    tableTrace,
    calls,
    endpoints,
    traces,
    summary: { ...summary, total: files.length, mixed },
    skipped,
    truncated: all.length - selected.length,
  };
}
