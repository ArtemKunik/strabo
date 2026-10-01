import { matchesGlob } from '../glob.ts';
import { readDeclaredRules, type DeclaredRule } from '../rules.ts';
import type {
  Tier,
  TierClassification,
  TierFlow,
  TierFlowEdge,
  TierFlowImport,
  TierGrid,
  TierGridEdge,
} from './types.ts';
import { tierRank } from './types.ts';

export interface TierIntentGhostEdge {
  source: Tier;
  target: Tier;
  ruleId: string;
  kind: TierFlowEdge['kind'];
  description: string;
}

export interface TierIntentGhostBand {
  tier: Tier;
  label: string;
  ruleId: string;
}

export interface TierIntentViolation {
  source: Tier;
  target: Tier;
  ruleId?: string;
  kind: 'upward' | 'skip-layer' | 'rule';
  detail: string;
}

export interface TierIntentReport {
  available: boolean;
  rules: DeclaredRule[];
  ghostEdges: TierIntentGhostEdge[];
  ghostBands: TierIntentGhostBand[];
  violations: TierIntentViolation[];
}

/**
 * Compare declared architecture rules (`strabo.rules.yml`) with observed tier flow (Phase 35 Y7).
 *
 * An operator states intended flows:
 * - `allow: import` declares an intended path. If no edge is observed, it becomes a ghost edge.
 * - `allow: never` declares a forbidden path. Any matching observed edge becomes a violation.
 * - Upward dependencies through the layer order remain layer violations.
 */
