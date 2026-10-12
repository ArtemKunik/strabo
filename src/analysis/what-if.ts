import type { Graph, GraphEdge } from '../types.ts';
import { buildAdjacency, reachableSize } from './analysis.ts';
import { computeCoverage } from './coverage.ts';
import { computeCycles, type CycleGroup } from './cycles.ts';
import { checkDeclaredRules, type DeclaredRule, type RuleViolation } from './rules.ts';
import type { StringEdgeReport } from './string-edges.ts';
import { tierDirections } from './tiers/report.ts';
import type { Tier, TierDirection } from './tiers/types.ts';
import { assignUnits, type SystemUnit } from './units.ts';

/**
 * The what-if sandbox: apply hypothetical edits to a copy of the recorded graph and report
 * what the edited graph would record that the real one does not.
 *
 * Three edits are understood. `cut` removes every recorded edge from one file to another, `add`
 * draws a new import edge between two scanned files, and `move` rewrites a file or directory
 * path prefix. Nothing is read from disk here: a moved file keeps the tier its content was
 * classified as, and only its unit is re-read from the new path. Every answer is labelled
 * hypothetical, and an edit that cannot apply is rejected with its reason, never guessed.
 */

export type WhatIfOperation =
  | { op: 'cut'; source: string; target: string }
  | { op: 'add'; source: string; target: string }
  | { op: 'move'; from: string; to: string };

export interface WhatIfApplied {
  operation: WhatIfOperation;
  /** Edges removed by a cut, or files rewritten by a move; 1 for an add. */
  count: number;
}

export interface WhatIfRejected {
  operation: unknown;
  reason: string;
}

export interface WhatIfReach {
  file: string;
  /** Transitive dependents before the edits (re-exports followed, as blast radius is). */
  before: number;
  after: number;
}

export interface WhatIfEdge {
  source: string;
  target: string;
  kind: string;
}

export interface WhatIfResult {
  hypothetical: true;
  applied: WhatIfApplied[];
  rejected: WhatIfRejected[];
  /** Files whose path a move rewrote, original → hypothetical. */
  moved: Array<{ from: string; to: string }>;
  edgesAdded: WhatIfEdge[];
  edgesRemoved: WhatIfEdge[];
  cyclesIntroduced: CycleGroup[];
  cyclesResolved: CycleGroup[];
  tiers: {
    available: boolean;
    reason?: string;
    introduced: TierDirection[];
    resolved: TierDirection[];
  };
  rules: {
    available: boolean;
    reason?: string;
    introduced: RuleViolation[];
    resolved: RuleViolation[];
  };
  /** Non-test files a test reaches today and would no longer reach. */
  newlyUnreached: string[];
  /** Blast radius of every file an edit touched, capped at `MAX_REACH_FILES`. */
  reach: WhatIfReach[];
  reachTruncated: number;
  counts: {
    edgesAdded: number;
    edgesRemoved: number;
    cyclesIntroduced: number;
    cyclesResolved: number;
    tierIntroduced: number;
    tierResolved: number;
    rulesIntroduced: number;
    rulesResolved: number;
    newlyUnreached: number;
  };
}

/** The recorded facts the sandbox reads beside the graph; each one is optional. */
export interface WhatIfContext {
  /** Each file's classified tier, from the tier report. Absent: tier checks are unavailable. */
  tierOf?: ReadonlyMap<string, Tier>;
  /** The detected build units; a moved file is re-assigned against them. */
  units?: readonly SystemUnit[];
  rules?: readonly DeclaredRule[];
  stringEdges?: StringEdgeReport | null;
}

/** Most operations one request may carry, so a request stays bounded. */
export const MAX_WHAT_IF_OPERATIONS = 100;
/** Most touched files whose blast radius is recomputed. */
export const MAX_REACH_FILES = 50;

/** The specifier a hypothetical edge carries as its evidence, so it is never read as recorded. */
export const WHAT_IF_SPECIFIER = '(what-if)';

