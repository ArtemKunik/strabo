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
import { buildTierIntent } from './intent.ts';
import {
  TIER_ORDER,
  TIER_RANK,
  type TableTraceEntry,
  type Tier,
  type TierCallSite,
  type TierClassification,
  type TierDirection,
  type TierEndpointSite,
  type TierFlow,
  type TierFlowEdge,
  type TierFlowImport,
  type TierGrid,
  type TierGridCell,
  type TierGridEdge,
  type TierMatrixCell,
  type TierReport,
  type TierShelfEntry,
  type TierSpine,
  type TierSpineHop,
  type TierTableLineage,
  type TierTrace,
  type TierUnitReport,
} from './types.ts';

/** Bound on files read for classification, so a huge repository cannot stall the request. */
export const MAX_TIER_FILES = 2000;

/** Imports kept per tier-flow edge as evidence; the weight still counts every one. */
export const TIER_FLOW_SAMPLE_LIMIT = 50;

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
      typeOnly?: boolean;
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
    entry.unit = assignment.get(entry.file) ?? '.';
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
      // A mixed file keeps the tier the classifier pinned it to, but is counted apart so a
      // clean band is never inflated by a file that two tiers claim.
      mixed: matching.filter((entry) => entry.mixed).length,
      coverage: summariseFileCoverage(matching.map((entry) => entry.file), coverage),
    };
  }).filter((entry) => entry.files > 0);

  // The support shelf: tiers with no dependency rank cannot sit in the stack, so the drawing
  // keeps them beside it. Read from perTier so the counts can never disagree with the matrix.
  const shelf: TierShelfEntry[] = perTier
    .filter((entry) => TIER_RANK[entry.tier] === undefined)
    .map((entry) => ({
      tier: entry.tier,
      files: entry.files,
      lines: entry.lines,
      mixed: entry.mixed,
    }));

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

  // The structure the tier classification becomes: every recorded import collapsed across the
  // tiers, with the wrong-way reads kept as their own edges. Cross-unit edges are included —
  // unlike `directions`, which is scoped to one unit — and counted so a multi-unit picture can
  // style them apart. Shelf tiers and unclassified files are outside the layer order.
  const rankedPresent = TIER_ORDER.filter(
    (tier) => TIER_RANK[tier] !== undefined && files.some((entry) => entry.tier === tier),
  );
  const presentRanks = new Set(
    rankedPresent.map((tier) => TIER_RANK[tier]).filter((rank): rank is number => rank !== undefined),
  );
  const intraByTier = new Map<Tier, number>();
  const flowEdges = new Map<
    string,
    {
      source: Tier;
      target: Tier;
      kind: TierFlowEdge['kind'];
      weight: number;
      crossUnit: number;
      typeOnly: number;
      imports: TierFlowImport[];
      units: Set<string>;
    }
  >();
  let flowTotal = 0;
  let intraTotal = 0;
  for (const edge of graph.edges ?? []) {
    // A call edge parallels an import edge, so counting it would double the same tier pair.
    if (edge.kind === 'call') {
      continue;
    }
    const sourceTier = tierOfFile.get(edge.source);
    const targetTier = tierOfFile.get(edge.target);
    if (!sourceTier || !targetTier) {
      continue;
    }
    const sourceRank = TIER_RANK[sourceTier];
    const targetRank = TIER_RANK[targetTier];
    if (sourceRank === undefined || targetRank === undefined) {
      continue;
    }
    flowTotal += 1;
    if (sourceRank === targetRank) {
      intraTotal += 1;
      intraByTier.set(sourceTier, (intraByTier.get(sourceTier) ?? 0) + 1);
      continue;
    }
    const unit = assignment.get(edge.source) ?? '.';
    const targetUnit = assignment.get(edge.target) ?? '.';
    // A skip is only a skip when a ranked tier sits between the two; otherwise it reads as a
    // direct downward edge. The intermediate tiers are read repository-wide, not per unit.
    const kind: TierFlowEdge['kind'] =
      sourceRank < targetRank
        ? 'upward'
        : sourceRank - targetRank > 1 &&
            [...presentRanks].some((rank) => rank < sourceRank && rank > targetRank)
          ? 'skip-layer'
          : 'down';
    const key = `${sourceTier}\u0000${targetTier}\u0000${kind}`;
    const entry = flowEdges.get(key) ?? {
      source: sourceTier,
      target: targetTier,
      kind,
      weight: 0,
      crossUnit: 0,
      typeOnly: 0,
      imports: [] as TierFlowImport[],
      units: new Set<string>(),
    };
    entry.weight += 1;
    if (edge.typeOnly === true) {
      entry.typeOnly += 1;
    }
    if (entry.imports.length < TIER_FLOW_SAMPLE_LIMIT) {
      entry.imports.push({
        source: edge.source,
        target: edge.target,
        line: edge.evidence?.line ?? 0,
        specifier: edge.evidence?.specifier ?? '',
        ...(edge.typeOnly === true ? { typeOnly: true } : {}),
      });
    }
    entry.units.add(unit);
    if (unit !== targetUnit) {
      entry.crossUnit += 1;
    }
    flowEdges.set(key, entry);
  }
  const rankIndex = (tier: Tier): number => TIER_ORDER.indexOf(tier);
  const tierFlow: TierFlow = {
    tiers: rankedPresent,
    edges: [...flowEdges.values()]
      .map((entry) => ({
        source: entry.source,
        target: entry.target,
        kind: entry.kind,
        weight: entry.weight,
        crossUnit: entry.crossUnit,
        typeOnly: entry.typeOnly,
        imports: entry.imports.sort(
          (a, b) => a.source.localeCompare(b.source) || a.line - b.line || a.target.localeCompare(b.target),
        ),
        units: [...entry.units].sort(),
      }))
      .sort(
        (a, b) =>
          rankIndex(a.source) - rankIndex(b.source) ||
          rankIndex(a.target) - rankIndex(b.target) ||
          a.kind.localeCompare(b.kind),
      ),
    intraByTier: [...intraByTier.entries()]
      .map(([tier, weight]) => ({ tier, weight }))
      .sort((a, b) => rankIndex(a.tier) - rankIndex(b.tier)),
    total: flowTotal,
    intraRatio: flowTotal > 0 ? Number((intraTotal / flowTotal).toFixed(3)) : 0,
  };

  // The unit × tier grid (Y4): the tier matrix with adjacency. Columns are build units, rows
  // are ranked tiers, and every recorded edge between two cells is kept — cross-unit included,
  // since a monorepo's services frequently depend on each other. Cells without an edge simply
  // have none; a tier or unit with no files is not a cell.
  const unitName = new Map(units.map((unit) => [unit.id, unit.name]));
  const gridCell = (unit: string, tier: Tier): string => `${unit}|${tier}`;
  const rankedTiers = TIER_ORDER.filter(
    (tier) => TIER_RANK[tier] !== undefined && files.some((entry) => entry.tier === tier),
  );
  const rankedTierSet = new Set<Tier>(rankedTiers);
  const gridCells: TierGridCell[] = [];
  for (const unit of unitIds) {
    for (const tier of rankedTiers) {
      const cell = cellMap.get(`${unit}\u0000${tier}`);
      if (!cell) {
        continue;
      }
      gridCells.push({
        id: gridCell(unit, tier),
        unit,
        unitName: unitName.get(unit) ?? unit,
        tier,
        files: cell.files,
        lines: cell.lines,
        mixed: files.filter((entry) => cell.members.includes(entry.file) && entry.mixed).length,
        coverage: summariseFileCoverage(cell.members, coverage),
        members: [...cell.members].sort(),
      });
    }
  }

  const gridEdges = new Map<
    string,
    {
      sourceUnit: string;
      targetUnit: string;
      sourceTier: Tier;
      targetTier: Tier;
      kind: TierFlowEdge['kind'];
      weight: number;
      typeOnly: number;
      imports: TierFlowImport[];
    }
  >();
  for (const edge of graph.edges ?? []) {
    if (edge.kind === 'call') {
      continue;
    }
    const sourceTier = tierOfFile.get(edge.source);
    const targetTier = tierOfFile.get(edge.target);
    if (!sourceTier || !targetTier || !rankedTierSet.has(sourceTier) || !rankedTierSet.has(targetTier)) {
      continue;
    }
    const sourceUnit = assignment.get(edge.source) ?? '.';
    const targetUnit = assignment.get(edge.target) ?? '.';
    const sourceRank = TIER_RANK[sourceTier];
    const targetRank = TIER_RANK[targetTier];
    if (sourceRank === undefined || targetRank === undefined) {
      continue;
    }
    // The same kind rule as `tierFlow`, so the grid and the bands cannot disagree.
    const kind: TierFlowEdge['kind'] =
      sourceRank === targetRank
        ? 'down'
        : sourceRank < targetRank
          ? 'upward'
          : sourceRank - targetRank > 1 &&
              [...presentRanks].some((rank) => rank < sourceRank && rank > targetRank)
            ? 'skip-layer'
            : 'down';
    const key = `${gridCell(sourceUnit, sourceTier)}\u0000${gridCell(targetUnit, targetTier)}`;
    const entry = gridEdges.get(key) ?? {
      sourceUnit,
      targetUnit,
      sourceTier,
      targetTier,
      kind,
      weight: 0,
      typeOnly: 0,
      imports: [] as TierFlowImport[],
    };
    entry.weight += 1;
    // The same evidence the stack's edges carry, so a grid edge can list what flows along it.
    if (edge.typeOnly === true) {
      entry.typeOnly += 1;
    }
    if (entry.imports.length < TIER_FLOW_SAMPLE_LIMIT) {
      entry.imports.push({
        source: edge.source,
        target: edge.target,
        line: edge.evidence?.line ?? 0,
        specifier: edge.evidence?.specifier ?? '',
        ...(edge.typeOnly === true ? { typeOnly: true } : {}),
      });
    }
    gridEdges.set(key, entry);
  }
  const gridEdgeList: TierGridEdge[] = [...gridEdges.values()]
    .map((entry) => ({
      source: gridCell(entry.sourceUnit, entry.sourceTier),
      target: gridCell(entry.targetUnit, entry.targetTier),
      sourceUnit: entry.sourceUnit,
      targetUnit: entry.targetUnit,
      sourceTier: entry.sourceTier,
      targetTier: entry.targetTier,
      kind: entry.kind,
      weight: entry.weight,
      crossUnit: entry.sourceUnit !== entry.targetUnit,
      typeOnly: entry.typeOnly,
      imports: entry.imports.sort(
        (a, b) => a.source.localeCompare(b.source) || a.line - b.line || a.target.localeCompare(b.target),
      ),
    }))
    .sort(
      (a, b) =>
        rankIndex(a.sourceTier) - rankIndex(b.sourceTier) ||
        a.sourceUnit.localeCompare(b.sourceUnit) ||
        rankIndex(a.targetTier) - rankIndex(b.targetTier) ||
        a.targetUnit.localeCompare(b.targetUnit),
    );
  const gridCrossUnit = gridEdgeList.filter((edge) => edge.crossUnit).length;
  const grid: TierGrid = {
    units: unitIds.map((unit) => ({
      id: unit,
      name: unitName.get(unit) ?? unit,
      files: (byUnit.get(unit) ?? []).length,
    })),
    tiers: rankedTiers,
    cells: gridCells,
    edges: gridEdgeList,
    shelf,
    summary: {
      units: unitIds.length,
      tiers: rankedTiers.length,
      cells: gridCells.length,
      edges: gridEdgeList.length,
      crossUnitEdges: gridCrossUnit,
    },
  };

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
        ...(endpoint.operationId ? { operationId: endpoint.operationId } : {}),
        ...(endpoint.request ? { request: endpoint.request } : {}),
        ...(endpoint.response ? { response: endpoint.response } : {}),
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

  const spines = buildSpines(traces, tableTrace, files, graph.edges ?? [], assignment);
  const intent = buildTierIntent(root, files, tierFlow, graph.edges ?? [], assignment, grid);

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
    tierFlow,
    grid,
    shelf,
    tables,
    tableTrace,
    calls,
    endpoints,
    traces,
    spines,
    intent,
    summary: { ...summary, total: files.length, mixed },
    skipped,
    truncated: all.length - selected.length,
  };
}