export function buildTierIntent(
  root: string,
  files: TierClassification[],
  tierFlow: TierFlow,
  graphEdges: Array<{ source: string; target: string; kind?: string }>,
  assignment: Map<string, string>,
  grid?: TierGrid,
): TierIntentReport {
  const rules = readDeclaredRules(root);
  const tierOfFile = new Map(files.map((f) => [f.file, f.tier]));
  const presentTiers = new Set(files.map((f) => f.tier));

  const ghostEdges: TierIntentGhostEdge[] = [];
  const ghostBands: TierIntentGhostBand[] = [];
  const violations: TierIntentViolation[] = [];

  // 1. Mark existing upward edges in tierFlow and grid as layer violations
  for (const edge of tierFlow.edges) {
    if (edge.kind === 'upward') {
      edge.violation = true;
      violations.push({
        source: edge.source,
        target: edge.target,
        kind: 'upward',
        detail: `${edge.source} depends on ${edge.target} (upward layer violation)`,
      });
    }
  }

  if (grid) {
    for (const edge of grid.edges) {
      if (edge.kind === 'upward') {
        edge.violation = true;
      }
    }
  }

  if (rules.length === 0) {
    return {
      available: false,
      rules: [],
      ghostEdges: [],
      ghostBands: [],
      violations,
    };
  }

  const fileMatches = (file: string, tier: Tier, pattern: string): boolean => {
    if (pattern.startsWith('tier:')) {
      return tier === pattern.slice(5);
    }
    return matchesGlob(file, pattern);
  };

  const inferTierFromPattern = (pattern: string): Tier | null => {
    if (pattern.startsWith('tier:')) {
      return pattern.slice(5) as Tier;
    }
    for (const t of ['frontend', 'api', 'domain', 'integration', 'data', 'infra', 'build', 'tests'] as Tier[]) {
      if (pattern.includes(`/${t}/`) || pattern.endsWith(`/${t}/**`) || pattern.endsWith(`/${t}/*`)) {
        return t;
      }
    }
    return null;
  };

  for (const rule of rules) {
    const fromFiles = files.filter((f) => fileMatches(f.file, f.tier, rule.from));
    const toFiles = files.filter((f) => fileMatches(f.file, f.tier, rule.to));

    const fromTiers = new Set<Tier>(fromFiles.map((f) => f.tier));
    const toTiers = new Set<Tier>(toFiles.map((f) => f.tier));

    // Infer a tier from a directory-named pattern only when the pattern matches no file:
    // otherwise the glob is classified by the declared groups (`api/**` may be a real tier's
    // directory), and inferring a same-named tier would name a tier that has no node.
    const inferredFrom = fromFiles.length === 0 ? inferTierFromPattern(rule.from) : null;
    if (inferredFrom) {
      fromTiers.add(inferredFrom);
    }
    const inferredTo = toFiles.length === 0 ? inferTierFromPattern(rule.to) : null;
    if (inferredTo) {
      toTiers.add(inferredTo);
    }

    if (rule.allow === 'never') {
      for (const edge of graphEdges) {
        if (edge.kind === 'call') continue;
        const sourceTier = tierOfFile.get(edge.source);
        const targetTier = tierOfFile.get(edge.target);
        if (!sourceTier || !targetTier) continue;
        if (fileMatches(edge.source, sourceTier, rule.from) && fileMatches(edge.target, targetTier, rule.to)) {
          const tierEdge = tierFlow.edges.find((e) => e.source === sourceTier && e.target === targetTier);
          if (tierEdge) {
            tierEdge.violation = true;
            tierEdge.ruleId = rule.id;
          }
          if (grid) {
            const sourceUnit = assignment.get(edge.source) ?? '.';
            const targetUnit = assignment.get(edge.target) ?? '.';
            for (const gridEdge of grid.edges) {
              if (
                gridEdge.sourceTier === sourceTier &&
                gridEdge.targetTier === targetTier &&
                gridEdge.sourceUnit === sourceUnit &&
                gridEdge.targetUnit === targetUnit
              ) {
                gridEdge.violation = true;
                gridEdge.ruleId = rule.id;
              }
            }
          }
          violations.push({
            source: sourceTier,
            target: targetTier,
            ruleId: rule.id,
            kind: 'rule',
            detail: `${edge.source} → ${edge.target} violates ${rule.id}: ${rule.from} may not reach ${rule.to}`,
          });
        }
      }
    } else if (rule.allow === 'import' && rule.quiet !== true) {
      // Which imports a rule excuses is decided import by import below; here a rule only draws
      // the intended flow it states when the repository records none of it.
      for (const sourceTier of fromTiers) {
        for (const targetTier of toTiers) {
          // A flow inside one tier is not a layer relationship, and the stack draws none.
          if (sourceTier === targetTier) {
            continue;
          }
          const observedEdge = tierFlow.edges.find(
            (e) => e.source === sourceTier && e.target === targetTier,
          );
          if (!observedEdge) {
            const sourceRank = tierRank(sourceTier);
            const targetRank = tierRank(targetTier);
            const kind: TierFlowEdge['kind'] =
              sourceRank !== null && targetRank !== null && sourceRank < targetRank
                ? 'upward'
                : 'down';
            if (
              !ghostEdges.some(
                (ge) => ge.source === sourceTier && ge.target === targetTier && ge.ruleId === rule.id,
              )
            ) {
              ghostEdges.push({
                source: sourceTier,
                target: targetTier,
                ruleId: rule.id,
                kind,
                description: `${rule.from} → ${rule.to} (${rule.id})`,
              });
            }
          }
        }
      }

      // An inferred tier on either side has no files, so the stack must draw a ghost band for
      // it; a ghost edge to a tier with no node would otherwise fail to render.
      for (const inferred of [inferredFrom, inferredTo]) {
        if (inferred && !presentTiers.has(inferred) && !ghostBands.some((gb) => gb.tier === inferred)) {
          ghostBands.push({
            tier: inferred,
            label: inferred.charAt(0).toUpperCase() + inferred.slice(1),
            ruleId: rule.id,
          });
        }
      }
    }
  }

  markAllowedImports(rules, tierOfFile, tierFlow, graphEdges, assignment, grid, fileMatches);

  return {
    available: true,
    rules,
    ghostEdges,
    ghostBands,
    violations,
  };
}


interface AllowTally {
  total: number;
  allowed: number;
  allowedTypeOnly: number;
  byRule: Map<string, number>;
}

/**
 * Judge every ranked cross-tier import against the `allow: import` rules, one import at a time.
 *
 * A rule covers an import only when the importing file matches its `from` and the imported file
 * its `to`. An edge is `intended` when every import on it is covered; one that is only partly
 * covered keeps the count (`allowedCount`), so the drawing can say "31 allowed, 9 unexplained"
 * instead of excusing a whole tier pair because one rule matched part of it. Each import in the
 * shown sample carries `allowed`, and the sample lists unexplained imports first, so the ones
 * worth reading are never cut off by the cap.
 */