/** Validate untrusted operations: well-formed ones are kept, the rest rejected with a reason. */
export function parseWhatIfOperations(input: unknown): { operations: WhatIfOperation[]; rejected: WhatIfRejected[] } {
  const operations: WhatIfOperation[] = [];
  const rejected: WhatIfRejected[] = [];
  if (!Array.isArray(input)) {
    return { operations, rejected: [{ operation: input, reason: 'operations must be an array' }] };
  }
  for (const entry of input.slice(0, MAX_WHAT_IF_OPERATIONS)) {
    const record = (entry ?? {}) as Record<string, unknown>;
    const text = (key: string): string =>
      typeof record[key] === 'string' ? normalisePath(record[key] as string) : '';
    if ((record.op === 'cut' || record.op === 'add') && text('source') && text('target')) {
      operations.push({ op: record.op, source: text('source'), target: text('target') });
    } else if (record.op === 'move' && text('from') && text('to')) {
      operations.push({ op: 'move', from: text('from'), to: text('to') });
    } else {
      rejected.push({
        operation: entry,
        reason: 'expected { op: "cut" | "add", source, target } or { op: "move", from, to }',
      });
    }
  }
  if (input.length > MAX_WHAT_IF_OPERATIONS) {
    rejected.push({
      operation: null,
      reason: `${input.length - MAX_WHAT_IF_OPERATIONS} operations past the limit of ${MAX_WHAT_IF_OPERATIONS} were not applied`,
    });
  }
  return { operations, rejected };
}

/**
 * Apply the operations in order to a copy of `graph` and compare the result with the graph as
 * recorded. Moves are compared path-for-path: the baseline is the recorded graph with only the
 * renames applied, so moving a directory reports what the move changes, not every edge it renamed.
 */