/**
 * Build the behavioral end-to-end spines connecting call → endpoint → handler → table (Phase 35 Y6).
 *
 * Each declared route or recorded outbound call walks to its matching endpoint, domain handler,
 * and data table reference. Gaps stay as stubs rather than being fabricated.
 */
function buildSpines(
  traces: TierTrace[],
  tableTrace: TableTraceEntry[],
  files: TierClassification[],
  graphEdges: Array<{ source: string; target: string; kind?: string }>,
  assignment: Map<string, string>,
): TierSpine[] {
  const tierOf = new Map(files.map((e) => [e.file, e.tier]));
  const forward = new Map<string, string[]>();
  for (const edge of graphEdges) {
    if (edge.kind === 'call') continue;
    const targets = forward.get(edge.source) ?? [];
    targets.push(edge.target);
    forward.set(edge.source, targets);
  }

  const reachableFrom = (start: string): string[] => {
    const visited = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of forward.get(current) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    return [...visited];
  };

  const tableByFile = new Map<string, TableTraceEntry[]>();
  for (const entry of tableTrace) {
    const list = tableByFile.get(entry.file) ?? [];
    list.push(entry);
    tableByFile.set(entry.file, list);
  }

  return traces.map((trace) => {
    const { call, endpoint } = trace;
    const targetUnit = endpoint?.unit ?? call.unit;
    const reached = reachableFrom(call.file);
    const unitFiles = files.filter((f) => (assignment.get(f.file) ?? '.') === targetUnit);

    let handlerFile: string | null = null;
    let handlerTier: Tier | null = null;

    const reachedDomain = reached.find(
      (f) => (assignment.get(f) ?? '.') === targetUnit && tierOf.get(f) === 'domain',
    );
    const reachedApi = reached.find(
      (f) => (assignment.get(f) ?? '.') === targetUnit && tierOf.get(f) === 'api' && f !== call.file,
    );
    if (reachedDomain) {
      handlerFile = reachedDomain;
      handlerTier = 'domain';
    } else if (reachedApi) {
      handlerFile = reachedApi;
      handlerTier = 'api';
    } else {
      const domainCandidate = unitFiles.find((f) => f.tier === 'domain');
      const apiCandidate = unitFiles.find((f) => f.tier === 'api');
      if (domainCandidate) {
        handlerFile = domainCandidate.file;
        handlerTier = 'domain';
      } else if (apiCandidate) {
        handlerFile = apiCandidate.file;
        handlerTier = 'api';
      }
    }

    let matchedTable: TableTraceEntry | null = null;
    const pathToken = (call.path ?? endpoint?.path ?? '')
      .split('/')
      .filter(Boolean)
      .pop()
      ?.toLowerCase();

    const searchPool = handlerFile
      ? [handlerFile, ...reachableFrom(handlerFile)]
      : reached;

    for (const f of searchPool) {
      const entries = tableByFile.get(f);
      if (entries && entries.length > 0) {
        if (pathToken) {
          const nameMatch = entries.find(
            (e) => e.table.toLowerCase() === pathToken || pathToken.includes(e.table.toLowerCase()),
          );
          if (nameMatch) {
            matchedTable = nameMatch;
            break;
          }
        }
        if (!matchedTable) {
          matchedTable = entries[0] ?? null;
        }
      }
    }

    if (!matchedTable && targetUnit) {
      const unitTables = tableTrace.filter((e) => e.unit === targetUnit);
      if (pathToken) {
        matchedTable =
          unitTables.find(
            (e) => e.table.toLowerCase() === pathToken || pathToken.includes(e.table.toLowerCase()),
          ) ?? null;
      }
      if (!matchedTable && unitTables.length > 0) {
        matchedTable = unitTables[0] ?? null;
      }
    }

    // Lineage: every recorded table the handler (or the call's own reach) can touch, so the
    // TABLE hop names the rest of the data it reaches instead of stopping at one table. The
    // matched table is kept even when it was chosen from the unit fallback, and is marked so
    // the drawing can lead with it.
    const lineage = collectTableLineage(searchPool, tableByFile);
    if (matchedTable && !lineage.some((entry) => sameTable(entry, matchedTable))) {
      lineage.push(tableLineageOf(matchedTable, false));
    }
    for (const entry of lineage) {
      entry.matched = matchedTable !== null && sameTable(entry, matchedTable);
    }
    lineage.sort(
      (a, b) =>
        Number(b.matched) - Number(a.matched) ||
        a.table.localeCompare(b.table) ||
        a.file.localeCompare(b.file) ||
        a.line - b.line,
    );

    const hops: TierSpineHop[] = [];

    // Hop 1: Call site
    hops.push({
      tier: call.tier,
      role: 'call',
      file: call.file,
      unit: call.unit,
      label: `${call.method ?? 'CALL'} ${call.path ?? call.target}`,
      detail: `${call.file}:${call.line}`,
      line: call.line,
    });

    // Hop 2: Endpoint
    if (endpoint) {
      hops.push({
        tier: endpoint.tier,
        role: 'endpoint',
        file: endpoint.file,
        unit: endpoint.unit,
        label: `${endpoint.method} ${endpoint.path}`,
        detail: endpoint.file,
      });
    }

    // Hop 3: Handler
    if (handlerFile && handlerTier) {
      hops.push({
        tier: handlerTier,
        role: 'handler',
        file: handlerFile,
        unit: targetUnit,
        label: handlerFile.split('/').pop() ?? handlerFile,
        detail: handlerFile,
      });
    }

    // Hop 4: Table
    if (matchedTable) {
      hops.push({
        tier: 'data',
        role: 'table',
        file: matchedTable.file,
        unit: matchedTable.unit,
        label: matchedTable.table,
        detail: `table "${matchedTable.table}" · ${matchedTable.evidence}`,
        line: matchedTable.line,
      });
    }

    const handler =
      handlerFile && handlerTier
        ? {
            file: handlerFile,
            tier: handlerTier,
            unit: targetUnit,
            label: handlerFile.split('/').pop() ?? handlerFile,
          }
        : null;

    return {
      id: `${call.file}:${call.line}->${endpoint ? `${endpoint.method} ${endpoint.path}` : 'stub'}->${matchedTable ? matchedTable.table : 'stub'}`,
      call,
      endpoint,
      handler,
      table: matchedTable,
      hops,
      lineage,
    };
  });
}

/** Every recorded table referenced by the files on the spine's downstream pool, deduped. */
function collectTableLineage(
  files: readonly string[],
  tableByFile: Map<string, TableTraceEntry[]>,
): TierTableLineage[] {
  const seen = new Set<string>();
  const lineage: TierTableLineage[] = [];
  for (const file of files) {
    for (const entry of tableByFile.get(file) ?? []) {
      const key = `${entry.table}\u0000${entry.file}\u0000${entry.line}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      lineage.push(tableLineageOf(entry, false));
    }
  }
  return lineage;
}

function tableLineageOf(entry: TableTraceEntry, matched: boolean): TierTableLineage {
  return {
    table: entry.table,
    file: entry.file,
    unit: entry.unit,
    line: entry.line,
    evidence: entry.evidence,
    matched,
  };
}

function sameTable(a: { table: string; file: string; line: number }, b: { table: string; file: string; line: number }): boolean {
  return a.table === b.table && a.file === b.file && a.line === b.line;
}
