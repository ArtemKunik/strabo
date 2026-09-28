import { matchesGlob } from '../glob.ts';
import { readDeclaredRules, type DeclaredRule } from '../rules.ts';
import type { Tier, TierClassification, TierFlow, TierFlowEdge, TierGrid } from './types.ts';
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

    const inferredFrom = inferTierFromPattern(rule.from);
    if (inferredFrom) {
      fromTiers.add(inferredFrom);
    }
    const inferredTo = inferTierFromPattern(rule.to);
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
    } else if (rule.allow === 'import') {
      for (const sourceTier of fromTiers) {
        for (const targetTier of toTiers) {
          const observedEdge = tierFlow.edges.find(
            (e) => e.source === sourceTier && e.target === targetTier,
          );
          if (observedEdge) {
            observedEdge.intended = true;
            observedEdge.ruleId = rule.id;
            if (grid) {
              for (const gridEdge of grid.edges) {
                if (gridEdge.sourceTier === sourceTier && gridEdge.targetTier === targetTier) {
                  gridEdge.intended = true;
                  gridEdge.ruleId = rule.id;
                }
              }
            }
          } else {
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

      if (inferredTo && !presentTiers.has(inferredTo) && !ghostBands.some((gb) => gb.tier === inferredTo)) {
        ghostBands.push({
          tier: inferredTo,
          label: inferredTo.charAt(0).toUpperCase() + inferredTo.slice(1),
          ruleId: rule.id,
        });
      }
    }
  }

  return {
    available: true,
    rules,
    ghostEdges,
    ghostBands,
    violations,
  };
}