export function simulateWhatIf(
  graph: Graph,
  operations: readonly WhatIfOperation[],
  context: WhatIfContext = {},
): WhatIfResult {
  const rejected: WhatIfRejected[] = [];
  const applied: WhatIfApplied[] = [];

  // Current id → original id, so tiers, units, and rules can be read for the recorded file.
  const originalOf = new Map<string, string>(graph.nodes.map((node) => [node.id, node.id]));
  let edges: GraphEdge[] = graph.edges.map((edge) => ({ ...edge }));
  const renames = new Map<string, string>();

  for (const operation of operations) {
    if (operation.op === 'move') {
      const matched = [...originalOf.keys()].filter(
        (id) => id === operation.from || id.startsWith(`${operation.from}/`),
      );
      if (matched.length === 0) {
        rejected.push({ operation, reason: `no scanned file is at or under "${operation.from}"` });
        continue;
      }
      const rewrite = (id: string): string => `${operation.to}${id.slice(operation.from.length)}`;
      const moving = new Set(matched);
      const collision = matched
        .map(rewrite)
        .find((target) => originalOf.has(target) && !moving.has(target));
      if (collision !== undefined) {
        rejected.push({ operation, reason: `"${collision}" is already a scanned file` });
        continue;
      }
      const mapping = new Map(matched.map((id) => [id, rewrite(id)]));
      for (const [from, to] of mapping) {
        const original = originalOf.get(from) as string;
        originalOf.delete(from);
        originalOf.set(to, original);
        renames.set(original, to);
      }
      edges = edges.map((edge) => ({
        ...edge,
        source: mapping.get(edge.source) ?? edge.source,
        target: mapping.get(edge.target) ?? edge.target,
      }));
      applied.push({ operation, count: matched.length });
      continue;
    }

    const missing = [operation.source, operation.target].find((id) => !originalOf.has(id));
    if (missing !== undefined) {
      rejected.push({ operation, reason: `"${missing}" is not a scanned file` });
      continue;
    }
    if (operation.source === operation.target) {
      rejected.push({ operation, reason: 'source and target are the same file' });
      continue;
    }
    const joins = (edge: GraphEdge): boolean =>
      edge.source === operation.source && edge.target === operation.target;
    if (operation.op === 'cut') {
      const before = edges.length;
      edges = edges.filter((edge) => !joins(edge));
      if (edges.length === before) {
        rejected.push({ operation, reason: 'no recorded edge joins these files' });
        continue;
      }
      applied.push({ operation, count: before - edges.length });
    } else {
      if (edges.some((edge) => joins(edge) && edge.role !== 'declare')) {
        rejected.push({ operation, reason: 'a recorded edge already joins these files' });
        continue;
      }
      edges.push({
        source: operation.source,
        target: operation.target,
        kind: 'import',
        relationship: 'import',
        evidence: { line: 0, specifier: WHAT_IF_SPECIFIER, resolution: 'exact' },
      });
      applied.push({ operation, count: 1 });
    }
  }

  const renamed = (id: string): string => renames.get(id) ?? id;
  const before: Graph = {
    ...graph,
    nodes: graph.nodes.map((node) => ({ ...node, id: renamed(node.id) })),
    edges: graph.edges.map((edge) => ({ ...edge, source: renamed(edge.source), target: renamed(edge.target) })),
  };
  const after: Graph = { ...before, edges };

  const edgeDiff = diffEdges(before.edges, after.edges);
  const cycles = diffCycles(computeCycles(before), computeCycles(after));
  const tiers = diffTiers(before, after, originalOf, context);
  const rules = diffRules(graph, after, renamed, context);

  const afterIds = new Set(after.nodes.map((node) => node.id));
  const reachedAfter = new Set(computeCoverage(after).reached);
  const newlyUnreached = computeCoverage(before)
    .reached.filter((file) => afterIds.has(file) && !reachedAfter.has(file))
    .sort();

  const touched = new Set<string>();
  for (const { operation } of applied) {
    if (operation.op === 'move') continue;
    touched.add(operation.source);
    touched.add(operation.target);
  }
  // Edge endpoints first, so a large move cannot push the files an edge edit touched past the cap.
  const movedFiles = [...renames.values()].filter((id) => !touched.has(id)).sort();
  const touchedSorted = [...[...touched].sort(), ...movedFiles];
  const beforeBackward = buildAdjacency(before, { includeReExports: true }).backward;
  const afterBackward = buildAdjacency(after, { includeReExports: true }).backward;
  const reach = touchedSorted.slice(0, MAX_REACH_FILES).map((file) => ({
    file,
    before: reachableSize(file, beforeBackward),
    after: reachableSize(file, afterBackward),
  }));

  return {
    hypothetical: true,
    applied,
    rejected,
    moved: [...renames].map(([from, to]) => ({ from, to })).sort((a, b) => a.from.localeCompare(b.from)),
    ...edgeDiff,
    ...cycles,
    tiers,
    rules,
    newlyUnreached,
    reach,
    reachTruncated: Math.max(0, touchedSorted.length - MAX_REACH_FILES),
    counts: {
      edgesAdded: edgeDiff.edgesAdded.length,
      edgesRemoved: edgeDiff.edgesRemoved.length,
      cyclesIntroduced: cycles.cyclesIntroduced.length,
      cyclesResolved: cycles.cyclesResolved.length,
      tierIntroduced: tiers.introduced.length,
      tierResolved: tiers.resolved.length,
      rulesIntroduced: rules.introduced.length,
      rulesResolved: rules.resolved.length,
      newlyUnreached: newlyUnreached.length,
    },
  };
}

function diffEdges(
  before: readonly GraphEdge[],
  after: readonly GraphEdge[],
): { edgesAdded: WhatIfEdge[]; edgesRemoved: WhatIfEdge[] } {
  const key = (edge: WhatIfEdge): string => `${edge.source}\u0000${edge.target}\u0000${edge.kind}`;
  const toEdge = (edge: GraphEdge): WhatIfEdge => ({ source: edge.source, target: edge.target, kind: edge.kind });
  const beforeKeys = new Set(before.map((edge) => key(edge)));
  const afterKeys = new Set(after.map((edge) => key(edge)));
  // Two recorded edges of one kind between one pair (two import lines) read as one change.
  const unique = (list: WhatIfEdge[]): WhatIfEdge[] => [...new Map(list.map((edge) => [key(edge), edge])).values()];
  const compare = (a: WhatIfEdge, b: WhatIfEdge): number =>
    a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.kind.localeCompare(b.kind);
  return {
    edgesAdded: unique(after.filter((edge) => !beforeKeys.has(key(edge))).map(toEdge)).sort(compare),
    edgesRemoved: unique(before.filter((edge) => !afterKeys.has(key(edge))).map(toEdge)).sort(compare),
  };
}