function markAllowedImports(
  rules: DeclaredRule[],
  tierOfFile: Map<string, Tier>,
  tierFlow: TierFlow,
  graphEdges: Array<{
    source: string;
    target: string;
    kind?: string;
    typeOnly?: boolean;
    evidence?: { line?: number; specifier?: string };
  }>,
  assignment: Map<string, string>,
  grid: TierGrid | undefined,
  fileMatches: (file: string, tier: Tier, pattern: string) => boolean,
): void {
  const allowRules = rules.filter((rule) => rule.allow === 'import');
  if (allowRules.length === 0) {
    return;
  }
  const flowTally = new Map<string, AllowTally>();
  const gridTally = new Map<string, AllowTally>();
  const flowImports = new Map<string, TierFlowImport[]>();
  const tally = (map: Map<string, AllowTally>, key: string, ruleId: string | null, typeOnly: boolean): void => {
    const entry = map.get(key) ?? { total: 0, allowed: 0, allowedTypeOnly: 0, byRule: new Map() };
    entry.total += 1;
    if (ruleId !== null) {
      entry.allowed += 1;
      if (typeOnly) {
        entry.allowedTypeOnly += 1;
      }
      entry.byRule.set(ruleId, (entry.byRule.get(ruleId) ?? 0) + 1);
    }
    map.set(key, entry);
  };

  for (const edge of graphEdges) {
    if (edge.kind === 'call') {
      continue;
    }
    const sourceTier = tierOfFile.get(edge.source);
    const targetTier = tierOfFile.get(edge.target);
    if (!sourceTier || !targetTier) {
      continue;
    }
    const sourceRank = tierRank(sourceTier);
    const targetRank = tierRank(targetTier);
    if (sourceRank === null || targetRank === null || sourceRank === targetRank) {
      continue;
    }
    const rule = allowRules.find(
      (candidate) =>
        fileMatches(edge.source, sourceTier, candidate.from) && fileMatches(edge.target, targetTier, candidate.to),
    );
    const ruleId = rule?.id ?? null;
    const typeOnly = edge.typeOnly === true;
    const flowKey = `${sourceTier} ${targetTier}`;
    tally(flowTally, flowKey, ruleId, typeOnly);
    const list = flowImports.get(flowKey) ?? [];
    list.push({
      source: edge.source,
      target: edge.target,
      line: edge.evidence?.line ?? 0,
      specifier: edge.evidence?.specifier ?? '',
      ...(typeOnly ? { typeOnly: true } : {}),
      ...(ruleId !== null ? { allowed: true } : {}),
    });
    flowImports.set(flowKey, list);
    const sourceUnit = assignment.get(edge.source) ?? '.';
    const targetUnit = assignment.get(edge.target) ?? '.';
    tally(gridTally, `${sourceUnit} ${targetUnit} ${sourceTier} ${targetTier}`, ruleId, typeOnly);
  }

  const apply = (
    target: TierFlowEdge | TierGridEdge,
    entry: AllowTally | undefined,
  ): void => {
    if (!entry || entry.allowed === 0) {
      return;
    }
    target.allowedCount = entry.allowed;
    target.allowedTypeOnly = entry.allowedTypeOnly;
    const ranked = [...entry.byRule.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    target.allowedRules = ranked.map(([id]) => id);
    if (ranked.length === 1) {
      target.ruleId = ranked[0]![0];
    }
    if (entry.allowed === entry.total) {
      target.intended = true;
    }
  };

  for (const edge of tierFlow.edges) {
    const key = `${edge.source} ${edge.target}`;
    apply(edge, flowTally.get(key));
    const all = flowImports.get(key);
    if (all && edge.imports) {
      const order = (a: TierFlowImport, b: TierFlowImport): number =>
        a.source.localeCompare(b.source) || a.line - b.line || a.target.localeCompare(b.target);
      // Unexplained imports first, so the sample cap never hides the ones a reader must judge.
      const unexplained = all.filter((entry) => entry.allowed !== true).sort(order);
      const covered = all.filter((entry) => entry.allowed === true).sort(order);
      edge.imports = [...unexplained, ...covered].slice(0, edge.imports.length).sort(order);
    }
  }
  if (grid) {
    for (const edge of grid.edges) {
      apply(edge, gridTally.get(`${edge.sourceUnit} ${edge.targetUnit} ${edge.sourceTier} ${edge.targetTier}`));
      if (edge.imports) {
        const allowedKeys = new Set(
          (flowImports.get(`${edge.sourceTier} ${edge.targetTier}`) ?? [])
            .filter((entry) => entry.allowed === true)
            .map((entry) => `${entry.source} ${entry.line} ${entry.target}`),
        );
        edge.imports = edge.imports.map((entry) =>
          allowedKeys.has(`${entry.source} ${entry.line} ${entry.target}`) ? { ...entry, allowed: true } : entry,
        );
      }
    }
  }
}