function diffCycles(
  before: readonly CycleGroup[],
  after: readonly CycleGroup[],
): { cyclesIntroduced: CycleGroup[]; cyclesResolved: CycleGroup[] } {
  const key = (cycle: CycleGroup): string => cycle.members.join('\u0000');
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  return {
    cyclesIntroduced: after.filter((cycle) => !beforeKeys.has(key(cycle))),
    cyclesResolved: before.filter((cycle) => !afterKeys.has(key(cycle))),
  };
}

function diffTiers(
  before: Graph,
  after: Graph,
  originalOf: ReadonlyMap<string, string>,
  context: WhatIfContext,
): WhatIfResult['tiers'] {
  if (!context.tierOf) {
    return { available: false, reason: 'the tier lens was not available', introduced: [], resolved: [] };
  }
  const tierOf = new Map<string, Tier>();
  for (const [current, original] of originalOf) {
    const tier = context.tierOf.get(original);
    if (tier) tierOf.set(current, tier);
  }
  const units = context.units ?? [];
  const originalUnits = assignUnits([...originalOf.values()], units);
  const movedUnits = assignUnits([...originalOf.keys()], units);
  // The baseline keeps each file in the unit it is recorded in; only the edited side re-reads it.
  const unitBefore = (file: string): string => originalUnits.get(originalOf.get(file) ?? file) ?? '.';
  const unitAfter = (file: string): string => movedUnits.get(file) ?? '.';

  const key = (direction: TierDirection): string =>
    `${direction.source}\u0000${direction.target}\u0000${direction.kind}`;
  const beforeDirections = tierDirections(before.edges, tierOf, unitBefore);
  const afterDirections = tierDirections(after.edges, tierOf, unitAfter);
  const beforeKeys = new Set(beforeDirections.map(key));
  const afterKeys = new Set(afterDirections.map(key));
  return {
    available: true,
    introduced: afterDirections.filter((direction) => !beforeKeys.has(key(direction))),
    resolved: beforeDirections.filter((direction) => !afterKeys.has(key(direction))),
  };
}

function diffRules(
  recorded: Graph,
  after: Graph,
  renamed: (id: string) => string,
  context: WhatIfContext,
): WhatIfResult['rules'] {
  const rules = context.rules ?? [];
  if (rules.length === 0) {
    return { available: false, reason: 'no declared rules', introduced: [], resolved: [] };
  }
  const stringEdges = context.stringEdges ?? null;
  const beforeViolations = checkDeclaredRules(rules, recorded, { stringEdges }).violations.map((violation) => ({
    ...violation,
    edge: { ...violation.edge, source: renamed(violation.edge.source), target: renamed(violation.edge.target) },
  }));
  const afterViolations = checkDeclaredRules(rules, after, {
    stringEdges: stringEdges ? renameStringEdges(stringEdges, renamed) : null,
  }).violations;
  const key = (violation: RuleViolation): string =>
    [violation.rule, violation.edge.source, violation.edge.target, violation.edge.kind, violation.edge.specifier].join(
      '\u0000',
    );
  const beforeKeys = new Set(beforeViolations.map(key));
  const afterKeys = new Set(afterViolations.map(key));
  return {
    available: true,
    introduced: afterViolations.filter((violation) => !beforeKeys.has(key(violation))),
    resolved: beforeViolations.filter((violation) => !afterKeys.has(key(violation))),
  };
}

function renameStringEdges(report: StringEdgeReport, renamed: (id: string) => string): StringEdgeReport {
  const site = <T extends { file: string }>(entry: T): T => ({ ...entry, file: renamed(entry.file) });
  const edge = (entry: StringEdgeReport['env'][number]): StringEdgeReport['env'][number] => ({
    ...entry,
    readers: entry.readers.map(site),
    declarations: entry.declarations.map(site),
  });
  return { ...report, env: report.env.map(edge), routes: report.routes.map(edge), flags: report.flags.map(edge) };
}

function normalisePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}
